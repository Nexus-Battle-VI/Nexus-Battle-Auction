import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely'

import {
  CLOSE_REASONS,
  type AuctionMetricsRepositoryPort,
  type ClosingTimeAggregate,
  type CloseReason,
  type MetricsPeriod,
  type ProductRankingsAggregate,
  type TrendGranularity,
  type TrendPoint,
  type VolumeAndSuccessAggregate,
} from '../../../application/ports/AuctionMetricsRepositoryPort'
import type { Database } from './schema'

type Tx = Transaction<Database>

const isCloseReason = (value: string): value is CloseReason =>
  (CLOSE_REASONS as readonly string[]).includes(value)

/**
 * Cohorte de subastas de jugador CERRADAS por el mercado en el periodo
 * (contrato `hu-91.v1` §3.1). Son dos `SELECT` unidos, no un `CASE` sobre el
 * instante de cierre, para que cada rama use su propio indice:
 *
 * - `FINISHED`: cierre efectivo = `finished_at`.
 * - `SOLD` (compra inmediata): `finished_at` queda `NULL` y `closes_at` se
 *   sobrescribe, asi que el cierre es `auction_buy_now_operations.completed_at`
 *   (UNIQUE por subasta: el `JOIN` es 1:1 y no multiplica filas).
 */
const closedCohort = (period: MetricsPeriod): RawBuilder<unknown> => sql`
  select a.id as auction_id, a.product_id, a.published_at, a.closes_at, a.finished_at as closed_at,
         case a.closing_result_type
           when 'WITH_WINNER' then 'EXPIRED_WITH_WINNER'
           else 'EXPIRED_WITHOUT_BIDS'
         end as reason
  from auctions a
  where a.price_kind = 'CREDITS' and a.status = 'FINISHED'
    and a.finished_at >= ${period.from} and a.finished_at < ${period.to}
  union all
  select a.id, a.product_id, a.published_at, a.closes_at, n.completed_at, 'BUY_NOW'
  from auction_buy_now_operations n
  join auctions a on a.id = n.auction_id
  where a.price_kind = 'CREDITS' and a.status = 'SOLD'
    and n.completed_at >= ${period.from} and n.completed_at < ${period.to}
`

const emptyReasonCounts = (): Record<CloseReason, number> => ({
  EXPIRED_WITH_WINNER: 0,
  EXPIRED_WITHOUT_BIDS: 0,
  BUY_NOW: 0,
})

/** `bucket` en segundos epoch UTC: evita que el driver interprete un `timestamp` sin zona como local. */
const bucketEpoch = (column: string, granularity: TrendGranularity): RawBuilder<number> =>
  sql<number>`extract(epoch from date_trunc(${sql.lit(granularity.toLowerCase())}, ${sql.ref(column)} at time zone 'UTC'))::float8`

/**
 * Adaptador de lectura de las metricas de Subasta (HU-91.2).
 *
 * Todas las consultas de un metodo corren en UNA transaccion `READ ONLY` con
 * aislamiento `REPEATABLE READ`: las cifras de una misma respuesta salen de la
 * misma instantanea y la consulta jamas puede escribir (contrato §3: «las
 * metricas historicas no cambian por efectos secundarios de una consulta»).
 */
export class PostgresAuctionMetricsRepository implements AuctionMetricsRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  private readSnapshot<T>(run: (trx: Tx) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setAccessMode('read only')
      .setIsolationLevel('repeatable read')
      .execute(run)
  }

  getVolumeAndSuccess(period: MetricsPeriod, asOf: Date): Promise<VolumeAndSuccessAggregate> {
    return this.readSnapshot(async (trx) => {
      const published = await sql<{ total: number }>`
        select count(*)::int as total from auctions
        where price_kind = 'CREDITS'
          and published_at >= ${period.from} and published_at < ${period.to}
      `.execute(trx)

      const closed = await sql<{ reason: string; total: number; failed: number }>`
        with closed as (${closedCohort(period)})
        select c.reason, count(*)::int as total,
               (count(*) filter (where s.status = 'FAILED_TERMINAL'))::int as failed
        from closed c
        left join auction_settlements s on s.auction_id = c.auction_id
        group by c.reason
      `.execute(trx)

      const cancelled = await sql<{ total: number }>`
        select count(*)::int as total from auctions
        where price_kind = 'CREDITS' and status = 'CANCELLED'
          and cancelled_at >= ${period.from} and cancelled_at < ${period.to}
      `.execute(trx)

      const open = await sql<{ active: number; awaiting: number }>`
        select (count(*) filter (where closes_at > ${asOf}))::int as active,
               (count(*) filter (where closes_at <= ${asOf}))::int as awaiting
        from auctions
        where price_kind = 'CREDITS' and status = 'ACTIVE'
      `.execute(trx)

      const claims = await sql<{ claim_status: string; total: number }>`
        select claim_status, count(*)::int as total from auction_pending_claims
        where settled_at >= ${period.from} and settled_at < ${period.to}
        group by claim_status
      `.execute(trx)

      const official = await sql<{ official_mark: string; total: number }>`
        select official_mark, count(*)::int as total from auctions
        where price_kind = 'REAL_MONEY'
          and published_at >= ${period.from} and published_at < ${period.to}
        group by official_mark
      `.execute(trx)

      const byReason = emptyReasonCounts()
      let settlementFailedTerminal = 0
      for (const row of closed.rows) {
        if (isCloseReason(row.reason)) byReason[row.reason] = row.total
        settlementFailedTerminal += row.failed
      }
      const claimCount = (status: string): number =>
        claims.rows.find((row) => row.claim_status === status)?.total ?? 0
      const markCount = (mark: string): number =>
        official.rows.find((row) => row.official_mark === mark)?.total ?? 0

      return {
        player: {
          published: published.rows[0]?.total ?? 0,
          closedWithWinner: byReason.EXPIRED_WITH_WINNER,
          soldByBuyNow: byReason.BUY_NOW,
          closedWithoutBids: byReason.EXPIRED_WITHOUT_BIDS,
          settlementFailedTerminal,
          cancelled: cancelled.rows[0]?.total ?? 0,
          active: open.rows[0]?.active ?? 0,
          awaitingClosure: open.rows[0]?.awaiting ?? 0,
          claims: {
            createdInPeriod: claims.rows.reduce((sum, row) => sum + row.total, 0),
            pending: claimCount('PENDING'),
            claimed: claimCount('CLAIMED'),
            expired: claimCount('EXPIRED'),
          },
        },
        official: {
          published: official.rows.reduce((sum, row) => sum + row.total, 0),
          byMark: { OFFICIAL: markCount('OFFICIAL'), PREMIUM: markCount('PREMIUM') },
        },
      }
    })
  }

  /**
   * Rankings por `product_id` (contrato §3.4). Se agrega SOLO sobre `auctions` (y,
   * 1:1 por `UNIQUE(auction_id)`, `auction_buy_now_operations` para las ventas):
   * sin `JOIN` contra `auction_bids`, que multiplicaria cada subasta por su numero
   * de pujas. Una fila de `auctions` es una publicacion, de modo que republicar el
   * mismo producto suma una publicacion mas y un reintento idempotente ninguna.
   * Orden determinista: `total DESC, product_id ASC` con collation `C` (orden por
   * bytes, igual que el adaptador en memoria; la collation de la base no interviene).
   */
  getProductRankings(period: MetricsPeriod, limit: number): Promise<ProductRankingsAggregate> {
    return this.readSnapshot(async (trx) => {
      // «Mas subastados»: toda publicacion del periodo, tambien las canceladas
      // (se publicaron). Jugador y oficial por separado.
      const auctioned = await sql<{
        product_id: string
        total: number
        player: number
        official: number
      }>`
        select product_id,
               count(*)::int as total,
               (count(*) filter (where price_kind = 'CREDITS'))::int as player,
               (count(*) filter (where price_kind = 'REAL_MONEY'))::int as official
        from auctions
        where published_at >= ${period.from} and published_at < ${period.to}
        group by product_id
        order by total desc, product_id collate "C" asc
        limit ${limit}
      `.execute(trx)

      // «Mas vendidos»: solo jugador (creditos) con venta cerrada en el periodo.
      const sold = await sql<{
        product_id: string
        total: number
        by_close: number
        by_buy_now: number
      }>`
        with closed as (${closedCohort(period)})
        select product_id,
               count(*)::int as total,
               (count(*) filter (where reason = 'EXPIRED_WITH_WINNER'))::int as by_close,
               (count(*) filter (where reason = 'BUY_NOW'))::int as by_buy_now
        from closed
        where reason in ('EXPIRED_WITH_WINNER', 'BUY_NOW')
        group by product_id
        order by total desc, product_id collate "C" asc
        limit ${limit}
      `.execute(trx)

      return {
        mostAuctioned: auctioned.rows.map((row) => ({
          productId: row.product_id,
          total: row.total,
          playerCredits: row.player,
          officialRealMoney: row.official,
        })),
        mostSold: sold.rows.map((row) => ({
          productId: row.product_id,
          total: row.total,
          byAuctionClose: row.by_close,
          byBuyNow: row.by_buy_now,
        })),
      }
    })
  }

  getClosingTime(period: MetricsPeriod): Promise<ClosingTimeAggregate> {
    return this.readSnapshot(async (trx) => {
      const durations = sql`
        select reason,
               extract(epoch from (closed_at - published_at))::float8 as seconds
        from (${closedCohort(period)}) as closed
      `

      const overall = await sql<{
        total: number
        average: number | null
        median: number | null
        p90: number | null
      }>`
        with d as (${durations})
        select count(*)::int as total,
               avg(seconds)::float8 as average,
               (percentile_cont(0.5) within group (order by seconds))::float8 as median,
               (percentile_cont(0.9) within group (order by seconds))::float8 as p90
        from d
      `.execute(trx)

      const reasons = await sql<{ reason: string; total: number; average: number | null }>`
        with d as (${durations})
        select reason, count(*)::int as total, avg(seconds)::float8 as average
        from d group by reason
      `.execute(trx)

      const lag = await sql<{ total: number; average: number | null; p90: number | null }>`
        with l as (
          select extract(epoch from (finished_at - closes_at))::float8 as seconds
          from auctions
          where price_kind = 'CREDITS' and status = 'FINISHED'
            and finished_at >= ${period.from} and finished_at < ${period.to}
        )
        select count(*)::int as total,
               avg(seconds)::float8 as average,
               (percentile_cont(0.9) within group (order by seconds))::float8 as p90
        from l
      `.execute(trx)

      const total = overall.rows[0]
      const lagRow = lag.rows[0]
      const reasonStats = (reason: CloseReason): { sampleSize: number; average: number | null } => {
        const row = reasons.rows.find((candidate) => candidate.reason === reason)
        return { sampleSize: row?.total ?? 0, average: row?.average ?? null }
      }

      return {
        overall: {
          sampleSize: total?.total ?? 0,
          average: total?.average ?? null,
          median: total?.median ?? null,
          p90: total?.p90 ?? null,
        },
        byCloseReason: {
          EXPIRED_WITH_WINNER: reasonStats('EXPIRED_WITH_WINNER'),
          EXPIRED_WITHOUT_BIDS: reasonStats('EXPIRED_WITHOUT_BIDS'),
          BUY_NOW: reasonStats('BUY_NOW'),
        },
        settlementLag: {
          sampleSize: lagRow?.total ?? 0,
          average: lagRow?.average ?? null,
          p90: lagRow?.p90 ?? null,
        },
      }
    })
  }

  getTrendPoints(
    period: MetricsPeriod,
    granularity: TrendGranularity,
  ): Promise<readonly TrendPoint[]> {
    return this.readSnapshot(async (trx) => {
      const points = new Map<number, { -readonly [K in keyof TrendPoint]: TrendPoint[K] }>()
      const pointAt = (
        epochSeconds: number,
      ): { -readonly [K in keyof TrendPoint]: TrendPoint[K] } => {
        const key = Math.round(epochSeconds * 1000)
        let point = points.get(key)
        if (point === undefined) {
          point = {
            bucketStart: new Date(key),
            published: 0,
            closedWithWinner: 0,
            soldByBuyNow: 0,
            closedWithoutBids: 0,
            cancelled: 0,
            averageClosingSeconds: null,
            officialPublished: 0,
          }
          points.set(key, point)
        }
        return point
      }

      const published = await sql<{ bucket: number; total: number }>`
        select ${bucketEpoch('published_at', granularity)} as bucket, count(*)::int as total
        from auctions
        where price_kind = 'CREDITS'
          and published_at >= ${period.from} and published_at < ${period.to}
        group by 1
      `.execute(trx)
      for (const row of published.rows) pointAt(row.bucket).published = row.total

      const official = await sql<{ bucket: number; total: number }>`
        select ${bucketEpoch('published_at', granularity)} as bucket, count(*)::int as total
        from auctions
        where price_kind = 'REAL_MONEY'
          and published_at >= ${period.from} and published_at < ${period.to}
        group by 1
      `.execute(trx)
      for (const row of official.rows) pointAt(row.bucket).officialPublished = row.total

      const cancelled = await sql<{ bucket: number; total: number }>`
        select ${bucketEpoch('cancelled_at', granularity)} as bucket, count(*)::int as total
        from auctions
        where price_kind = 'CREDITS' and status = 'CANCELLED'
          and cancelled_at >= ${period.from} and cancelled_at < ${period.to}
        group by 1
      `.execute(trx)
      for (const row of cancelled.rows) pointAt(row.bucket).cancelled = row.total

      const closed = await sql<{
        bucket: number
        reason: string
        total: number
        seconds_sum: number
      }>`
        select ${bucketEpoch('closed_at', granularity)} as bucket, reason,
               count(*)::int as total,
               (sum(extract(epoch from (closed_at - published_at))))::float8 as seconds_sum
        from (${closedCohort(period)}) as closed
        group by 1, 2
      `.execute(trx)

      // Promedio ponderado por bucket: suma de segundos / cierres, no promedio de promedios.
      const sums = new Map<number, { seconds: number; count: number }>()
      for (const row of closed.rows) {
        const point = pointAt(row.bucket)
        if (row.reason === 'EXPIRED_WITH_WINNER') point.closedWithWinner = row.total
        else if (row.reason === 'EXPIRED_WITHOUT_BIDS') point.closedWithoutBids = row.total
        else if (row.reason === 'BUY_NOW') point.soldByBuyNow = row.total
        const key = point.bucketStart.getTime()
        const acc = sums.get(key) ?? { seconds: 0, count: 0 }
        sums.set(key, { seconds: acc.seconds + row.seconds_sum, count: acc.count + row.total })
      }
      for (const [key, acc] of sums) {
        const point = points.get(key)
        if (point !== undefined && acc.count > 0)
          point.averageClosingSeconds = acc.seconds / acc.count
      }

      return [...points.values()].sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
    })
  }
}
