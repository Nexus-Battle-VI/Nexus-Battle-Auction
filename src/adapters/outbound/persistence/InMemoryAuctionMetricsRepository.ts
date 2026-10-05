import {
  type AuctionMetricsRepositoryPort,
  type ClosingTimeAggregate,
  type CloseReason,
  type MetricsPeriod,
  type ProductAuctionedCount,
  type ProductRankingsAggregate,
  type ProductSoldCount,
  type TrendGranularity,
  type TrendPoint,
  type VolumeAndSuccessAggregate,
} from '../../../application/ports/AuctionMetricsRepositoryPort'
import { bucketStartOf } from '../../../application/services/auction-metrics-period'

/**
 * Hecho minimo de una subasta para calcular metricas. Replica solo las
 * columnas que el adaptador PostgreSQL consulta, con la misma semantica:
 * `SOLD` no tiene `finishedAt` y su cierre es `buyNowCompletedAt`.
 */
export interface MetricsAuctionFact {
  readonly id: string
  /** Producto de Catalog; por defecto el `id` de la subasta. */
  readonly productId?: string
  readonly priceKind: 'CREDITS' | 'REAL_MONEY'
  readonly status: 'ACTIVE' | 'FINISHED' | 'SOLD' | 'CANCELLED'
  readonly publishedAt: Date
  readonly closesAt: Date
  readonly finishedAt?: Date
  readonly closingResultType?: 'WITH_WINNER' | 'WITHOUT_BIDS'
  readonly cancelledAt?: Date
  readonly officialMark?: 'OFFICIAL' | 'PREMIUM'
  readonly buyNowCompletedAt?: Date
  readonly settlementStatus?: string
  readonly claim?: { readonly status: 'PENDING' | 'CLAIMED' | 'EXPIRED'; readonly settledAt: Date }
}

interface ClosedRow {
  readonly productId: string
  readonly reason: CloseReason
  readonly closedAt: Date
  readonly publishedAt: Date
  readonly closesAt: Date
  readonly failedTerminal: boolean
}

/** `percentile_cont` de PostgreSQL: interpolacion lineal sobre los valores ordenados. */
const percentileCont = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = fraction * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const low = sorted[lower] ?? 0
  const high = sorted[upper] ?? 0
  return low + (high - low) * (rank - lower)
}

const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

const within = (instant: Date | undefined, period: MetricsPeriod): instant is Date =>
  instant !== undefined &&
  instant.getTime() >= period.from.getTime() &&
  instant.getTime() < period.to.getTime()

const seconds = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 1000

/**
 * Adaptador en memoria de las metricas (HU-91.2), para pruebas y desarrollo.
 * Se siembra con hechos; una subasta repetida (mismo `id`) reemplaza a la
 * anterior, igual que la clave primaria en PostgreSQL: un reintento idempotente
 * no duplica la cifra.
 */
export class InMemoryAuctionMetricsRepository implements AuctionMetricsRepositoryPort {
  private readonly facts = new Map<string, MetricsAuctionFact>()

  seed(...facts: readonly MetricsAuctionFact[]): void {
    for (const fact of facts) this.facts.set(fact.id, fact)
  }

  private closedRows(period: MetricsPeriod): ClosedRow[] {
    const rows: ClosedRow[] = []
    for (const fact of this.facts.values()) {
      if (fact.priceKind !== 'CREDITS') continue
      if (fact.status === 'FINISHED' && within(fact.finishedAt, period)) {
        rows.push({
          productId: fact.productId ?? fact.id,
          reason:
            fact.closingResultType === 'WITH_WINNER'
              ? 'EXPIRED_WITH_WINNER'
              : 'EXPIRED_WITHOUT_BIDS',
          closedAt: fact.finishedAt,
          publishedAt: fact.publishedAt,
          closesAt: fact.closesAt,
          failedTerminal: fact.settlementStatus === 'FAILED_TERMINAL',
        })
      } else if (fact.status === 'SOLD' && within(fact.buyNowCompletedAt, period)) {
        rows.push({
          productId: fact.productId ?? fact.id,
          reason: 'BUY_NOW',
          closedAt: fact.buyNowCompletedAt,
          publishedAt: fact.publishedAt,
          closesAt: fact.closesAt,
          failedTerminal: false,
        })
      }
    }
    return rows
  }

  getVolumeAndSuccess(period: MetricsPeriod, asOf: Date): Promise<VolumeAndSuccessAggregate> {
    const all = [...this.facts.values()]
    const player = all.filter((fact) => fact.priceKind === 'CREDITS')
    const official = all.filter((fact) => fact.priceKind === 'REAL_MONEY')
    const closed = this.closedRows(period)
    const claims = player.flatMap((fact) =>
      fact.claim !== undefined && within(fact.claim.settledAt, period) ? [fact.claim] : [],
    )
    const countReason = (reason: CloseReason): number =>
      closed.filter((row) => row.reason === reason).length
    const open = player.filter((fact) => fact.status === 'ACTIVE')
    const officialPublished = official.filter((fact) => within(fact.publishedAt, period))

    return Promise.resolve({
      player: {
        published: player.filter((fact) => within(fact.publishedAt, period)).length,
        closedWithWinner: countReason('EXPIRED_WITH_WINNER'),
        soldByBuyNow: countReason('BUY_NOW'),
        closedWithoutBids: countReason('EXPIRED_WITHOUT_BIDS'),
        settlementFailedTerminal: closed.filter((row) => row.failedTerminal).length,
        cancelled: player.filter(
          (fact) => fact.status === 'CANCELLED' && within(fact.cancelledAt, period),
        ).length,
        active: open.filter((fact) => fact.closesAt.getTime() > asOf.getTime()).length,
        awaitingClosure: open.filter((fact) => fact.closesAt.getTime() <= asOf.getTime()).length,
        claims: {
          createdInPeriod: claims.length,
          pending: claims.filter((claim) => claim.status === 'PENDING').length,
          claimed: claims.filter((claim) => claim.status === 'CLAIMED').length,
          expired: claims.filter((claim) => claim.status === 'EXPIRED').length,
        },
      },
      official: {
        published: officialPublished.length,
        byMark: {
          OFFICIAL: officialPublished.filter((fact) => fact.officialMark === 'OFFICIAL').length,
          PREMIUM: officialPublished.filter((fact) => fact.officialMark === 'PREMIUM').length,
        },
      },
    })
  }

  getProductRankings(period: MetricsPeriod, limit: number): Promise<ProductRankingsAggregate> {
    const auctioned = new Map<string, { total: number; player: number; official: number }>()
    for (const fact of this.facts.values()) {
      if (!within(fact.publishedAt, period)) continue
      const productId = fact.productId ?? fact.id
      const entry = auctioned.get(productId) ?? { total: 0, player: 0, official: 0 }
      entry.total += 1
      if (fact.priceKind === 'CREDITS') entry.player += 1
      else entry.official += 1
      auctioned.set(productId, entry)
    }

    const sold = new Map<string, { total: number; byClose: number; byBuyNow: number }>()
    for (const row of this.closedRows(period)) {
      if (row.reason === 'EXPIRED_WITHOUT_BIDS') continue
      const entry = sold.get(row.productId) ?? { total: 0, byClose: 0, byBuyNow: 0 }
      entry.total += 1
      if (row.reason === 'BUY_NOW') entry.byBuyNow += 1
      else entry.byClose += 1
      sold.set(row.productId, entry)
    }

    const byTotalThenProduct = <T extends { readonly total: number; readonly productId: string }>(
      left: T,
      right: T,
    ): number =>
      right.total - left.total ||
      (left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0)

    const mostAuctioned: ProductAuctionedCount[] = [...auctioned.entries()]
      .map(([productId, entry]) => ({
        productId,
        total: entry.total,
        playerCredits: entry.player,
        officialRealMoney: entry.official,
      }))
      .sort(byTotalThenProduct)
      .slice(0, limit)
    const mostSold: ProductSoldCount[] = [...sold.entries()]
      .map(([productId, entry]) => ({
        productId,
        total: entry.total,
        byAuctionClose: entry.byClose,
        byBuyNow: entry.byBuyNow,
      }))
      .sort(byTotalThenProduct)
      .slice(0, limit)

    return Promise.resolve({ mostAuctioned, mostSold })
  }

  getClosingTime(period: MetricsPeriod): Promise<ClosingTimeAggregate> {
    const closed = this.closedRows(period)
    const durations = closed.map((row) => seconds(row.publishedAt, row.closedAt))
    const reasonStats = (reason: CloseReason): { sampleSize: number; average: number | null } => {
      const values = closed
        .filter((row) => row.reason === reason)
        .map((row) => seconds(row.publishedAt, row.closedAt))
      return { sampleSize: values.length, average: average(values) }
    }
    const lags = closed
      .filter((row) => row.reason !== 'BUY_NOW')
      .map((row) => seconds(row.closesAt, row.closedAt))

    return Promise.resolve({
      overall: {
        sampleSize: durations.length,
        average: average(durations),
        median: percentileCont(durations, 0.5),
        p90: percentileCont(durations, 0.9),
      },
      byCloseReason: {
        EXPIRED_WITH_WINNER: reasonStats('EXPIRED_WITH_WINNER'),
        EXPIRED_WITHOUT_BIDS: reasonStats('EXPIRED_WITHOUT_BIDS'),
        BUY_NOW: reasonStats('BUY_NOW'),
      },
      settlementLag: {
        sampleSize: lags.length,
        average: average(lags),
        p90: percentileCont(lags, 0.9),
      },
    })
  }

  getTrendPoints(
    period: MetricsPeriod,
    granularity: TrendGranularity,
  ): Promise<readonly TrendPoint[]> {
    type Mutable = { -readonly [K in keyof TrendPoint]: TrendPoint[K] }
    const points = new Map<number, Mutable>()
    const pointOf = (instant: Date): Mutable => {
      const start = bucketStartOf(instant, granularity)
      let point = points.get(start.getTime())
      if (point === undefined) {
        point = {
          bucketStart: start,
          published: 0,
          closedWithWinner: 0,
          soldByBuyNow: 0,
          closedWithoutBids: 0,
          cancelled: 0,
          averageClosingSeconds: null,
          officialPublished: 0,
        }
        points.set(start.getTime(), point)
      }
      return point
    }

    for (const fact of this.facts.values()) {
      if (!within(fact.publishedAt, period)) continue
      if (fact.priceKind === 'CREDITS') pointOf(fact.publishedAt).published += 1
      else pointOf(fact.publishedAt).officialPublished += 1
    }
    for (const fact of this.facts.values()) {
      if (
        fact.priceKind === 'CREDITS' &&
        fact.status === 'CANCELLED' &&
        within(fact.cancelledAt, period)
      ) {
        pointOf(fact.cancelledAt).cancelled += 1
      }
    }

    const sums = new Map<number, { seconds: number; count: number }>()
    for (const row of this.closedRows(period)) {
      const point = pointOf(row.closedAt)
      if (row.reason === 'EXPIRED_WITH_WINNER') point.closedWithWinner += 1
      else if (row.reason === 'EXPIRED_WITHOUT_BIDS') point.closedWithoutBids += 1
      else point.soldByBuyNow += 1
      const key = point.bucketStart.getTime()
      const acc = sums.get(key) ?? { seconds: 0, count: 0 }
      sums.set(key, {
        seconds: acc.seconds + seconds(row.publishedAt, row.closedAt),
        count: acc.count + 1,
      })
    }
    for (const [key, acc] of sums) {
      const point = points.get(key)
      if (point !== undefined) point.averageClosingSeconds = acc.seconds / acc.count
    }

    return Promise.resolve(
      [...points.values()].sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime()),
    )
  }
}
