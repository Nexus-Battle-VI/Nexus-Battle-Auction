import {
  COUNT_BIDS_ON_CANCELLED_AUCTIONS,
  type ActiveUserEntry,
  type AuctionMetricsAdapterOptions,
  type AuctionMetricsRepositoryPort,
  type AveragePricesAggregate,
  type ClosingTimeAggregate,
  type CreditSalesStats,
  type CurrencyListedPrices,
  type CloseReason,
  type MetricsPeriod,
  type ProductAuctionedCount,
  type ProductRankingsAggregate,
  type ProductSoldCount,
  type TrendGranularity,
  type TrendPoint,
  type UsersAndCommissionsAggregate,
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
  /** Precio final del cierre por subasta (`final_amount_credits`). */
  readonly finalAmountCredits?: number
  /** Precio de la compra inmediata (`auction_buy_now_operations.price_credits`). */
  readonly buyNowPriceCredits?: number
  /** `minimum_bid_credits` (subastas de jugador). */
  readonly minimumBidCredits?: number
  /** Subastas oficiales: moneda ISO 4217 y precios en unidad minima. */
  readonly currency?: string
  readonly minimumBidAmountMinor?: number
  readonly buyNowAmountMinor?: number
  readonly settlementStatus?: string
  /** Vendedor (`auctions.seller_id`); sin el, la publicacion no genera actividad de vendedor. */
  readonly sellerId?: string
  /** Pujas persistidas (`auction_bids`); varias del mismo usuario son filas distintas. */
  readonly bids?: readonly { readonly bidderId: string; readonly placedAt: Date }[]
  /** Comprador de la compra inmediata (`auction_buy_now_operations.buyer_id`). */
  readonly buyerId?: string
  /** `duration_hours` y `publication_fee_credits` de una publicacion de jugador. */
  readonly durationHours?: number
  readonly publicationFeeCredits?: number
  /** Fila de `auction_cancellations` (junto con `cancelledAt`). */
  readonly cancellation?: {
    readonly refundAmountCredits: number
    readonly walletRefundStatus:
      'PENDING' | 'CONFIRMED' | 'RETRYABLE' | 'TERMINAL_ERROR' | 'NOT_REQUIRED'
  }
  readonly claim?: { readonly status: 'PENDING' | 'CLAIMED' | 'EXPIRED'; readonly settledAt: Date }
}

interface ClosedRow {
  readonly productId: string
  /** Precio final de venta; `undefined` si el hecho no lo trae (no es promediable). */
  readonly price: number | undefined
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
  private readonly countBidsOnCancelledAuctions: boolean

  constructor(options: AuctionMetricsAdapterOptions = {}) {
    this.countBidsOnCancelledAuctions =
      options.countBidsOnCancelledAuctions ?? COUNT_BIDS_ON_CANCELLED_AUCTIONS
  }

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
          price: fact.finalAmountCredits,
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
          price: fact.buyNowPriceCredits,
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

  getUsersAndCommissions(
    period: MetricsPeriod,
    limit: number,
  ): Promise<UsersAndCommissionsAggregate> {
    interface Activity {
      readonly seller: Set<string>
      readonly bidder: Set<string>
      readonly buyer: Set<string>
    }
    // Una entrada por usuario con las subastas distintas de cada rol: `Set` = DISTINCT.
    const users = new Map<string, Activity>()
    const activityOf = (playerId: string): Activity => {
      let activity = users.get(playerId)
      if (activity === undefined) {
        activity = { seller: new Set(), bidder: new Set(), buyer: new Set() }
        users.set(playerId, activity)
      }
      return activity
    }

    const credits = [...this.facts.values()].filter((fact) => fact.priceKind === 'CREDITS')
    for (const fact of credits) {
      if (fact.sellerId !== undefined && within(fact.publishedAt, period)) {
        activityOf(fact.sellerId).seller.add(fact.id)
      }
      // Regla abierta: pujas en subastas CANCELLED (ver `COUNT_BIDS_ON_CANCELLED_AUCTIONS`).
      const bidsCount = this.countBidsOnCancelledAuctions || fact.status !== 'CANCELLED'
      for (const bid of fact.bids ?? []) {
        if (bidsCount && within(bid.placedAt, period)) activityOf(bid.bidderId).bidder.add(fact.id)
      }
      if (fact.buyerId !== undefined && within(fact.buyNowCompletedAt, period)) {
        activityOf(fact.buyerId).buyer.add(fact.id)
      }
    }

    const entries: ActiveUserEntry[] = [...users.entries()].map(([playerId, activity]) => ({
      playerId,
      activeAuctions: new Set([...activity.seller, ...activity.bidder, ...activity.buyer]).size,
      asSeller: activity.seller.size,
      asBidder: activity.bidder.size,
      asBuyer: activity.buyer.size,
    }))
    const withRole = (role: 'seller' | 'bidder' | 'buyer'): number =>
      [...users.values()].filter((activity) => activity[role].size > 0).length

    // Orden por unidades de codigo, igual que `collate "C"` en PostgreSQL.
    const top = entries
      .sort(
        (left, right) =>
          right.activeAuctions - left.activeAuctions ||
          (left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0),
      )
      .slice(0, limit)

    const fees = new Map<number, { auctions: number; feeCredits: number }>()
    for (const fact of credits) {
      if (
        fact.durationHours === undefined ||
        fact.publicationFeeCredits === undefined ||
        !within(fact.publishedAt, period)
      )
        continue
      const current = fees.get(fact.durationHours) ?? { auctions: 0, feeCredits: 0 }
      fees.set(fact.durationHours, {
        auctions: current.auctions + 1,
        feeCredits: current.feeCredits + fact.publicationFeeCredits,
      })
    }

    const refundOf = (statuses: readonly string[]) => {
      const matching = credits.filter(
        (fact) =>
          fact.cancellation !== undefined &&
          within(fact.cancelledAt, period) &&
          statuses.includes(fact.cancellation.walletRefundStatus),
      )
      return {
        count: matching.length,
        hundredths: matching.reduce(
          (sum, fact) => sum + Math.round((fact.cancellation?.refundAmountCredits ?? 0) * 100),
          0,
        ),
      }
    }

    return Promise.resolve({
      activeUsers: {
        totalActiveUsers: users.size,
        byRole: {
          sellers: withRole('seller'),
          bidders: withRole('bidder'),
          buyers: withRole('buyer'),
        },
        top,
      },
      commissions: {
        byDuration: [...fees.entries()]
          .sort(([left], [right]) => left - right)
          .map(([durationHours, row]) => ({ durationHours, ...row })),
        refunded: refundOf(['CONFIRMED']),
        pending: refundOf(['PENDING', 'RETRYABLE']),
      },
    })
  }

  getAveragePrices(period: MetricsPeriod): Promise<AveragePricesAggregate> {
    const statsOf = (prices: readonly number[]): CreditSalesStats => ({
      count: prices.length,
      sum: prices.reduce((total, price) => total + price, 0),
      min: prices.length === 0 ? null : Math.min(...prices),
      max: prices.length === 0 ? null : Math.max(...prices),
    })
    const salePrices = (reason?: CloseReason): number[] =>
      this.closedRows(period).flatMap((row) =>
        row.reason !== 'EXPIRED_WITHOUT_BIDS' &&
        (reason === undefined || row.reason === reason) &&
        row.price !== undefined
          ? [row.price]
          : [],
      )

    const all = salePrices()
    const published = [...this.facts.values()].filter((fact) => within(fact.publishedAt, period))
    const listed = published.flatMap((fact) =>
      fact.priceKind === 'CREDITS' && fact.minimumBidCredits !== undefined
        ? [fact.minimumBidCredits]
        : [],
    )

    const byCurrency = new Map<string, CurrencyListedPrices>()
    for (const fact of published) {
      if (
        fact.priceKind !== 'REAL_MONEY' ||
        fact.currency === undefined ||
        fact.minimumBidAmountMinor === undefined
      )
        continue
      const bid = fact.minimumBidAmountMinor
      const current = byCurrency.get(fact.currency)
      const hasBuyNow = fact.buyNowAmountMinor !== undefined
      byCurrency.set(fact.currency, {
        currency: fact.currency,
        publishedCount: (current?.publishedCount ?? 0) + 1,
        minimumBid: {
          sum: (current?.minimumBid.sum ?? 0) + bid,
          min: Math.min(current?.minimumBid.min ?? bid, bid),
          max: Math.max(current?.minimumBid.max ?? bid, bid),
        },
        buyNow: {
          count: (current?.buyNow.count ?? 0) + (hasBuyNow ? 1 : 0),
          sum: (current?.buyNow.sum ?? 0) + (fact.buyNowAmountMinor ?? 0),
        },
      })
    }

    return Promise.resolve({
      credits: {
        sales: { ...statsOf(all), median: percentileCont(all, 0.5) },
        byChannel: {
          AUCTION_CLOSE: statsOf(salePrices('EXPIRED_WITH_WINNER')),
          BUY_NOW: statsOf(salePrices('BUY_NOW')),
        },
        listedMinimumBid: {
          count: listed.length,
          sum: listed.reduce((total, price) => total + price, 0),
        },
      },
      // Orden por unidades de codigo, igual que `collate "C"` en PostgreSQL.
      realMoney: [...byCurrency.values()].sort((left, right) =>
        left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0,
      ),
    })
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
