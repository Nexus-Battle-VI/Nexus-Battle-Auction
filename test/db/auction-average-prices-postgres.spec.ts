import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import { PostgresAuctionMetricsRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionMetricsRepository'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { AuctionMetricsRepositoryPort } from '../../src/application/ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { GetAuctionAveragePrices } from '../../src/application/use-cases/GetAuctionAveragePrices'
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
 * HU-91.4. Precios promedio contra PostgreSQL REAL: cifras absolutas verificadas a
 * mano, PARIDAD exacta con el adaptador en memoria, que varias pujas no multipliquen
 * filas, e idempotencia (contrato `hu-91.v1` §5) con las operaciones reales del
 * repositorio. La zona horaria de la base es America/Bogota para probar que el
 * periodo y los anclajes no dependen de la zona de la sesion.
 */
describe('Precios promedio contra PostgreSQL real (HU-91.4)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let auctions: PostgresAuctionRepository
  let metrics: PostgresAuctionMetricsRepository
  const facts: MetricsAuctionFact[] = []

  const averageOf = (repository: AuctionMetricsRepositoryPort) =>
    new GetAuctionAveragePrices(repository, clock)

  const replace = (id: string, fact: MetricsAuctionFact): void => {
    facts.splice(
      facts.findIndex((candidate) => candidate.id === id),
      1,
      fact,
    )
  }

  const publishPlayer = async (
    id: string,
    publishedAt: Date,
    minimumBidCredits: number,
  ): Promise<MetricsAuctionFact> => {
    await auctions.publish({
      operationId: `publish:${id}`,
      auction: Auction.publish({
        auctionId: id,
        sellerId: `seller-${id}`,
        productId: `product-${id}`,
        durationHours: 24,
        minimumBidCredits,
        publishedAt,
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
    const fact: MetricsAuctionFact = {
      id,
      priceKind: 'CREDITS',
      status: 'ACTIVE',
      publishedAt,
      closesAt: plus(publishedAt, 24 * HOUR),
      minimumBidCredits,
    }
    facts.push(fact)
    return fact
  }

  const closedSale = async (
    id: string,
    publishedAt: Date,
    minimumBid: number,
    price: number,
  ): Promise<void> => {
    const base = await publishPlayer(id, publishedAt, minimumBid)
    const finishedAt = plus(base.closesAt, 30_000)
    await auctions.finishAuction({
      auctionId: id,
      finishedAt,
      closingResult: AuctionClosingResult.withWinner({
        finishedAt,
        bidderId: `winner-${id}`,
        bidId: `bid-win-${id}`,
        amountCredits: price,
      }),
    })
    replace(id, {
      ...base,
      status: 'FINISHED',
      finishedAt,
      closingResultType: 'WITH_WINNER',
      finalAmountCredits: price,
    })
  }

  const withoutBids = async (id: string, publishedAt: Date, minimumBid: number): Promise<void> => {
    const base = await publishPlayer(id, publishedAt, minimumBid)
    const finishedAt = plus(base.closesAt, 30_000)
    await auctions.finishAuction({
      auctionId: id,
      finishedAt,
      closingResult: AuctionClosingResult.withoutBids(finishedAt),
    })
    replace(id, { ...base, status: 'FINISHED', finishedAt, closingResultType: 'WITHOUT_BIDS' })
  }

  const buyNowCommand = (
    id: string,
    price: number,
    closedAt: Date,
    operationId = `buy-now:${id}`,
  ) => ({
    operationId,
    transactionId: `tx:${id}`,
    auctionId: id,
    buyerId: `buyer-${id}`,
    transferId: `transfer:${id}`,
    priceCredits: price,
    remainingCredits: 100,
    closedAt,
  })

  const buyNowSale = async (
    id: string,
    publishedAt: Date,
    minimumBid: number,
    price: number,
  ): Promise<void> => {
    const base = await publishPlayer(id, publishedAt, minimumBid)
    const closedAt = plus(publishedAt, 2 * HOUR)
    await auctions.closeByBuyNow(buyNowCommand(id, price, closedAt))
    replace(id, { ...base, status: 'SOLD', buyNowCompletedAt: closedAt, buyNowPriceCredits: price })
  }

  const cancelCommand = (id: string, cancelledAt: Date) => ({
    operationId: `cancel:${id}`,
    auctionId: id,
    sellerId: `seller-${id}`,
    productId: `product-${id}`,
    cancelledAt,
    inventoryCommitmentId: `commitment:${id}`,
    feeChargeId: `charge:${id}`,
    refundAmountCredits: 0.5,
    walletRefundOperationId: `wallet-refund:${id}`,
    inventoryReleaseOperationId: `inventory-release:${id}`,
  })

  const cancelled = async (id: string, publishedAt: Date, minimumBid: number): Promise<void> => {
    const base = await publishPlayer(id, publishedAt, minimumBid)
    const cancelledAt = plus(publishedAt, HOUR)
    await auctions.cancelAuction(cancelCommand(id, cancelledAt))
    replace(id, { ...base, status: 'CANCELLED', cancelledAt })
  }

  const officialCommand = (
    id: string,
    publishedAt: Date,
    currency: string,
    minimumBidMinor: number,
    buyNowMinor?: number,
  ) => ({
    operationId: `publish-official:${id}`,
    auction: OfficialAuction.publish({
      auctionId: id,
      publisherId: 'upb-company',
      publisherType: AuctionPublisherType.GameMaster,
      productId: `product-${id}`,
      durationHours: 24,
      pricing: {
        kind: AuctionPriceKind.RealMoney,
        minimumBid: { amountMinor: minimumBidMinor, currency },
        buyNow: buyNowMinor === undefined ? null : { amountMinor: buyNowMinor, currency },
      },
      mark: OfficialAuctionMark.Official,
      publishedAt,
    }),
  })

  const official = async (
    id: string,
    publishedAt: Date,
    currency: string,
    minimumBidMinor: number,
    buyNowMinor?: number,
  ): Promise<void> => {
    await auctions.publishOfficial(
      officialCommand(id, publishedAt, currency, minimumBidMinor, buyNowMinor),
    )
    facts.push({
      id,
      priceKind: 'REAL_MONEY',
      status: 'ACTIVE',
      publishedAt,
      closesAt: plus(publishedAt, 24 * HOUR),
      officialMark: 'OFFICIAL',
      currency,
      minimumBidAmountMinor: minimumBidMinor,
      ...(buyNowMinor === undefined ? {} : { buyNowAmountMinor: buyNowMinor }),
    })
  }

  const memoryRepository = (): InMemoryAuctionMetricsRepository => {
    const repository = new InMemoryAuctionMetricsRepository()
    repository.seed(...facts)
    return repository
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()

    // La zona de la BASE no es UTC: periodo y anclajes deben seguir saliendo en UTC.
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
    await closedSale('p1', at('2026-09-28T10:00:00Z'), 20, 100)
    await closedSale('p2', at('2026-09-28T11:00:00Z'), 30, 200)
    await buyNowSale('p3', at('2026-09-29T10:00:00Z'), 10, 50)
    await buyNowSale('p4', at('2026-09-30T10:00:00Z'), 40, 90)
    await cancelled('p5', at('2026-09-29T09:00:00Z'), 25)
    await withoutBids('p6', at('2026-09-30T09:00:00Z'), 15)
    await publishPlayer('p7', at('2026-10-03T08:00:00Z'), 5) // activa
    await official('o1', at('2026-09-29T10:00:00Z'), 'COP', 1_000_000, 2_000_000)
    await official('o2', at('2026-09-30T10:00:00Z'), 'COP', 3_000_000)
    await official('o3', at('2026-10-01T10:00:00Z'), 'USD', 5_000, 9_000)
    await official('o4', at('2026-08-01T10:00:00Z'), 'EUR', 700) // fuera del periodo
    // Importes grandes: el promedio (2_000_000_000.67) debe redondearse exacto, sin coma flotante.
    await official('o5', at('2026-10-02T10:00:00Z'), 'JPY', 2_000_000_000)
    await official('o6', at('2026-10-02T11:00:00Z'), 'JPY', 2_000_000_001)
    await official('o7', at('2026-10-02T12:00:00Z'), 'JPY', 2_000_000_001)

    // Varias pujas por subasta: un JOIN a auction_bids multiplicaria las ventas p1 y p2.
    await db
      .insertInto('auction_bids')
      .values([
        ...[1, 2, 3, 4].map((n) => ({
          id: `bid-p1-${String(n)}`,
          auction_id: 'p1',
          bidder_id: `bidder-${String(n)}`,
          amount_credits: 20 + n,
          placed_at: at(`2026-09-28T10:0${String(n)}:00Z`),
          is_leader: n === 4,
          credit_reservation_id: null,
        })),
        ...[1, 2, 3].map((n) => ({
          id: `bid-p2-${String(n)}`,
          auction_id: 'p2',
          bidder_id: `bidder-${String(n)}`,
          amount_credits: 30 + n,
          placed_at: at(`2026-09-28T11:0${String(n)}:00Z`),
          is_leader: n === 3,
          credit_reservation_id: null,
        })),
      ])
      .execute()
  })

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('la base corre en una zona distinta de UTC', async () => {
    const zone = await sql<{ TimeZone: string }>`show timezone`.execute(db)

    expect(zone.rows[0]?.TimeZone).toBe('America/Bogota')
  })

  it('creditos: cifras absolutas (cierre + compra inmediata) sin multiplicar por pujas', async () => {
    const { credits } = await averageOf(metrics).execute(query)

    expect(credits).toEqual({
      basis: 'FINAL_SALE_PRICE',
      salesCount: 4, // p1 p2 p3 p4; NO 11 ni 9 por sus pujas
      average: { unit: 'CREDITS', amount: 110 }, // (100 + 200 + 50 + 90) / 4
      median: { unit: 'CREDITS', amount: 95 }, // [50, 90, 100, 200] -> (90 + 100) / 2
      min: { unit: 'CREDITS', amount: 50 },
      max: { unit: 'CREDITS', amount: 200 },
      byChannel: {
        AUCTION_CLOSE: { salesCount: 2, average: { unit: 'CREDITS', amount: 150 } },
        BUY_NOW: { salesCount: 2, average: { unit: 'CREDITS', amount: 70 } },
      },
      // Toda publicacion de jugador del periodo: 20 + 30 + 10 + 40 + 25 + 15 + 5 = 145 / 7
      listedMinimumBid: { auctionsCount: 7, average: { unit: 'CREDITS', amount: 20.71 } },
    })
  })

  it('la compra inmediata toma su precio de la operacion (final_amount_credits queda NULL en SOLD)', async () => {
    const sold = await sql<{ final_amount_credits: string | null; status: string }>`
      select final_amount_credits, status from auctions where id in ('p3', 'p4')
    `.execute(db)

    expect(sold.rows.map((row) => [row.status, row.final_amount_credits])).toEqual([
      ['SOLD', null],
      ['SOLD', null],
    ])
    // Y aun asi entran en el promedio con el precio de auction_buy_now_operations.
    expect((await averageOf(metrics).execute(query)).credits.byChannel.BUY_NOW).toEqual({
      salesCount: 2,
      average: { unit: 'CREDITS', amount: 70 },
    })
  })

  it('dinero real: precio de lista por moneda en orden ASC, enteros de unidad minima', async () => {
    const { realMoney } = await averageOf(metrics).execute(query)

    expect(realMoney.finalSalePrice).toEqual({
      availability: 'UNAVAILABLE',
      reason: 'OFFICIAL_AUCTION_HAS_NO_SALE_FLOW',
    })
    expect(realMoney.byCurrency.map((entry) => entry.currency)).toEqual(['COP', 'JPY', 'USD'])
    expect(realMoney.byCurrency[0]).toEqual({
      currency: 'COP',
      publishedCount: 2,
      listedMinimumBid: {
        average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 2_000_000 },
        min: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 1_000_000 },
        max: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 3_000_000 },
      },
      listedBuyNow: {
        count: 1,
        average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 2_000_000 },
      },
    })
    expect(realMoney.byCurrency[2]).toMatchObject({
      currency: 'USD',
      publishedCount: 1,
      listedBuyNow: { count: 1, average: { amountMinor: 9_000 } },
    })
    // EUR esta fuera del periodo: no aparece.
    expect(realMoney.byCurrency.some((entry) => entry.currency === 'EUR')).toBe(false)
  })

  it('importes grandes: 2_000_000_000, 2_000_000_001 y 2_000_000_001 promedian 2_000_000_001 exacto', async () => {
    const jpy = (await averageOf(metrics).execute(query)).realMoney.byCurrency.find(
      (entry) => entry.currency === 'JPY',
    )

    expect(jpy?.listedMinimumBid).toEqual({
      average: { unit: 'REAL_MONEY', currency: 'JPY', amountMinor: 2_000_000_001 },
      min: { unit: 'REAL_MONEY', currency: 'JPY', amountMinor: 2_000_000_000 },
      max: { unit: 'REAL_MONEY', currency: 'JPY', amountMinor: 2_000_000_001 },
    })
    expect(jpy?.listedBuyNow).toEqual({ count: 0, average: null })
  })

  it('creditos y dinero real nunca se mezclan: cada rama solo tiene su unidad', async () => {
    const result = await averageOf(metrics).execute(query)
    const units = (branch: unknown): Set<string> =>
      new Set([...JSON.stringify(branch).matchAll(/"unit":"([A-Z_]+)"/g)].map((m) => m[1] ?? ''))

    expect(units(result.credits)).toEqual(new Set(['CREDITS']))
    expect(units(result.realMoney)).toEqual(new Set(['REAL_MONEY']))
  })

  it('un periodo sin ventas devuelve null (no 0) y sin monedas', async () => {
    const empty = await averageOf(metrics).execute({
      from: '2025-01-01T00:00:00Z',
      to: '2025-01-08T00:00:00Z',
    })

    expect(empty.credits).toMatchObject({
      salesCount: 0,
      average: null,
      median: null,
      min: null,
      max: null,
      byChannel: {
        AUCTION_CLOSE: { salesCount: 0, average: null },
        BUY_NOW: { salesCount: 0, average: null },
      },
      listedMinimumBid: { auctionsCount: 0, average: null },
    })
    expect(empty.realMoney.byCurrency).toEqual([])
  })

  it('PARIDAD: PostgreSQL y el adaptador en memoria devuelven exactamente lo mismo', async () => {
    const memory = memoryRepository()

    expect(await averageOf(metrics).execute(query)).toEqual(await averageOf(memory).execute(query))
    for (const range of [
      { from: '2026-09-29T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      { from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' },
      { from: '2025-01-01T00:00:00Z', to: '2025-01-08T00:00:00Z' },
    ]) {
      expect(await averageOf(metrics).execute(range)).toEqual(
        await averageOf(memory).execute(range),
      )
    }
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

    await averageOf(metrics).execute(query)

    expect(await count()).toBe(before)
  })

  describe('idempotencia (contrato §5): un reintento con el mismo operationId no cambia el agregado', () => {
    it('publicacion de jugador, compra inmediata y cancelacion repetidas', async () => {
      const before = await averageOf(metrics).execute(query)

      const publishReplay = await auctions.publish({
        operationId: 'publish:p1',
        auction: Auction.publish({
          auctionId: 'p1',
          sellerId: 'seller-p1',
          productId: 'product-p1',
          durationHours: 24,
          minimumBidCredits: 20,
          publishedAt: at('2026-09-28T10:00:00Z'),
          eligibility: {
            productOwnedBySeller: true,
            productInUse: false,
            productTradable: true,
            sellerHasActiveSanctions: false,
            activeAuctionCount: 0,
          },
        }),
        inventoryCommitmentId: 'commitment:p1',
        feeChargeId: 'charge:p1',
      })
      const buyNowReplay = await auctions.closeByBuyNow(
        buyNowCommand('p3', 50, at('2026-09-29T12:00:00Z')),
      )
      const cancelReplay = await auctions.cancelAuction(
        cancelCommand('p5', at('2026-09-29T10:00:00Z')),
      )

      expect([publishReplay.replayed, buyNowReplay.replayed, cancelReplay.replayed]).toEqual([
        true,
        true,
        true,
      ])
      expect(await averageOf(metrics).execute(query)).toEqual(before)
    })

    it('publicacion oficial repetida', async () => {
      const before = await averageOf(metrics).execute(query)

      const replay = await auctions.publishOfficial(
        officialCommand('o1', at('2026-09-29T10:00:00Z'), 'COP', 1_000_000, 2_000_000),
      )

      expect(replay.replayed).toBe(true)
      expect(await averageOf(metrics).execute(query)).toEqual(before)
    })

    it('tras los reintentos, PostgreSQL sigue en paridad con la memoria', async () => {
      expect(await averageOf(metrics).execute(query)).toEqual(
        await averageOf(memoryRepository()).execute(query),
      )
    })
  })
})
