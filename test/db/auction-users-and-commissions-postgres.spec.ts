import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import { PostgresAuctionCancellationRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionCancellationRepository'
import { PostgresAuctionMetricsRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionMetricsRepository'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type {
  AuctionMetricsAdapterOptions,
  AuctionMetricsRepositoryPort,
} from '../../src/application/ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { GetAuctionUsersAndCommissions } from '../../src/application/use-cases/GetAuctionUsersAndCommissions'
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

type RefundStatus = NonNullable<MetricsAuctionFact['cancellation']>['walletRefundStatus']

/**
 * HU-91.5. Usuarios activos y comisiones contra PostgreSQL REAL: cifras absolutas,
 * PARIDAD exacta con el adaptador en memoria, que varias pujas NO multipliquen usuarios
 * ni comisiones, el comportamiento ACTUAL de las pujas en subastas canceladas (regla
 * abierta) en ambos modos, idempotencia con las operaciones reales, y solo lectura. La
 * base corre en America/Bogota para probar que el periodo no depende de la zona.
 */
describe('Usuarios activos y comisiones contra PostgreSQL real (HU-91.5)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let auctions: PostgresAuctionRepository
  let cancellations: PostgresAuctionCancellationRepository
  let metrics: PostgresAuctionMetricsRepository
  const facts: MetricsAuctionFact[] = []

  const reportOf = (repository: AuctionMetricsRepositoryPort) =>
    new GetAuctionUsersAndCommissions(repository, clock)

  const replace = (id: string, patch: Partial<MetricsAuctionFact>): void => {
    const index = facts.findIndex((fact) => fact.id === id)
    const current = facts[index]
    if (current === undefined) throw new Error(`Hecho inexistente: ${id}`)
    facts[index] = { ...current, ...patch }
  }

  const publishCommand = (id: string, seller: string, hours: 24 | 48, publishedAt: Date) => ({
    operationId: `publish:${id}`,
    auction: Auction.publish({
      auctionId: id,
      sellerId: seller,
      productId: `product-${id}`,
      durationHours: hours,
      minimumBidCredits: 10,
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

  const publish = async (
    id: string,
    seller: string,
    hours: 24 | 48,
    publishedAt: Date,
  ): Promise<void> => {
    await auctions.publish(publishCommand(id, seller, hours, publishedAt))
    facts.push({
      id,
      priceKind: 'CREDITS',
      status: 'ACTIVE',
      publishedAt,
      closesAt: plus(publishedAt, hours * HOUR),
      sellerId: seller,
      durationHours: hours,
      publicationFeeCredits: hours === 24 ? 1 : 3,
    })
  }

  /** Inserta pujas (filas de `auction_bids`); varias del mismo usuario son filas distintas. */
  const bid = async (
    id: string,
    bidderId: string,
    placedAts: readonly string[],
    leaderIndex = -1,
  ): Promise<void> => {
    const base = await db
      .selectFrom('auction_bids')
      .select('id')
      .where('auction_id', '=', id)
      .execute()
    await db
      .insertInto('auction_bids')
      .values(
        placedAts.map((placedAt, index) => ({
          id: `bid-${id}-${bidderId}-${String(base.length + index)}`,
          auction_id: id,
          bidder_id: bidderId,
          amount_credits: 11 + base.length + index,
          placed_at: at(placedAt),
          is_leader: index === leaderIndex,
          credit_reservation_id: null,
        })),
      )
      .execute()
    const current = facts.find((fact) => fact.id === id)
    replace(id, {
      bids: [
        ...(current?.bids ?? []),
        ...placedAts.map((placedAt) => ({ bidderId, placedAt: at(placedAt) })),
      ],
    })
  }

  /** Cierra la subasta: con ganador si lo hay (cierre normal) y sin pujas si no. */
  const finish = async (id: string, winner?: string): Promise<void> => {
    const fact = facts.find((candidate) => candidate.id === id)
    if (fact === undefined) throw new Error(id)
    const finishedAt = plus(fact.closesAt, 30_000)
    await auctions.finishAuction({
      auctionId: id,
      finishedAt,
      closingResult:
        winner === undefined
          ? AuctionClosingResult.withoutBids(finishedAt)
          : AuctionClosingResult.withWinner({
              finishedAt,
              bidderId: winner,
              bidId: `bid-win-${id}`,
              amountCredits: 20,
            }),
    })
    replace(id, {
      status: 'FINISHED',
      finishedAt,
      closingResultType: winner === undefined ? 'WITHOUT_BIDS' : 'WITH_WINNER',
    })
  }

  const buyNowCommand = (
    id: string,
    buyer: string,
    closedAt: Date,
    operationId = `buy-now:${id}`,
  ) => ({
    operationId,
    transactionId: `tx:${id}`,
    auctionId: id,
    buyerId: buyer,
    transferId: `transfer:${id}`,
    priceCredits: 50,
    remainingCredits: 100,
    closedAt,
  })

  const buyNow = async (id: string, buyer: string, closedAt: Date): Promise<void> => {
    await auctions.closeByBuyNow(buyNowCommand(id, buyer, closedAt))
    replace(id, { status: 'SOLD', buyerId: buyer, buyNowCompletedAt: closedAt })
  }

  const cancelCommand = (id: string, seller: string, refund: number, cancelledAt: Date) => ({
    operationId: `cancel:${id}`,
    auctionId: id,
    sellerId: seller,
    productId: `product-${id}`,
    cancelledAt,
    inventoryCommitmentId: `commitment:${id}`,
    feeChargeId: `charge:${id}`,
    refundAmountCredits: refund,
    walletRefundOperationId: `wallet-refund:${id}`,
    inventoryReleaseOperationId: `inventory-release:${id}`,
  })

  /** Cancelacion MANUAL (reembolso 0.5 o 1.5) con el estado del reembolso en Wallet indicado. */
  const cancelManually = async (
    id: string,
    seller: string,
    refund: 0.5 | 1.5,
    cancelledAt: Date,
    status: RefundStatus,
  ): Promise<void> => {
    await auctions.cancelAuction(cancelCommand(id, seller, refund, cancelledAt))
    const when = plus(cancelledAt, 1_000)
    if (status === 'CONFIRMED') await cancellations.markWalletRefundConfirmed(id, when)
    if (status === 'RETRYABLE') await cancellations.markWalletRefundRetryable(id, 'timeout', when)
    if (status === 'TERMINAL_ERROR')
      await cancellations.markWalletRefundTerminal(id, 'rechazado', when)
    replace(id, {
      status: 'CANCELLED',
      cancelledAt,
      cancellation: { refundAmountCredits: refund, walletRefundStatus: status },
    })
  }

  const automaticCommand = (id: string, cancelledAt: Date) => ({
    operationId: `auto-cancel:${id}`,
    auctionId: id,
    triggerReferenceId: `sanction:${id}`,
    cancelledAt,
    inventoryReleaseOperationId: `auto-release:${id}`,
  })

  /** Cancelacion AUTOMATICA por sancion (HU-90 CA-05): puede tener pujas y no reembolsa. */
  const cancelAutomatically = async (id: string, cancelledAt: Date): Promise<void> => {
    await auctions.cancelAuctionAutomatically(automaticCommand(id, cancelledAt))
    replace(id, {
      status: 'CANCELLED',
      cancelledAt,
      cancellation: { refundAmountCredits: 0, walletRefundStatus: 'NOT_REQUIRED' },
    })
  }

  const officialCommand = (id: string, publishedAt: Date) => ({
    operationId: `publish-official:${id}`,
    auction: OfficialAuction.publish({
      auctionId: id,
      publisherId: 'upb-company',
      publisherType: AuctionPublisherType.GameMaster,
      productId: `product-${id}`,
      durationHours: 24,
      pricing: {
        kind: AuctionPriceKind.RealMoney,
        minimumBid: { amountMinor: 90_000, currency: 'COP' },
        buyNow: null,
      },
      mark: OfficialAuctionMark.Official,
      publishedAt,
    }),
  })

  const memoryRepository = (
    options: AuctionMetricsAdapterOptions = {},
  ): InMemoryAuctionMetricsRepository => {
    const repository = new InMemoryAuctionMetricsRepository(options)
    repository.seed(...facts)
    return repository
  }

  const snapshotOf = (repository: AuctionMetricsRepositoryPort) =>
    reportOf(repository).execute(query)

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()

    // La zona de la BASE no es UTC: el periodo debe seguir saliendo en UTC.
    const admin = createDatabase({ connectionString: container.getConnectionUri() })
    await sql`alter database ${sql.id(container.getDatabase())} set timezone to 'America/Bogota'`.execute(
      admin,
    )
    await admin.destroy()

    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    auctions = new PostgresAuctionRepository(db)
    cancellations = new PostgresAuctionCancellationRepository(db)
    metrics = new PostgresAuctionMetricsRepository(db)

    // --- Periodo: [2026-09-28T00:00Z, 2026-10-04T00:00Z) ---
    // A1: S1 vende (24h); B1 puja 3 veces y B2 una.
    await publish('a1', 'S1', 24, at('2026-09-28T10:00:00Z'))
    await bid('a1', 'B1', ['2026-09-28T10:10:00Z', '2026-09-28T10:20:00Z', '2026-09-28T10:30:00Z'])
    await bid('a1', 'B2', ['2026-09-28T10:40:00Z'], 0)
    await finish('a1', 'B2')
    // A2: S1 vende (48h); B1 puja y luego compra de inmediato (una subasta, dos roles).
    await publish('a2', 'S1', 48, at('2026-09-29T10:00:00Z'))
    await bid('a2', 'B1', ['2026-09-29T11:00:00Z'], 0)
    await buyNow('a2', 'B1', at('2026-09-29T12:00:00Z'))
    // A3: S2 (24h), cancelada manual, reembolso 0.5 CONFIRMADO.
    await publish('a3', 'S2', 24, at('2026-09-30T10:00:00Z'))
    await cancelManually('a3', 'S2', 0.5, at('2026-09-30T11:00:00Z'), 'CONFIRMED')
    // A4: S2 (48h), cancelada manual, reembolso 1.5 PENDIENTE.
    await publish('a4', 'S2', 48, at('2026-10-01T10:00:00Z'))
    await cancelManually('a4', 'S2', 1.5, at('2026-10-01T11:00:00Z'), 'PENDING')
    // A5: S3 (24h), con pujas (B3 x2, B2 x1) y cancelada AUTOMATICAMENTE.
    await publish('a5', 'S3', 24, at('2026-10-02T10:00:00Z'))
    await bid('a5', 'B3', ['2026-10-02T10:30:00Z', '2026-10-02T10:40:00Z'])
    await bid('a5', 'B2', ['2026-10-02T11:00:00Z'], 0)
    await cancelAutomatically('a5', at('2026-10-02T12:00:00Z'))
    // A6: S3 (24h), activa, B2 puja dos veces.
    await publish('a6', 'S3', 24, at('2026-10-03T10:00:00Z'))
    await bid('a6', 'B2', ['2026-10-03T10:30:00Z', '2026-10-03T10:40:00Z'])
    // A7: S4 (48h), cancelada manual, reembolso 1.5 REINTENTABLE (pendiente).
    await publish('a7', 'S4', 48, at('2026-10-01T11:00:00Z'))
    await cancelManually('a7', 'S4', 1.5, at('2026-10-01T12:00:00Z'), 'RETRYABLE')
    // A8: S4 (24h), cancelada manual, reembolso fallido TERMINAL.
    await publish('a8', 'S4', 24, at('2026-10-02T11:00:00Z'))
    await cancelManually('a8', 'S4', 0.5, at('2026-10-02T12:00:00Z'), 'TERMINAL_ERROR')
    // A9: publicada ANTES del periodo; solo la puja de B4 cae dentro. S5 no cuenta.
    await publish('a9', 'S5', 24, at('2026-09-20T10:00:00Z'))
    await bid('a9', 'B4', ['2026-09-28T09:00:00Z'], 0)
    await finish('a9', 'B4')
    // A10: publicada justo ANTES del periodo (48h, la cancelacion manual exige > 6h para el cierre)
    // y cancelada DENTRO con reembolso 1.5 CONFIRMADO.
    await publish('a10', 'S6', 48, at('2026-09-27T12:00:00Z'))
    await cancelManually('a10', 'S6', 1.5, at('2026-09-28T02:00:00Z'), 'CONFIRMED')
    // A11: 40 pujas de B5 en UNA subasta: un JOIN a auction_bids multiplicaria usuarios y comision.
    await publish('a11', 'S7', 24, at('2026-10-03T09:00:00Z'))
    await bid(
      'a11',
      'B5',
      Array.from(
        { length: 40 },
        (_, index) => `2026-10-03T09:${String(10 + index).padStart(2, '0')}:00Z`,
      ),
      0,
    )
    // Oficial (dinero real): ni usuario del mercado ni comision.
    await auctions.publishOfficial(officialCommand('o1', at('2026-09-29T09:00:00Z')))
    facts.push({
      id: 'o1',
      priceKind: 'REAL_MONEY',
      status: 'ACTIVE',
      publishedAt: at('2026-09-29T09:00:00Z'),
      closesAt: at('2026-09-30T09:00:00Z'),
      sellerId: 'upb-company',
      durationHours: 24,
      publicationFeeCredits: 0,
    })
  })

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('la base corre en una zona distinta de UTC', async () => {
    const zone = await sql<{ TimeZone: string }>`show timezone`.execute(db)

    expect(zone.rows[0]?.TimeZone).toBe('America/Bogota')
  })

  it('usuarios activos: cifras absolutas por SUBASTAS distintas, orden y desempate por bytes', async () => {
    const { activeUsers } = await snapshotOf(metrics)

    expect(activeUsers.totalActiveUsers).toBe(10) // S1 S2 S3 S4 S7 B1 B2 B3 B4 B5
    expect(activeUsers.byRole).toEqual({ sellers: 5, bidders: 5, buyers: 1 })
    expect(activeUsers.top).toEqual([
      { rank: 1, playerId: 'B2', activeAuctions: 3, asSeller: 0, asBidder: 3, asBuyer: 0 },
      { rank: 2, playerId: 'B1', activeAuctions: 2, asSeller: 0, asBidder: 2, asBuyer: 1 },
      { rank: 3, playerId: 'S1', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
      { rank: 4, playerId: 'S2', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
      { rank: 5, playerId: 'S3', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
      { rank: 6, playerId: 'S4', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
      { rank: 7, playerId: 'B3', activeAuctions: 1, asSeller: 0, asBidder: 1, asBuyer: 0 },
      { rank: 8, playerId: 'B4', activeAuctions: 1, asSeller: 0, asBidder: 1, asBuyer: 0 },
      { rank: 9, playerId: 'B5', activeAuctions: 1, asSeller: 0, asBidder: 1, asBuyer: 0 },
      { rank: 10, playerId: 'S7', activeAuctions: 1, asSeller: 1, asBidder: 0, asBuyer: 0 },
    ])
  })

  it('40 pujas de un usuario en una subasta cuentan UNA subasta y UNA comision (sin multiplicar filas)', async () => {
    const result = await snapshotOf(metrics)

    expect(result.activeUsers.top.find((user) => user.playerId === 'B5')).toMatchObject({
      activeAuctions: 1,
      asBidder: 1,
    })
    // a11 aporta 1 credito al bruto una sola vez, no 40.
    expect(result.commissions.byDuration[0]).toMatchObject({ durationHours: 24, auctions: 6 })
  })

  it('comisiones: bruto - reembolsado = neto, con pendientes y las automaticas fuera del reembolso', async () => {
    const { commissions } = await snapshotOf(metrics)

    expect(commissions).toEqual({
      scope: 'PUBLICATION_FEE_ONLY',
      unit: 'CREDITS',
      source: 'AUCTION_LOCAL',
      // 24h: a1 a3 a5 a6 a8 a11 = 6 x 1;  48h: a2 a4 a7 = 3 x 3  ->  6 + 9
      gross: { unit: 'CREDITS', amount: 15 },
      // CONFIRMED con cancelled_at en el periodo: a3 (0.5) + a10 (1.5); a5 es NOT_REQUIRED
      refunded: { unit: 'CREDITS', amount: 2 },
      net: { unit: 'CREDITS', amount: 13 },
      // PENDING a4 (1.5) + RETRYABLE a7 (1.5); a8 TERMINAL_ERROR no es pendiente
      pendingRefunds: { count: 2, amount: { unit: 'CREDITS', amount: 3 } },
      byDuration: [
        { durationHours: 24, auctions: 6, feePerAuction: 1, gross: { unit: 'CREDITS', amount: 6 } },
        { durationHours: 48, auctions: 3, feePerAuction: 3, gross: { unit: 'CREDITS', amount: 9 } },
      ],
      salesCommission: { availability: 'UNAVAILABLE', reason: 'NO_SALE_COMMISSION_DEFINED' },
      realMoneyCommission: {
        availability: 'UNAVAILABLE',
        reason: 'OFFICIAL_AUCTION_HAS_NO_FEES',
      },
      walletReconciliation: {
        availability: 'UNAVAILABLE',
        reason: 'WALLET_READ_ENDPOINT_NOT_AVAILABLE',
      },
    })
  })

  it('la cancelacion automatica queda en NOT_REQUIRED con reembolso 0 y su comision sigue en el neto', async () => {
    const row = await sql<{
      origin: string
      wallet_refund_status: string
      refund_amount_credits: string
    }>`
      select origin, wallet_refund_status, refund_amount_credits from auction_cancellations
      where auction_id = 'a5'
    `.execute(db)

    expect(row.rows[0]).toMatchObject({
      origin: 'TERMS_VIOLATION',
      wallet_refund_status: 'NOT_REQUIRED',
    })
    expect(Number(row.rows[0]?.refund_amount_credits)).toBe(0)
  })

  describe('REGLA ABIERTA: pujas en subastas canceladas (HU-90 CA-05)', () => {
    it('COMPORTAMIENTO ACTUAL: B3 solo puja en la cancelada a5 y cuenta como postor activo', async () => {
      const { activeUsers } = await snapshotOf(metrics)

      expect(activeUsers.top.find((user) => user.playerId === 'B3')).toMatchObject({
        activeAuctions: 1,
        asBidder: 1,
      })
      // B2 puja en a1, a5 (cancelada) y a6: tres subastas.
      expect(activeUsers.top.find((user) => user.playerId === 'B2')?.activeAuctions).toBe(3)
    })

    it('con la regla en false, PostgreSQL excluye las pujas en canceladas y conserva al VENDEDOR', async () => {
      const strict = new PostgresAuctionMetricsRepository(db, {
        countBidsOnCancelledAuctions: false,
      })

      const { activeUsers } = await snapshotOf(strict)

      expect(activeUsers.top.some((user) => user.playerId === 'B3')).toBe(false) // solo pujaba en a5
      expect(activeUsers.top.find((user) => user.playerId === 'B2')?.activeAuctions).toBe(2)
      expect(activeUsers.top.find((user) => user.playerId === 'S3')?.asSeller).toBe(2)
      expect(activeUsers.totalActiveUsers).toBe(9)
    })

    it('PARIDAD en ambos modos: PostgreSQL y memoria coinciden con la regla en true y en false', async () => {
      for (const countBidsOnCancelledAuctions of [true, false]) {
        const postgres = new PostgresAuctionMetricsRepository(db, { countBidsOnCancelledAuctions })
        const memory = memoryRepository({ countBidsOnCancelledAuctions })

        expect(await snapshotOf(postgres)).toEqual(await snapshotOf(memory))
      }
    })
  })

  it('un periodo sin datos devuelve sumas en 0, listas vacias y ambas duraciones', async () => {
    const empty = await reportOf(metrics).execute({
      from: '2025-01-01T00:00:00Z',
      to: '2025-01-08T00:00:00Z',
    })

    expect(empty.activeUsers).toMatchObject({
      totalActiveUsers: 0,
      byRole: { sellers: 0, bidders: 0, buyers: 0 },
      top: [],
    })
    expect(empty.commissions).toMatchObject({
      gross: { amount: 0 },
      refunded: { amount: 0 },
      net: { amount: 0 },
      pendingRefunds: { count: 0, amount: { amount: 0 } },
    })
    expect(empty.commissions.byDuration.map((row) => [row.durationHours, row.auctions])).toEqual([
      [24, 0],
      [48, 0],
    ])
  })

  it('PARIDAD: PostgreSQL y el adaptador en memoria devuelven exactamente lo mismo', async () => {
    const memory = memoryRepository()

    expect(await snapshotOf(metrics)).toEqual(await snapshotOf(memory))
    for (const range of [
      { from: '2026-09-29T00:00:00Z', to: '2026-10-01T00:00:00Z', limit: '3' },
      { from: '2026-09-01T00:00:00Z', to: '2026-09-28T00:00:00Z' },
      { from: '2025-01-01T00:00:00Z', to: '2025-01-08T00:00:00Z' },
    ]) {
      expect(await reportOf(metrics).execute(range)).toEqual(await reportOf(memory).execute(range))
    }
  })

  it('una consulta no modifica ninguna tabla (solo lectura)', async () => {
    const count = async (): Promise<number> => {
      const rows = await sql<{ total: number }>`
        select ((select count(*) from auctions) + (select count(*) from auction_bids)
              + (select count(*) from auction_buy_now_operations)
              + (select count(*) from auction_cancellations)
              + (select count(*) from auction_audit_log) + (select count(*) from outbox_events))::int as total
      `.execute(db)
      return rows.rows[0]?.total ?? -1
    }
    const before = await count()

    await snapshotOf(metrics)

    expect(await count()).toBe(before)
  })

  describe('idempotencia (contrato §5): un reintento con el mismo operationId no cambia el agregado', () => {
    it('publicacion, compra inmediata, cancelacion manual y cancelacion automatica repetidas', async () => {
      const before = await snapshotOf(metrics)

      const publishReplay = await auctions.publish(
        publishCommand('a1', 'S1', 24, at('2026-09-28T10:00:00Z')),
      )
      const buyNowReplay = await auctions.closeByBuyNow(
        buyNowCommand('a2', 'B1', at('2026-09-29T12:00:00Z')),
      )
      const manualReplay = await auctions.cancelAuction(
        cancelCommand('a3', 'S2', 0.5, at('2026-09-30T11:00:00Z')),
      )
      const automaticReplay = await auctions.cancelAuctionAutomatically(
        automaticCommand('a5', at('2026-10-02T12:00:00Z')),
      )

      expect([
        publishReplay.replayed,
        buyNowReplay.replayed,
        manualReplay.replayed,
        automaticReplay.replayed,
      ]).toEqual([true, true, true, true])
      expect(await snapshotOf(metrics)).toEqual(before)
    })

    it('publicacion oficial repetida', async () => {
      const before = await snapshotOf(metrics)

      const replay = await auctions.publishOfficial(
        officialCommand('o1', at('2026-09-29T09:00:00Z')),
      )

      expect(replay.replayed).toBe(true)
      expect(await snapshotOf(metrics)).toEqual(before)
    })

    it('tras los reintentos, PostgreSQL sigue en paridad con la memoria', async () => {
      expect(await snapshotOf(metrics)).toEqual(await snapshotOf(memoryRepository()))
    })
  })
})
