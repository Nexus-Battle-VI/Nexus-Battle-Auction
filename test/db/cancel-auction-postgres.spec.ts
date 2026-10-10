import { randomUUID } from 'node:crypto'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  ConcurrentBidConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import { AuctionAlreadyClosedError } from '../../src/application/errors/BuyNowTransactionError'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import { BidRuleCode, BidRuleViolation } from '../../src/domain/errors/BidRuleViolation'
import { Auction, AuctionStatus } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

/**
 * HU-90 (PR3), `7.7.10`. Persistencia y concurrencia REALES de la
 * cancelacion manual. `CancelAuction` (Wallet/Inventory) se prueba en
 * `test/unit/cancel-auction.spec.ts` e integracion HTTP; aqui solo
 * `AuctionRepositoryPort.cancelAuction` contra PostgreSQL de verdad, y su
 * interaccion con `persistBid`/`closeByBuyNow`/`findSettlementCandidates`.
 */
describe('Cancelacion manual contra PostgreSQL real (HU-90)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresAuctionRepository

  const now = new Date('2026-09-21T15:00:00.000Z')

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri(), maxConnections: 20 })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error !== undefined) throw new Error('La migracion fallo.')
    repository = new PostgresAuctionRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const seedAuction = async (
    auctionId: string,
    options: { durationHours?: 24 | 48; publishedAt?: Date } = {},
  ): Promise<void> => {
    // `product_id` debe ser unico por subasta ACTIVA (`auctions_active_product_uq`):
    // un `product-1` compartido entre pruebas de este mismo archivo chocaria
    // en cuanto una subasta anterior quedara ACTIVA (p.ej. porque su propia
    // cancelacion fue rechazada a proposito).
    const auction = Auction.publish({
      auctionId,
      sellerId: 'seller-1',
      productId: `product:${auctionId}`,
      durationHours: options.durationHours ?? 24,
      minimumBidCredits: 10,
      publishedAt: options.publishedAt ?? now,
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })
    await repository.publish({
      operationId: `publish:${auctionId}`,
      auction,
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
    })
  }

  /** Mas de 6h restantes desde `now` (publicada en `now`, 24h de duracion). */
  const cancelCommand = (auctionId: string, operationId = `cancel:${auctionId}`) => ({
    operationId,
    auctionId,
    sellerId: 'seller-1',
    productId: `product:${auctionId}`,
    cancelledAt: now,
    inventoryCommitmentId: `commitment:${auctionId}`,
    feeChargeId: `charge:${auctionId}`,
    refundAmountCredits: 0.5,
    walletRefundOperationId: `wallet-refund:${auctionId}`,
    inventoryReleaseOperationId: `inventory-release:${auctionId}`,
  })

  // 11/17. ACTIVE -> CANCELLED CAS, persistido de verdad.
  it('transiciona ACTIVE -> CANCELLED y persiste cancelled_at', async () => {
    const auctionId = 'cancel-cas-1'
    await seedAuction(auctionId)

    const result = await repository.cancelAuction(cancelCommand(auctionId))

    expect(result.replayed).toBe(false)
    expect(result.auction.status).toBe(AuctionStatus.Cancelled)
    expect(result.auction.cancelledAt).toEqual(now)

    const row = await db
      .selectFrom('auctions')
      .select(['status', 'cancelled_at'])
      .where('id', '=', auctionId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('CANCELLED')
    expect(row.cancelled_at).not.toBeNull()

    const tracking = await db
      .selectFrom('auction_cancellations')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .executeTakeFirstOrThrow()
    expect(tracking.wallet_refund_status).toBe('PENDING')
    expect(tracking.inventory_release_status).toBe('PENDING')
    expect(Number(tracking.refund_amount_credits)).toBe(0.5)
  })

  it('un replay con el mismo operationId no vuelve a tocar auctions ni crea una segunda fila de seguimiento', async () => {
    const auctionId = 'cancel-replay-1'
    await seedAuction(auctionId)
    const command = cancelCommand(auctionId)

    const first = await repository.cancelAuction(command)
    const second = await repository.cancelAuction(command)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    const rows = await db
      .selectFrom('auction_cancellations')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .execute()
    expect(rows).toHaveLength(1)
  })

  it('rechaza cancelar dos veces con operationId distintos (segunda vez: AUCTION_NOT_ACTIVE)', async () => {
    const auctionId = 'cancel-twice-1'
    await seedAuction(auctionId)
    await repository.cancelAuction(cancelCommand(auctionId, 'cancel-op-1'))

    await expect(
      repository.cancelAuction(cancelCommand(auctionId, 'cancel-op-2')),
    ).rejects.toMatchObject({ code: AuctionRuleCode.AuctionNotActive })
  })

  it('rechaza cancelar con pujas registradas (AUCTION_HAS_BIDS) sin tocar el estado', async () => {
    const auctionId = 'cancel-has-bids-1'
    await seedAuction(auctionId)
    await repository.persistBid(
      Bid.restore({
        id: 'bid-1',
        auctionId,
        bidderId: 'bidder-1',
        amountCredits: 10,
        placedAt: now,
      }),
    )

    await expect(repository.cancelAuction(cancelCommand(auctionId))).rejects.toMatchObject({
      code: AuctionRuleCode.AuctionHasBids,
    })
    await expect(repository.findById(auctionId)).resolves.toMatchObject({
      status: AuctionStatus.Active,
    })
  })

  it('rechaza cancelar a 6h o menos del cierre (7.7.10)', async () => {
    const auctionId = 'cancel-window-1'
    // Publicada 18h antes de `now` con 24h de duracion -> quedan exactamente 6h.
    await seedAuction(auctionId, { publishedAt: new Date(now.getTime() - 18 * 60 * 60 * 1000) })

    await expect(repository.cancelAuction(cancelCommand(auctionId))).rejects.toMatchObject({
      code: AuctionRuleCode.AuctionCancellationWindowClosed,
    })
  })

  it('rechaza cancelar una subasta inexistente', async () => {
    await expect(
      repository.cancelAuction(cancelCommand('cancel-missing-1')),
    ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)
  })

  // 12. settlement no selecciona CANCELLED.
  it('findSettlementCandidates excluye una subasta CANCELLED', async () => {
    const auctionId = 'cancel-settlement-exclude-1'
    await seedAuction(auctionId, { publishedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000) })
    // Solo se necesita una fila CANCELLED en `auctions`: la regla de ventana
    // de 6h ya se prueba por separado contra `cancelAuction()` arriba, asi
    // que aqui se fuerza el CAS directo por SQL en vez de pasar por ella.
    await sql`update auctions set status='CANCELLED', cancelled_at=${now} where id=${auctionId}`.execute(
      db,
    )

    const candidates = await repository.findSettlementCandidates(
      new Date(now.getTime() + 72 * 60 * 60 * 1000),
    )
    expect(candidates.find((candidate) => candidate.auctionId === auctionId)).toBeUndefined()
  })

  // 13. bid sobre CANCELLED rechazado.
  it('rechaza una puja sobre una subasta CANCELLED (mismo guard que no-ACTIVE)', async () => {
    const auctionId = 'cancel-then-bid-1'
    await seedAuction(auctionId)
    await repository.cancelAuction(cancelCommand(auctionId))

    await expect(
      repository.persistBid(
        Bid.restore({
          id: 'bid-after-cancel',
          auctionId,
          bidderId: 'bidder-1',
          amountCredits: 10,
          placedAt: now,
        }),
      ),
    ).rejects.toBeInstanceOf(ConcurrentBidConflictError)
  })

  // 14. buy-now sobre CANCELLED rechazado.
  it('rechaza una compra inmediata sobre una subasta CANCELLED', async () => {
    const auctionId = 'cancel-then-buy-now-1'
    await seedAuction(auctionId)
    await repository.cancelAuction(cancelCommand(auctionId))

    await expect(
      repository.closeByBuyNow({
        operationId: 'buy-now-after-cancel',
        transactionId: 'txn-1',
        auctionId,
        buyerId: 'buyer-1',
        transferId: 'transfer-1',
        priceCredits: 100,
        remainingCredits: 0,
        closedAt: now,
      }),
    ).rejects.toBeInstanceOf(AuctionAlreadyClosedError)
  })

  // 15/16. cancel vs bid: mismo advisory lock, nunca un resultado entrelazado.
  it('serializa cancel contra una puja concurrente por la MISMA subasta sin dejar un estado a medias', async () => {
    const auctionId = 'cancel-vs-bid-race-1'
    await seedAuction(auctionId)

    const [cancelOutcome, bidOutcome] = await Promise.allSettled([
      repository.cancelAuction(cancelCommand(auctionId)),
      repository.persistBid(
        Bid.restore({
          id: 'bid-race-1',
          auctionId,
          bidderId: 'bidder-1',
          amountCredits: 10,
          placedAt: now,
        }),
      ),
    ])

    const persisted = await repository.findById(auctionId)
    const bidCount = await repository.countBids(auctionId)

    if (cancelOutcome.status === 'fulfilled') {
      // La cancelacion ganó la carrera: no debe existir ninguna puja, y la
      // puja debe haber sido rechazada por el mismo guard de concurrencia
      // que el analisis previo identifico como el hueco a cerrar.
      expect(persisted?.status).toBe(AuctionStatus.Cancelled)
      expect(bidCount).toBe(0)
      expect(bidOutcome.status).toBe('rejected')
      if (bidOutcome.status === 'rejected') {
        expect(bidOutcome.reason).toBeInstanceOf(ConcurrentBidConflictError)
      }
    } else {
      // La puja ganó: la cancelacion debe haber sido rechazada por
      // AUCTION_HAS_BIDS (o, si corrio tan rapido que ni la vio, por
      // AUCTION_NOT_ACTIVE si tambien hubiera una settlement de por medio;
      // en esta prueba solo hay una puja, asi que HAS_BIDS es el unico
      // resultado posible).
      expect(persisted?.status).toBe(AuctionStatus.Active)
      expect(bidCount).toBe(1)
      expect(cancelOutcome.reason).toBeInstanceOf(AuctionRuleViolation)
      expect((cancelOutcome.reason as AuctionRuleViolation).code).toBe(
        AuctionRuleCode.AuctionHasBids,
      )
    }

    // Nunca ambos: una subasta cancelada CON una puja persistida seria el
    // estado "a medias" que esta prueba existe para descartar.
    expect(persisted?.status === AuctionStatus.Cancelled && bidCount > 0).toBe(false)
  })

  it('el guard de persistBid reutiliza BidRuleCode.AuctionNotActive en la capa de dominio para el mismo caso', () => {
    // Documenta la equivalencia semantica entre el rechazo de dominio (lectura
    // previa al lock) y el de repositorio (bajo el lock): ambos comunican
    // "la subasta ya no esta activa" al llamador, con distinto vehiculo.
    expect(BidRuleCode.AuctionNotActive).toBe('AUCTION_NOT_ACTIVE')
    expect(new BidRuleViolation(BidRuleCode.AuctionNotActive, 'x').code).toBe(
      BidRuleCode.AuctionNotActive,
    )
  })

  // 18. La migracion acepta CANCELLED sobre un esquema ya poblado.
  it('la migracion 017 se aplica sobre un esquema 001-016 con datos sin perderlos', async () => {
    const upgradeContainer = await new PostgreSqlContainer('postgres:17-alpine').start()
    const upgradeDb = createDatabase({ connectionString: upgradeContainer.getConnectionUri() })
    try {
      const preMigration017 = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < '017'),
      )
      const before = await migrateToLatest(upgradeDb, preMigration017)
      expect(before.error).toBeUndefined()
      // El migrador aplica en orden alfabetico de clave, no en orden de
      // insercion del objeto: "003-add-..." antes que "003-create-...".
      expect(before.applied).toEqual(Object.keys(preMigration017).sort())

      const existingAuctionId = randomUUID()
      await sql`
        insert into auctions (
          id, seller_id, product_id, duration_hours, publisher_type, price_kind,
          publication_fee_credits, minimum_bid_credits, status, published_at, closes_at,
          inventory_commitment_id, fee_charge_id
        ) values (
          ${existingAuctionId}, 'seller-pre-017', 'product-pre-017', 24, 'PLAYER', 'CREDITS',
          1, 10, 'ACTIVE', ${now}, ${new Date(now.getTime() + 24 * 60 * 60 * 1000)},
          'commitment-pre-017', 'charge-pre-017'
        )
      `.execute(upgradeDb)

      const after = await migrateToLatest(upgradeDb, MIGRATIONS)
      expect(after.error).toBeUndefined()
      expect(after.applied).toEqual([
        '017-create-auction-cancellation',
        '018-add-auction-cancellation-reconciler-lease',
        '019-add-auction-metrics-indexes',
        '020-add-automatic-auction-cancellation',
        '021-add-auction-realtime-revision',
      ])

      const preserved = await sql<{
        status: string
        cancelled_at: Date | null
      }>`select status, cancelled_at from auctions where id=${existingAuctionId}`.execute(upgradeDb)
      expect(preserved.rows[0]).toEqual({ status: 'ACTIVE', cancelled_at: null })

      // El CHECK nuevo admite CANCELLED con cancelled_at, y lo exige.
      await expect(
        sql`update auctions set status='CANCELLED' where id=${existingAuctionId}`.execute(
          upgradeDb,
        ),
      ).rejects.toThrow()
      await sql`update auctions set status='CANCELLED', cancelled_at=${now} where id=${existingAuctionId}`.execute(
        upgradeDb,
      )
      const cancelled = await sql<{ status: string }>`
        select status from auctions where id=${existingAuctionId}
      `.execute(upgradeDb)
      expect(cancelled.rows[0]?.status).toBe('CANCELLED')
    } finally {
      await upgradeDb.destroy()
      await upgradeContainer.stop()
    }
  }, 120_000)
})
