import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import * as metricsIndexes from '../../src/adapters/outbound/persistence/migrations/019-add-auction-metrics-indexes'
import { PostgresAuctionMetricsRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionMetricsRepository'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { AuctionMetricsRepositoryPort } from '../../src/application/ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { GetAuctionProductRankings } from '../../src/application/use-cases/GetAuctionProductRankings'
import { GetAuctionClosingTimeAndTrends } from '../../src/application/use-cases/GetAuctionClosingTimeAndTrends'
import { GetAuctionVolumeAndSuccess } from '../../src/application/use-cases/GetAuctionVolumeAndSuccess'
import { Auction } from '../../src/domain/entities/Auction'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import { OfficialAuction, OfficialAuctionMark } from '../../src/domain/entities/OfficialAuction'
import {
  AuctionPriceKind,
  AuctionPublisherType,
} from '../../src/domain/value-objects/AuctionPublicationPricing'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

const HOUR = 3_600_000
const asOf = new Date('2026-10-04T12:00:00.000Z')
const clock: ClockPort = { now: () => asOf }
const query = { from: '2026-09-28T00:00:00Z', to: '2026-10-04T00:00:00Z' }
const at = (iso: string): Date => new Date(iso)
const plus = (date: Date, ms: number): Date => new Date(date.getTime() + ms)

/**
 * HU-91.2. Metricas de Subasta contra PostgreSQL REAL: cifras absolutas
 * verificadas a mano, PARIDAD con el adaptador en memoria sobre los mismos
 * hechos, e idempotencia (contrato `hu-91.v1` §5) con las operaciones reales
 * del repositorio. La zona horaria de la base se cambia a America/Bogota para
 * probar que el truncado de buckets no depende de la zona de la sesion.
 */
describe('Metricas de Subasta contra PostgreSQL real (HU-91.2)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let auctions: PostgresAuctionRepository
  let metrics: PostgresAuctionMetricsRepository
  const facts: MetricsAuctionFact[] = []

  const volumeOf = (repository: AuctionMetricsRepositoryPort) =>
    new GetAuctionVolumeAndSuccess(repository, clock)
  const trendsOf = (repository: AuctionMetricsRepositoryPort) =>
    new GetAuctionClosingTimeAndTrends(repository, clock)

  const publishPlayer = async (
    id: string,
    publishedAt: Date,
    options: {
      readonly closed?: Partial<MetricsAuctionFact>
      readonly productId?: string
    } = {},
  ): Promise<MetricsAuctionFact> => {
    const auction = Auction.publish({
      auctionId: id,
      sellerId: `seller-${id}`,
      productId: options.productId ?? `product-${id}`,
      durationHours: 24,
      minimumBidCredits: 10,
      buyNowCredits: 50,
      publishedAt,
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })
    await auctions.publish({
      operationId: `publish:${id}`,
      auction,
      inventoryCommitmentId: `commitment:${id}`,
      feeChargeId: `charge:${id}`,
    })
    const fact: MetricsAuctionFact = {
      id,
      productId: options.productId ?? `product-${id}`,
      priceKind: 'CREDITS',
      status: 'ACTIVE',
      publishedAt,
      closesAt: plus(publishedAt, 24 * HOUR),
      ...options.closed,
    }
    facts.push(fact)
    return fact
  }

  const finish = async (
    id: string,
    publishedAt: Date,
    outcome: 'WITH_WINNER' | 'WITHOUT_BIDS',
    lagMs = 30_000,
    productId?: string,
  ): Promise<MetricsAuctionFact> => {
    const base = await publishPlayer(id, publishedAt, productId === undefined ? {} : { productId })
    const finishedAt = plus(base.closesAt, lagMs)
    await auctions.finishAuction({
      auctionId: id,
      finishedAt,
      closingResult:
        outcome === 'WITH_WINNER'
          ? AuctionClosingResult.withWinner({
              finishedAt,
              bidderId: `winner-${id}`,
              bidId: `bid-${id}`,
              amountCredits: 25,
            })
          : AuctionClosingResult.withoutBids(finishedAt),
    })
    const fact: MetricsAuctionFact = {
      ...base,
      status: 'FINISHED',
      finishedAt,
      closingResultType: outcome,
    }
    facts.splice(facts.indexOf(base), 1, fact)
    return fact
  }

  const buyNowCommand = (id: string, closedAt: Date, operationId = `buy-now:${id}`) => ({
    operationId,
    transactionId: `tx:${id}`,
    auctionId: id,
    buyerId: `buyer-${id}`,
    transferId: `transfer:${id}`,
    priceCredits: 50,
    remainingCredits: 100,
    closedAt,
  })

  const sell = async (
    id: string,
    publishedAt: Date,
    afterMs: number,
    productId?: string,
  ): Promise<MetricsAuctionFact> => {
    const base = await publishPlayer(id, publishedAt, productId === undefined ? {} : { productId })
    const closedAt = plus(publishedAt, afterMs)
    await auctions.closeByBuyNow(buyNowCommand(id, closedAt))
    const fact: MetricsAuctionFact = { ...base, status: 'SOLD', buyNowCompletedAt: closedAt }
    facts.splice(facts.indexOf(base), 1, fact)
    return fact
  }

  const cancelCommand = (
    id: string,
    cancelledAt: Date,
    operationId = `cancel:${id}`,
    productId = `product-${id}`,
  ) => ({
    operationId,
    auctionId: id,
    sellerId: `seller-${id}`,
    productId,
    cancelledAt,
    inventoryCommitmentId: `commitment:${id}`,
    feeChargeId: `charge:${id}`,
    refundAmountCredits: 0.5,
    walletRefundOperationId: `wallet-refund:${id}`,
    inventoryReleaseOperationId: `inventory-release:${id}`,
  })

  const cancel = async (
    id: string,
    publishedAt: Date,
    cancelledAt: Date,
    productId?: string,
  ): Promise<MetricsAuctionFact> => {
    const base = await publishPlayer(id, publishedAt, productId === undefined ? {} : { productId })
    await auctions.cancelAuction(cancelCommand(id, cancelledAt, `cancel:${id}`, productId))
    const fact: MetricsAuctionFact = { ...base, status: 'CANCELLED', cancelledAt }
    facts.splice(facts.indexOf(base), 1, fact)
    return fact
  }

  const officialCommand = (
    id: string,
    publishedAt: Date,
    mark: OfficialAuctionMark,
    productId = `product-${id}`,
  ) => ({
    operationId: `publish-official:${id}`,
    auction: OfficialAuction.publish({
      auctionId: id,
      publisherId: 'upb-company',
      publisherType: AuctionPublisherType.GameMaster,
      productId,
      durationHours: 24,
      pricing: {
        kind: AuctionPriceKind.RealMoney,
        minimumBid: { amountMinor: 90_000, currency: 'COP' },
        buyNow: { amountMinor: 120_000, currency: 'COP' },
      },
      mark,
      publishedAt,
    }),
  })

  const publishOfficial = async (
    id: string,
    publishedAt: Date,
    mark: OfficialAuctionMark,
    productId?: string,
  ): Promise<void> => {
    await auctions.publishOfficial(officialCommand(id, publishedAt, mark, productId))
    facts.push({
      id,
      productId: productId ?? `product-${id}`,
      priceKind: 'REAL_MONEY',
      status: 'ACTIVE',
      publishedAt,
      closesAt: plus(publishedAt, 24 * HOUR),
      officialMark: mark === OfficialAuctionMark.Premium ? 'PREMIUM' : 'OFFICIAL',
    })
  }

  const setFact = (id: string, patch: Partial<MetricsAuctionFact>): void => {
    const index = facts.findIndex((fact) => fact.id === id)
    const current = facts[index]
    if (current === undefined) throw new Error(`Hecho inexistente: ${id}`)
    facts[index] = { ...current, ...patch }
  }

  const memoryRepository = (): InMemoryAuctionMetricsRepository => {
    const repository = new InMemoryAuctionMetricsRepository()
    repository.seed(...facts)
    return repository
  }

  const snapshotOf = async (repository: AuctionMetricsRepositoryPort) => ({
    volume: await volumeOf(repository).execute(query),
    day: await trendsOf(repository).execute({ ...query, granularity: 'DAY' }),
    week: await trendsOf(repository).execute({ ...query, granularity: 'WEEK' }),
  })

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()

    // La zona de la BASE no es UTC: los buckets deben seguir saliendo en UTC.
    const admin = createDatabase({ connectionString: container.getConnectionUri() })
    await sql`alter database ${sql.id(container.getDatabase())} set timezone to 'America/Bogota'`.execute(
      admin,
    )
    await admin.destroy()

    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    auctions = new PostgresAuctionRepository(db)
    metrics = new PostgresAuctionMetricsRepository(db)

    // --- Periodo: [2026-09-28T00:00Z, 2026-10-04T00:00Z) ---
    await finish('p1', at('2026-09-28T10:00:00Z'), 'WITH_WINNER')
    await finish('p2', at('2026-09-28T11:00:00Z'), 'WITH_WINNER')
    await finish('p3', at('2026-09-29T10:00:00Z'), 'WITHOUT_BIDS')
    await sell('p4', at('2026-09-27T20:00:00Z'), 10 * HOUR) // publicada fuera, vendida dentro
    await sell('p5', at('2026-09-30T10:00:00Z'), 2 * HOUR)
    await cancel('p6', at('2026-09-29T11:00:00Z'), at('2026-09-29T12:00:00Z'))
    await publishPlayer('p7', at('2026-10-04T08:00:00Z')) // activa (publicada tras `to`)
    await publishPlayer('p8', at('2026-10-03T08:00:00Z')) // vencida, pendiente del scheduler
    await finish('p9', at('2026-09-20T10:00:00Z'), 'WITH_WINNER') // fuera del periodo
    await publishOfficial('o1', at('2026-09-29T09:00:00Z'), OfficialAuctionMark.Official)
    await publishOfficial('o2', at('2026-09-30T09:00:00Z'), OfficialAuctionMark.Premium)
    await publishOfficial('o3', at('2026-09-10T09:00:00Z'), OfficialAuctionMark.Official)

    // Liquidacion fallida y reclamos (tablas que escribe el flujo real de HU-65/HU-69).
    await db
      .insertInto('auction_settlements')
      .values({
        auction_id: 'p2',
        status: 'FAILED_TERMINAL',
        result_type: 'WITH_WINNER',
        winning_bid_id: 'bid-p2',
        winner_id: 'winner-p2',
        winning_hold_id: 'hold-p2',
        seller_id: 'seller-p2',
        final_amount_credits: 25,
        capture_operation_id: 'capture-p2',
        capture_status: 'TERMINAL_ERROR',
        created_at: at('2026-09-29T11:00:30Z'),
        updated_at: at('2026-09-29T11:00:30Z'),
      })
      .execute()
    setFact('p2', { settlementStatus: 'FAILED_TERMINAL' })

    const claim = async (
      id: string,
      status: 'PENDING' | 'CLAIMED' | 'EXPIRED',
      settledAt: Date,
    ): Promise<void> => {
      await db
        .insertInto('auction_pending_claims')
        .values({
          auction_id: id,
          winner_id: `winner-${id}`,
          product_id: `product-${id}`,
          winning_bid_id: `bid-${id}`,
          final_amount_credits: 25,
          settled_at: settledAt,
          claim_status: status,
          claimed_at: status === 'CLAIMED' ? settledAt : null,
          created_at: settledAt,
          updated_at: settledAt,
        })
        .execute()
      setFact(id, { claim: { status, settledAt } })
    }
    await claim('p1', 'CLAIMED', at('2026-09-29T10:00:30Z'))
    await claim('p2', 'EXPIRED', at('2026-09-29T11:00:30Z'))
    await claim('p5', 'PENDING', at('2026-09-30T12:00:00Z'))
  })

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('la base corre en una zona distinta de UTC (la prueba de buckets es significativa)', async () => {
    const zone = await sql<{ TimeZone: string }>`show timezone`.execute(db)

    expect(zone.rows[0]?.TimeZone).toBe('America/Bogota')
  })

  it('volumen y tasa de exito: cifras absolutas (contrato §4.1)', async () => {
    const result = await volumeOf(metrics).execute(query)

    expect(result.playerAuctions).toMatchObject({
      currencyUnit: 'CREDITS',
      published: 6, // p1 p2 p3 p5 p6 p8
      cancelled: 1,
      active: 1,
      awaitingClosure: 1,
      closed: {
        total: 5,
        withWinner: 2,
        soldByBuyNow: 2,
        withoutBids: 1,
        settlementFailedTerminal: 1,
      },
      successRate: { numerator: 4, denominator: 5, value: 0.8 },
      claims: { createdInPeriod: 3, pending: 1, claimed: 1, expired: 1 },
    })
    expect(result.officialAuctions).toMatchObject({
      currencyUnit: 'REAL_MONEY',
      published: 2,
      byMark: { OFFICIAL: 1, PREMIUM: 1 },
      successRate: { availability: 'UNAVAILABLE' },
    })
  })

  it('tiempo de cierre: usa el cierre efectivo, incluida la compra inmediata (contrato §4.5)', async () => {
    const result = await trendsOf(metrics).execute({ ...query, granularity: 'DAY' })

    expect(result.closingTime).toMatchObject({
      sampleSize: 5,
      average: 60498, // (86430*3 + 36000 + 7200) / 5
      median: 86430,
      p90: 86430,
      byCloseReason: {
        EXPIRED_WITH_WINNER: { sampleSize: 2, average: 86430 },
        EXPIRED_WITHOUT_BIDS: { sampleSize: 1, average: 86430 },
        BUY_NOW: { sampleSize: 2, average: 21600 },
      },
      settlementLagSeconds: { sampleSize: 3, average: 30, p90: 30 },
    })
  })

  it('tendencias DAY: buckets UTC contiguos y cada conteo en su ancla', async () => {
    const { trends } = await trendsOf(metrics).execute({ ...query, granularity: 'DAY' })
    const byDay = Object.fromEntries(
      trends.buckets.map((bucket) => [bucket.bucketStart.slice(0, 10), bucket.playerAuctions]),
    )

    expect(trends.buckets.map((b) => b.bucketStart.slice(0, 10))).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ])
    expect(byDay['2026-09-28']).toMatchObject({
      published: 2,
      soldByBuyNow: 1,
      closedWithWinner: 0,
    })
    expect(byDay['2026-09-29']).toMatchObject({
      published: 2,
      closedWithWinner: 2,
      cancelled: 1,
    })
    expect(byDay['2026-09-30']).toMatchObject({
      published: 1,
      closedWithoutBids: 1,
      soldByBuyNow: 1,
      successRate: 0.5,
    })
    expect(byDay['2026-10-03']).toMatchObject({ published: 1, successRate: null })
    expect(trends.buckets[1]?.officialAuctions.published).toBe(1)
  })

  it('PARIDAD: PostgreSQL y el adaptador en memoria devuelven exactamente lo mismo', async () => {
    const memory = memoryRepository()

    expect(await snapshotOf(metrics)).toEqual(await snapshotOf(memory))
    const month = { ...query, granularity: 'MONTH' }
    expect(await trendsOf(metrics).execute(month)).toEqual(await trendsOf(memory).execute(month))
  })

  it('una consulta no modifica ninguna tabla (solo lectura)', async () => {
    const count = async (): Promise<number> => {
      const rows = await sql<{ total: number }>`
        select ((select count(*) from auctions) + (select count(*) from auction_bids)
              + (select count(*) from auction_buy_now_operations)
              + (select count(*) from auction_audit_log) + (select count(*) from outbox_events))::int as total
      `.execute(db)
      return rows.rows[0]?.total ?? -1
    }
    const before = await count()

    await snapshotOf(metrics)

    expect(await count()).toBe(before)
  })

  describe('idempotencia (contrato §5): un reintento con el mismo operationId no cambia el agregado', () => {
    it('publicacion de jugador repetida', async () => {
      const id = 'idem-publish'
      await publishPlayer(id, at('2026-10-01T10:00:00Z'))
      const first = await snapshotOf(metrics)
      const replay = await auctions.publish({
        operationId: `publish:${id}`,
        auction: Auction.publish({
          auctionId: id,
          sellerId: `seller-${id}`,
          productId: `product-${id}`,
          durationHours: 24,
          minimumBidCredits: 10,
          buyNowCredits: 50,
          publishedAt: at('2026-10-01T10:00:00Z'),
          eligibility: {
            productOwnedBySeller: true,
            productInUse: false,
            productTradable: true,
            sellerHasActiveSanctions: false,
            activeAuctionCount: 0,
          },
        }),
        inventoryCommitmentId: `commitment:${id}`,
        feeChargeId: `charge:${id}`,
      })

      expect(replay.replayed).toBe(true)
      expect(await snapshotOf(metrics)).toEqual(first)
    })

    it('compra inmediata repetida', async () => {
      const id = 'idem-buy-now'
      await sell(id, at('2026-10-01T12:00:00Z'), 3 * HOUR)
      const first = await snapshotOf(metrics)

      const replay = await auctions.closeByBuyNow(buyNowCommand(id, at('2026-10-01T15:00:00Z')))

      expect(replay.replayed).toBe(true)
      expect(await snapshotOf(metrics)).toEqual(first)
    })

    it('cancelacion repetida', async () => {
      const id = 'idem-cancel'
      await cancel(id, at('2026-10-02T10:00:00Z'), at('2026-10-02T11:00:00Z'))
      const first = await snapshotOf(metrics)

      const replay = await auctions.cancelAuction(cancelCommand(id, at('2026-10-02T11:00:00Z')))

      expect(replay.replayed).toBe(true)
      expect(await snapshotOf(metrics)).toEqual(first)
    })

    it('publicacion oficial repetida', async () => {
      const id = 'idem-official'
      await publishOfficial(id, at('2026-10-02T09:00:00Z'), OfficialAuctionMark.Premium)
      const first = await snapshotOf(metrics)

      const replay = await auctions.publishOfficial(
        officialCommand(id, at('2026-10-02T09:00:00Z'), OfficialAuctionMark.Premium),
      )

      expect(replay.replayed).toBe(true)
      expect(await snapshotOf(metrics)).toEqual(first)
    })

    it('tras los reintentos, PostgreSQL sigue en paridad con la memoria', async () => {
      expect(await snapshotOf(metrics)).toEqual(await snapshotOf(memoryRepository()))
    })
  })

  describe('migracion 019 de indices (R-06)', () => {
    const expected = [
      'auctions_published_at_idx',
      'auctions_finished_at_credits_idx',
      'auctions_cancelled_at_credits_idx',
      'auction_bids_placed_at_idx',
      'auction_buy_now_operations_completed_at_idx',
    ]
    const existing = async (): Promise<string[]> => {
      const rows = await sql<{ indexname: string }>`
        select indexname from pg_indexes where indexname = any(${expected})
      `.execute(db)
      return rows.rows.map((row) => row.indexname).sort()
    }

    it('crea los cinco indices (parciales con price_kind en finished/cancelled)', async () => {
      expect(await existing()).toEqual([...expected].sort())
      const partial = await sql<{ indexdef: string }>`
        select indexdef from pg_indexes
        where indexname in ('auctions_finished_at_credits_idx', 'auctions_cancelled_at_credits_idx')
      `.execute(db)
      expect(partial.rows).toHaveLength(2)
      for (const row of partial.rows) expect(row.indexdef).toContain('price_kind')
    })

    it('es reversible: down elimina y up vuelve a crear', async () => {
      await metricsIndexes.down(db as unknown as Kysely<unknown>)
      expect(await existing()).toEqual([])

      await metricsIndexes.up(db as unknown as Kysely<unknown>)
      expect(await existing()).toEqual([...expected].sort())
    })
  })

  describe('ranking de productos HU-91.3 (contrato §3.4 / §4.2)', () => {
    // Periodo propio (agosto): aislado de los datos y las idempotencias de arriba.
    const rankPeriod = {
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-08T00:00:00.000Z'),
    }
    const rankQuery = { from: '2026-08-01T00:00:00Z', to: '2026-08-08T00:00:00Z' }
    const P1 = 'rk-prod-1'
    const P2 = 'rk-prod-2'

    beforeAll(async () => {
      // P1: el MISMO producto publicado cuatro veces (republicado) y de tres formas.
      await finish('rk-a1', at('2026-08-02T10:00:00Z'), 'WITH_WINNER', 30_000, P1)
      // Tres pujas sobre a1: un JOIN contra auction_bids contaria a1 tres veces.
      await db
        .insertInto('auction_bids')
        .values(
          [1, 2, 3].map((n) => ({
            id: `rk-bid-${String(n)}`,
            auction_id: 'rk-a1',
            bidder_id: `bidder-${String(n)}`,
            amount_credits: 10 + n,
            placed_at: at(`2026-08-02T10:0${String(n)}:00Z`),
            is_leader: n === 3,
            credit_reservation_id: null,
          })),
        )
        .execute()
      await cancel('rk-a2', at('2026-08-03T10:00:00Z'), at('2026-08-03T11:00:00Z'), P1)
      await sell('rk-a3', at('2026-08-04T10:00:00Z'), 2 * HOUR, P1)
      await publishOfficial('rk-a4', at('2026-08-05T10:00:00Z'), OfficialAuctionMark.Premium, P1)

      await finish('rk-b1', at('2026-08-02T11:00:00Z'), 'WITHOUT_BIDS', 30_000, P2)
      await finish('rk-b2', at('2026-08-04T11:00:00Z'), 'WITH_WINNER', 30_000, P2)

      // Tres productos empatados con una venta cada uno: el desempate es por productId.
      await finish('rk-c1', at('2026-08-06T10:00:00Z'), 'WITH_WINNER', 30_000, 'rk-zzz')
      await finish('rk-c2', at('2026-08-06T10:00:00Z'), 'WITH_WINNER', 30_000, 'rk-tie')
      await finish('rk-c3', at('2026-08-06T10:00:00Z'), 'WITH_WINNER', 30_000, 'RK-tie')
    })

    it('mas subastados: una fila por publicacion, jugador y oficial por separado, sin multiplicar por pujas', async () => {
      const { mostAuctioned } = await metrics.getProductRankings(rankPeriod, 10)

      expect(mostAuctioned).toEqual([
        // a1 (3 pujas) + a2 (cancelada) + a3 (compra inmediata) + a4 (oficial) = 4, NO 6.
        { productId: P1, total: 4, playerCredits: 3, officialRealMoney: 1 },
        { productId: P2, total: 2, playerCredits: 2, officialRealMoney: 0 },
        // Empate a 1 desempatado por productId ASC en orden de bytes (collate "C").
        { productId: 'RK-tie', total: 1, playerCredits: 1, officialRealMoney: 0 },
        { productId: 'rk-tie', total: 1, playerCredits: 1, officialRealMoney: 0 },
        { productId: 'rk-zzz', total: 1, playerCredits: 1, officialRealMoney: 0 },
      ])
    })

    it('mas vendidos: solo jugador con venta cerrada; la cancelada, la oficial y la sin pujas no cuentan', async () => {
      const { mostSold } = await metrics.getProductRankings(rankPeriod, 10)

      expect(mostSold).toEqual([
        { productId: P1, total: 2, byAuctionClose: 1, byBuyNow: 1 }, // a1 + a3
        { productId: 'RK-tie', total: 1, byAuctionClose: 1, byBuyNow: 0 },
        { productId: P2, total: 1, byAuctionClose: 1, byBuyNow: 0 }, // solo b2; b1 fue sin pujas
        { productId: 'rk-tie', total: 1, byAuctionClose: 1, byBuyNow: 0 },
        { productId: 'rk-zzz', total: 1, byAuctionClose: 1, byBuyNow: 0 },
      ])
    })

    it('limit recorta cada lista tras ordenar', async () => {
      const { mostAuctioned, mostSold } = await metrics.getProductRankings(rankPeriod, 2)

      expect(mostAuctioned.map((entry) => entry.productId)).toEqual([P1, P2])
      expect(mostSold.map((entry) => entry.productId)).toEqual([P1, 'RK-tie'])
    })

    it('PARIDAD: PostgreSQL y el adaptador en memoria devuelven los mismos rankings', async () => {
      const memory = memoryRepository()

      for (const limit of [1, 2, 3, 10, 50]) {
        expect(await metrics.getProductRankings(rankPeriod, limit)).toEqual(
          await memory.getProductRankings(rankPeriod, limit),
        )
      }
      // Tambien sobre el periodo grande de las pruebas anteriores.
      const wide = { from: at('2026-09-01T00:00:00Z'), to: at('2026-10-04T00:00:00Z') }
      expect(await metrics.getProductRankings(wide, 50)).toEqual(
        await memory.getProductRankings(wide, 50),
      )
    })

    it('el caso de uso completo coincide en ambos adaptadores (Catalog simulado)', async () => {
      const catalog = { findProducts: () => Promise.resolve([]) }
      const fromPostgres = await new GetAuctionProductRankings(metrics, catalog, clock).execute(
        rankQuery,
      )
      const fromMemory = await new GetAuctionProductRankings(
        memoryRepository(),
        catalog,
        clock,
      ).execute(rankQuery)

      expect(fromPostgres).toEqual(fromMemory)
      expect(fromPostgres.enrichment.status).toBe('PARTIAL')
    })

    it('idempotencia (contrato §5): reintentar publicacion, compra inmediata y cancelacion no cambia el ranking', async () => {
      const before = await metrics.getProductRankings(rankPeriod, 50)

      const publishReplay = await auctions.publish({
        operationId: 'publish:rk-a1',
        auction: Auction.publish({
          auctionId: 'rk-a1',
          sellerId: 'seller-rk-a1',
          productId: P1,
          durationHours: 24,
          minimumBidCredits: 10,
          buyNowCredits: 50,
          publishedAt: at('2026-08-02T10:00:00Z'),
          eligibility: {
            productOwnedBySeller: true,
            productInUse: false,
            productTradable: true,
            sellerHasActiveSanctions: false,
            activeAuctionCount: 0,
          },
        }),
        inventoryCommitmentId: 'commitment:rk-a1',
        feeChargeId: 'charge:rk-a1',
      })
      const buyNowReplay = await auctions.closeByBuyNow(
        buyNowCommand('rk-a3', at('2026-08-04T12:00:00Z')),
      )
      const cancelReplay = await auctions.cancelAuction(
        cancelCommand('rk-a2', at('2026-08-03T11:00:00Z'), 'cancel:rk-a2', P1),
      )

      expect([publishReplay.replayed, buyNowReplay.replayed, cancelReplay.replayed]).toEqual([
        true,
        true,
        true,
      ])
      expect(await metrics.getProductRankings(rankPeriod, 50)).toEqual(before)
    })

    it('el periodo es semiabierto [from, to) y cada ranking usa su ancla', async () => {
      // Solo el 2 de agosto: a1 y b1 se publicaron ese dia, pero sus cierres caen el 3.
      const publishedDay = {
        from: at('2026-08-02T00:00:00Z'),
        to: at('2026-08-03T00:00:00Z'),
      }
      const { mostAuctioned, mostSold } = await metrics.getProductRankings(publishedDay, 10)

      expect(mostAuctioned.map((entry) => [entry.productId, entry.total])).toEqual([
        [P1, 1],
        [P2, 1],
      ])
      expect(mostSold).toEqual([])
    })

    it('un periodo sin datos devuelve listas vacias', async () => {
      const empty = { from: at('2025-01-01T00:00:00Z'), to: at('2025-01-08T00:00:00Z') }

      expect(await metrics.getProductRankings(empty, 10)).toEqual({
        mostAuctioned: [],
        mostSold: [],
      })
    })
  })
})
