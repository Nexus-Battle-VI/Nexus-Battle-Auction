import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresAuctionCancellationRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionCancellationRepository'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import { AuctionAlreadyClosedError } from '../../src/application/errors/BuyNowTransactionError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { AuctionCancellationEffectStatus } from '../../src/application/ports/AuctionCancellationRepositoryPort'
import type {
  AuctionWalletPort,
  CaptureAuctionHoldCommand,
  ReleaseAuctionHoldCommand,
  WalletHoldOutcome,
  WalletHoldResult,
} from '../../src/application/ports/AuctionWalletPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  ChargePublicationFeeCommand,
  PublicationFeeCharge,
  PublicationFeePort,
} from '../../src/application/ports/PublicationFeePort'
import {
  inventoryCancellationReleaseOperationId,
  type ClaimedInventoryProductCommitment,
  type InventoryProductCommitment,
  type InventoryProductEligibility,
  type PendingClaimInventoryProductCommitment,
  type ProductInventoryPort,
  type ReleasedInventoryProductCommitment,
  type ReleaseInventoryProductCommand,
} from '../../src/application/ports/ProductInventoryPort'
import { AuctionCancellationEffectsResolver } from '../../src/application/use-cases/AuctionCancellationEffectsResolver'
import {
  AuctionCancellationReconciler,
  type AuctionCancellationReconcilerLogger,
} from '../../src/application/use-cases/AuctionCancellationReconciler'
import { CancelAuction } from '../../src/application/use-cases/CancelAuction'
import {
  AutomaticCancellationOutcome,
  automaticCancellationOperationId,
  CancelAuctionAutomatically,
} from '../../src/application/use-cases/CancelAuctionAutomatically'
import { Auction, AuctionStatus } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

class StubClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

class StubWallet implements AuctionWalletPort {
  readonly releaseCalls: ReleaseAuctionHoldCommand[] = []
  readonly captureCalls: CaptureAuctionHoldCommand[] = []
  readonly outcomes = new Map<string, WalletHoldOutcome>()

  captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> {
    this.captureCalls.push(command)
    return Promise.reject(new Error('Una cancelacion nunca captura.'))
  }

  releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> {
    this.releaseCalls.push(command)
    const outcome = this.outcomes.get(command.holdId) ?? 'SUCCESS'
    return Promise.resolve(
      outcome === 'SUCCESS'
        ? {
            outcome,
            operationId: command.operationId,
            holdId: command.holdId,
            holdStatus: 'RELEASED',
            applied: true,
          }
        : { outcome, operationId: command.operationId, holdId: command.holdId },
    )
  }
}

class StubInventory implements ProductInventoryPort {
  readonly releaseCalls: ReleaseInventoryProductCommand[] = []
  unavailable = false

  inspect(): Promise<InventoryProductEligibility> {
    throw new Error('No usado en estos tests.')
  }

  commit(): Promise<InventoryProductCommitment> {
    throw new Error('No usado en estos tests.')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async release(
    command: ReleaseInventoryProductCommand,
  ): Promise<ReleasedInventoryProductCommitment> {
    this.releaseCalls.push(command)
    if (this.unavailable) throw new ExternalDependencyUnavailableError('player-inventory')
    return {
      operationId: command.operationId,
      commitmentId: command.commitmentId,
      status: 'RELEASED',
      applied: true,
    }
  }

  markPendingClaim(): Promise<PendingClaimInventoryProductCommitment> {
    throw new Error('No usado en estos tests.')
  }

  confirmClaim(): Promise<ClaimedInventoryProductCommitment> {
    throw new Error('No usado en estos tests.')
  }
}

class StubPublicationFeePort implements PublicationFeePort {
  readonly refundCalls: { operationId: string; chargeId: string; amount: number }[] = []

  charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge> {
    void command
    throw new Error('No usado en estos tests.')
  }

  refund(operationId: string, chargeId: string, amount: number): Promise<void> {
    this.refundCalls.push({ operationId, chargeId, amount })
    return Promise.resolve()
  }
}

const silentLogger: AuctionCancellationReconcilerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * HU-90, CA-05. Persistencia y concurrencia REALES de la cancelacion
 * automatica: `cancelAuctionAutomatically`, las consultas del sondeo, la
 * migracion 019 y el reclamo del reconciler contra PostgreSQL de verdad.
 */
describe('Cancelacion automatica contra PostgreSQL real (HU-90, CA-05)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresAuctionRepository
  let cancellations: PostgresAuctionCancellationRepository

  const now = new Date('2026-09-21T15:00:00.000Z')
  const sanctionId = 'sanction-1'

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri(), maxConnections: 20 })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error !== undefined) throw new Error('La migracion fallo.')
    repository = new PostgresAuctionRepository(db)
    cancellations = new PostgresAuctionCancellationRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  /** Un vendedor por subasta salvo que se indique: el limite es 10 activas por vendedor. */
  const seedAuction = async (
    auctionId: string,
    options: { sellerId?: string; publishedAt?: Date; durationHours?: 24 | 48 } = {},
  ): Promise<void> => {
    await repository.publish({
      operationId: `publish:${auctionId}`,
      auction: Auction.publish({
        auctionId,
        sellerId: options.sellerId ?? `seller:${auctionId}`,
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
      }),
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
    })
  }

  /** Puja con reserva por el mismo camino durable que `PersistBidWithCredits`. */
  const placeBid = async (
    auctionId: string,
    index: number,
    options: { completed?: boolean } = {},
  ): Promise<string> => {
    const operationId = `${auctionId}:bid-op-${String(index)}`
    const bidId = `${auctionId}:bid-${String(index)}`
    const reservationId = `${auctionId}:hold-${String(index)}`
    const bidderId = `bidder-${String(index)}`
    const amountCredits = 10 * index
    await repository.createBidCreditOperation({
      operationId,
      bidId,
      auctionId,
      bidderId,
      amountCredits,
      createdAt: now,
    })
    await repository.updateBidCreditOperation({
      operationId,
      status: 'RESERVED',
      reservationId,
      previousReservationId: null,
      updatedAt: now,
    })
    const persisted = await repository.persistBid(
      Bid.restore({ id: bidId, auctionId, bidderId, amountCredits, placedAt: now }),
      reservationId,
      operationId,
    )
    if (options.completed ?? true) {
      await repository.updateBidCreditOperation({
        operationId,
        status: 'COMPLETED',
        reservationId,
        previousReservationId: persisted.previousLeaderReservationId,
        updatedAt: now,
      })
    }
    return reservationId
  }

  const automaticCommand = (auctionId: string, sanction = sanctionId, cancelledAt = now) => ({
    operationId: automaticCancellationOperationId(sanction, auctionId),
    auctionId,
    triggerReferenceId: sanction,
    cancelledAt,
    inventoryReleaseOperationId: inventoryCancellationReleaseOperationId(auctionId),
  })

  const manualCommand = (auctionId: string) => ({
    operationId: `manual-cancel:${auctionId}`,
    auctionId,
    sellerId: `seller:${auctionId}`,
    productId: `product:${auctionId}`,
    cancelledAt: now,
    inventoryCommitmentId: `commitment:${auctionId}`,
    feeChargeId: `charge:${auctionId}`,
    refundAmountCredits: 0.5,
    walletRefundOperationId: `wallet-refund:${auctionId}`,
    inventoryReleaseOperationId: inventoryCancellationReleaseOperationId(auctionId),
  })

  const countRows = async (
    table:
      | 'auction_cancellations'
      | 'auction_cancellation_operations'
      | 'auction_cancellation_reservation_releases'
      | 'auction_audit_log',
    auctionId: string,
  ): Promise<number> => {
    const row = await db
      .selectFrom(table)
      .select(sql<number>`count(*)::integer`.as('total'))
      .where('auction_id', '=', auctionId)
      .executeTakeFirstOrThrow()
    return row.total
  }

  const cancelledEvents = async (auctionId: string) =>
    db
      .selectFrom('outbox_events')
      .select(['id', 'payload'])
      .where('aggregate_id', '=', auctionId)
      .where('event_type', '=', 'auction.cancelled.v1')
      .execute()

  const useCases = () => {
    const wallet = new StubWallet()
    const inventory = new StubInventory()
    const fees = new StubPublicationFeePort()
    const clock = new StubClock(now)
    const automatic = new CancelAuctionAutomatically(
      repository,
      cancellations,
      wallet,
      inventory,
      clock,
    )
    const manual = new CancelAuction(repository, cancellations, fees, inventory, clock)
    const reconciler = new AuctionCancellationReconciler(
      cancellations,
      new AuctionCancellationEffectsResolver(manual, automatic),
      clock,
      silentLogger,
      { batchSize: 100, leaseMs: 60_000, workerId: 'worker-1' },
    )
    // La base es compartida por todo el archivo: el reconciler tambien
    // procesa cancelaciones que dejaron pendientes otras pruebas, asi que las
    // aserciones filtran siempre por la subasta de la prueba.
    const walletCallsFor = (auctionId: string) =>
      wallet.releaseCalls.filter((call) => call.holdId.startsWith(`${auctionId}:`))
    const inventoryCallsFor = (auctionId: string) =>
      inventory.releaseCalls.filter((call) => call.auctionId === auctionId)
    return {
      wallet,
      inventory,
      fees,
      clock,
      automatic,
      manual,
      reconciler,
      walletCallsFor,
      inventoryCallsFor,
    }
  }

  describe('consultas del sondeo', () => {
    it('listActiveSellerIds devuelve vendedores unicos con subastas ACTIVE, paginados por cursor', async () => {
      await seedAuction('poll-a-1', { sellerId: 'poll-seller-a' })
      await seedAuction('poll-a-2', { sellerId: 'poll-seller-a' })
      await seedAuction('poll-b-1', { sellerId: 'poll-seller-b' })
      await seedAuction('poll-c-1', { sellerId: 'poll-seller-c' })
      await seedAuction('poll-d-1', { sellerId: 'poll-seller-d' })
      // poll-seller-d deja de tener subastas activas.
      await repository.cancelAuctionAutomatically(automaticCommand('poll-d-1'))

      const all = await repository.listActiveSellerIds({ afterSellerId: null, limit: 500 })
      const polled = all.filter((sellerId) => sellerId.startsWith('poll-seller-'))
      expect(polled).toEqual(['poll-seller-a', 'poll-seller-b', 'poll-seller-c'])
      expect(new Set(all).size).toBe(all.length)

      const firstPage = await repository.listActiveSellerIds({
        afterSellerId: 'poll-seller-',
        limit: 2,
      })
      expect(firstPage).toEqual(['poll-seller-a', 'poll-seller-b'])
      const secondPage = await repository.listActiveSellerIds({
        afterSellerId: 'poll-seller-b',
        limit: 1,
      })
      expect(secondPage).toEqual(['poll-seller-c'])
    })

    it('listActiveAuctionIdsBySeller devuelve solo las ACTIVE de ese vendedor', async () => {
      await seedAuction('by-seller-1', { sellerId: 'by-seller' })
      await seedAuction('by-seller-2', { sellerId: 'by-seller' })
      await seedAuction('by-seller-3', { sellerId: 'by-seller' })
      await seedAuction('by-other-1', { sellerId: 'by-other' })
      await repository.cancelAuctionAutomatically(automaticCommand('by-seller-2'))

      await expect(repository.listActiveAuctionIdsBySeller('by-seller')).resolves.toEqual([
        'by-seller-1',
        'by-seller-3',
      ])
      await expect(repository.listActiveAuctionIdsBySeller('nobody')).resolves.toEqual([])
    })
  })

  describe('transicion y seguimiento', () => {
    it('sin pujas: ACTIVE -> CANCELLED con origen, sancion, sin refund y un solo evento', async () => {
      const auctionId = 'auto-no-bids-1'
      await seedAuction(auctionId)

      const result = await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      expect(result.replayed).toBe(false)
      expect(result.auction.status).toBe(AuctionStatus.Cancelled)
      expect(result.auction.cancelledAt).toEqual(now)
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        operationId: `automatic-cancellation:${sanctionId}:${auctionId}`,
        origin: 'TERMS_VIOLATION',
        triggerReferenceId: sanctionId,
        sellerId: `seller:${auctionId}`,
        productId: `product:${auctionId}`,
        inventoryCommitmentId: `commitment:${auctionId}`,
        feeChargeId: null,
        refundAmountCredits: 0,
        walletRefundOperationId: null,
        walletRefundStatus: AuctionCancellationEffectStatus.NotRequired,
        inventoryReleaseOperationId: `auction:${auctionId}:cancellation:inventory-release`,
        inventoryReleaseStatus: AuctionCancellationEffectStatus.Pending,
        reservationReleases: [],
      })

      const events = await cancelledEvents(auctionId)
      expect(events).toHaveLength(1)
      expect(events[0]?.id).toBe(`auction:${auctionId}:cancelled`)
      expect(events[0]?.payload).toMatchObject({
        eventType: 'auction.cancelled',
        eventVersion: 1,
        data: {
          auctionId,
          sellerId: `seller:${auctionId}`,
          productId: `product:${auctionId}`,
          cancelledAt: now.toISOString(),
          origin: 'TERMS_VIOLATION',
          triggerReferenceId: sanctionId,
        },
      })

      const audit = await db
        .selectFrom('auction_audit_log')
        .select(['action', 'actor_id', 'details'])
        .where('auction_id', '=', auctionId)
        .where('action', '=', 'AUCTION_CANCELLED')
        .executeTakeFirstOrThrow()
      expect(audit.actor_id).toBe('system:auction-terms-violation')
      expect(audit.details).toEqual({
        origin: 'TERMS_VIOLATION',
        triggerReferenceId: sanctionId,
        reservationReleases: 0,
      })
    })

    it('con pujas y dentro de las ultimas 6 horas: cancela y deja un release por reserva viva', async () => {
      const auctionId = 'auto-with-bids-1'
      // Publicada hace 23h con 24h de duracion: queda 1h, la manual lo rechazaria.
      await seedAuction(auctionId, { publishedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000) })
      await placeBid(auctionId, 1)
      // El release del lider superado (hold-1) se confirmo; el de hold-2 no.
      await placeBid(auctionId, 2)
      await placeBid(auctionId, 3, { completed: false })

      const result = await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      expect(result.auction.status).toBe(AuctionStatus.Cancelled)
      const tracking = await cancellations.getByAuctionId(auctionId)
      expect(tracking?.reservationReleases).toEqual([
        {
          reservationId: `${auctionId}:hold-2`,
          operationId: `auction:${auctionId}:cancellation:reservation:${auctionId}:hold-2:release`,
          status: AuctionCancellationEffectStatus.Pending,
          lastError: null,
          updatedAt: now,
        },
        {
          reservationId: `${auctionId}:hold-3`,
          operationId: `auction:${auctionId}:cancellation:reservation:${auctionId}:hold-3:release`,
          status: AuctionCancellationEffectStatus.Pending,
          lastError: null,
          updatedAt: now,
        },
      ])
      // Sin ganador ni cierre de liquidacion.
      const row = await db
        .selectFrom('auctions')
        .select(['status', 'winner_id', 'winning_bid_id', 'finished_at', 'closing_result_type'])
        .where('id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(row).toEqual({
        status: 'CANCELLED',
        winner_id: null,
        winning_bid_id: null,
        finished_at: null,
        closing_result_type: null,
      })
    })

    it('la cancelacion manual sigue rechazando pujas y ventana, y persiste origen MANUAL', async () => {
      const withBids = 'manual-still-strict-1'
      await seedAuction(withBids)
      await placeBid(withBids, 1)
      await expect(repository.cancelAuction(manualCommand(withBids))).rejects.toMatchObject({
        code: AuctionRuleCode.AuctionHasBids,
      })

      const plain = 'manual-origin-1'
      await seedAuction(plain)
      await repository.cancelAuction(manualCommand(plain))

      await expect(cancellations.getByAuctionId(plain)).resolves.toMatchObject({
        origin: 'MANUAL',
        triggerReferenceId: null,
        refundAmountCredits: 0.5,
        walletRefundOperationId: `wallet-refund:${plain}`,
        walletRefundStatus: AuctionCancellationEffectStatus.Pending,
        reservationReleases: [],
      })
      const events = await cancelledEvents(plain)
      expect(events[0]?.payload).toMatchObject({
        data: { origin: 'MANUAL', triggerReferenceId: null },
      })
    })

    it('rechaza una subasta inexistente', async () => {
      await expect(
        repository.cancelAuctionAutomatically(automaticCommand('auto-missing-1')),
      ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)
    })
  })

  describe('idempotencia', () => {
    it('el replay de la misma sancion no duplica estado, seguimiento, releases, auditoria ni outbox', async () => {
      const auctionId = 'auto-replay-1'
      await seedAuction(auctionId)
      await placeBid(auctionId, 1)
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      const later = new Date(now.getTime() + 30_000)
      const replay = await repository.cancelAuctionAutomatically(
        automaticCommand(auctionId, sanctionId, later),
      )

      expect(replay.replayed).toBe(true)
      expect(replay.auction.cancelledAt).toEqual(now)
      await expect(countRows('auction_cancellations', auctionId)).resolves.toBe(1)
      await expect(countRows('auction_cancellation_operations', auctionId)).resolves.toBe(1)
      await expect(countRows('auction_cancellation_reservation_releases', auctionId)).resolves.toBe(
        1,
      )
      const audits = await db
        .selectFrom('auction_audit_log')
        .select('id')
        .where('auction_id', '=', auctionId)
        .where('action', '=', 'AUCTION_CANCELLED')
        .execute()
      expect(audits).toHaveLength(1)
      await expect(cancelledEvents(auctionId)).resolves.toHaveLength(1)
    })

    it('otra sancion sobre una subasta ya cancelada se rechaza con AUCTION_NOT_ACTIVE', async () => {
      const auctionId = 'auto-second-sanction-1'
      await seedAuction(auctionId)
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      await expect(
        repository.cancelAuctionAutomatically(automaticCommand(auctionId, 'sanction-2')),
      ).rejects.toMatchObject({ code: AuctionRuleCode.AuctionNotActive })
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        triggerReferenceId: sanctionId,
      })
      await expect(cancelledEvents(auctionId)).resolves.toHaveLength(1)
    })

    it('el mismo operationId con otra solicitud es un conflicto de idempotencia', async () => {
      const auctionId = 'auto-conflict-1'
      await seedAuction(auctionId)
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      await expect(
        repository.cancelAuctionAutomatically({
          ...automaticCommand(auctionId),
          triggerReferenceId: 'otra-sancion',
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
    })

    it('varios workers a la vez (misma y distinta sancion): una sola transicion y un solo evento', async () => {
      const auctionId = 'auto-multi-worker-1'
      await seedAuction(auctionId)
      await placeBid(auctionId, 1)

      const outcomes = await Promise.allSettled([
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
        repository.cancelAuctionAutomatically(automaticCommand(auctionId, 'sanction-2')),
        repository.cancelAuctionAutomatically(automaticCommand(auctionId, 'sanction-3')),
      ])

      const applied = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled' && !outcome.value.replayed,
      )
      expect(applied).toHaveLength(1)
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(AuctionRuleViolation)
          expect((outcome.reason as AuctionRuleViolation).code).toBe(
            AuctionRuleCode.AuctionNotActive,
          )
        }
      }
      await expect(countRows('auction_cancellations', auctionId)).resolves.toBe(1)
      await expect(countRows('auction_cancellation_operations', auctionId)).resolves.toBe(1)
      await expect(countRows('auction_cancellation_reservation_releases', auctionId)).resolves.toBe(
        1,
      )
      await expect(cancelledEvents(auctionId)).resolves.toHaveLength(1)
    })
  })

  describe('carreras con otras transiciones', () => {
    it('automatica vs puja: o la puja entra antes y su reserva queda en el plan, o se rechaza', async () => {
      const auctionId = 'auto-vs-bid-1'
      await seedAuction(auctionId)
      const operationId = `${auctionId}:race-op`
      const reservationId = `${auctionId}:race-hold`
      const bidId = `${auctionId}:race-bid`
      await repository.createBidCreditOperation({
        operationId,
        bidId,
        auctionId,
        bidderId: 'bidder-race',
        amountCredits: 10,
        createdAt: now,
      })
      await repository.updateBidCreditOperation({
        operationId,
        status: 'RESERVED',
        reservationId,
        previousReservationId: null,
        updatedAt: now,
      })

      const [cancelOutcome, bidOutcome] = await Promise.allSettled([
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
        repository.persistBid(
          Bid.restore({
            id: bidId,
            auctionId,
            bidderId: 'bidder-race',
            amountCredits: 10,
            placedAt: now,
          }),
          reservationId,
          operationId,
        ),
      ])

      // La automatica no depende de las pujas: siempre gana la transicion.
      expect(cancelOutcome.status).toBe('fulfilled')
      await expect(repository.findById(auctionId)).resolves.toMatchObject({
        status: AuctionStatus.Cancelled,
      })
      if (bidOutcome.status === 'rejected') {
        expect(bidOutcome.reason).toBeInstanceOf(ConcurrentBidConflictError)
        await expect(repository.countBids(auctionId)).resolves.toBe(0)
      } else {
        await expect(repository.countBids(auctionId)).resolves.toBe(1)
      }
      // En ambos casos la reserva ya creada en Wallet queda con seguimiento:
      // ningun credito se queda retenido sin release.
      const tracking = await cancellations.getByAuctionId(auctionId)
      expect(tracking?.reservationReleases.map((release) => release.reservationId)).toEqual([
        reservationId,
      ])
    })

    it('una puja posterior a la cancelacion automatica se rechaza', async () => {
      const auctionId = 'auto-then-bid-1'
      await seedAuction(auctionId)
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      await expect(
        repository.persistBid(
          Bid.restore({
            id: `${auctionId}:late-bid`,
            auctionId,
            bidderId: 'bidder-late',
            amountCredits: 10,
            placedAt: now,
          }),
        ),
      ).rejects.toBeInstanceOf(ConcurrentBidConflictError)
    })

    it('automatica vs compra inmediata: exactamente una transicion terminal', async () => {
      const auctionId = 'auto-vs-buy-now-1'
      await seedAuction(auctionId)

      const [cancelOutcome, buyNowOutcome] = await Promise.allSettled([
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
        repository.closeByBuyNow({
          operationId: `${auctionId}:buy-now`,
          transactionId: `${auctionId}:txn`,
          auctionId,
          buyerId: 'buyer-1',
          transferId: `${auctionId}:transfer`,
          priceCredits: 100,
          remainingCredits: 0,
          // Posterior a `published_at`: lo exige `auctions_dates_valid`.
          closedAt: new Date(now.getTime() + 60_000),
        }),
      ])

      const persisted = await repository.findById(auctionId)
      const fulfilled = [cancelOutcome, buyNowOutcome].filter(
        (outcome) => outcome.status === 'fulfilled',
      )
      expect(fulfilled).toHaveLength(1)
      if (cancelOutcome.status === 'fulfilled') {
        expect(persisted?.status).toBe(AuctionStatus.Cancelled)
        expect(buyNowOutcome.status === 'rejected' && buyNowOutcome.reason).toBeInstanceOf(
          AuctionAlreadyClosedError,
        )
        await expect(repository.findBuyNowOperationByAuctionId(auctionId)).resolves.toBeNull()
      } else {
        expect(buyNowOutcome.status).toBe('fulfilled')
        expect(persisted?.status).toBe(AuctionStatus.SoldByBuyNow)
        expect((cancelOutcome.reason as AuctionRuleViolation).code).toBe(
          AuctionRuleCode.AuctionNotActive,
        )
        await expect(cancellations.getByAuctionId(auctionId)).resolves.toBeNull()
        await expect(cancelledEvents(auctionId)).resolves.toHaveLength(0)
      }
    })

    it('una subasta ya vendida por compra inmediata no se cancela automaticamente', async () => {
      const auctionId = 'buy-now-then-auto-1'
      await seedAuction(auctionId)
      await repository.closeByBuyNow({
        operationId: `${auctionId}:buy-now`,
        transactionId: `${auctionId}:txn`,
        auctionId,
        buyerId: 'buyer-1',
        transferId: `${auctionId}:transfer`,
        priceCredits: 100,
        remainingCredits: 0,
        closedAt: new Date(now.getTime() + 60_000),
      })

      await expect(
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
      ).rejects.toMatchObject({ code: AuctionRuleCode.AuctionNotActive })
      await expect(repository.findById(auctionId)).resolves.toMatchObject({
        status: AuctionStatus.SoldByBuyNow,
      })
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toBeNull()
      await expect(cancelledEvents(auctionId)).resolves.toHaveLength(0)
    })

    it('una compra inmediata posterior a la cancelacion automatica se rechaza', async () => {
      const auctionId = 'auto-then-buy-now-1'
      await seedAuction(auctionId)
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      await expect(
        repository.closeByBuyNow({
          operationId: `${auctionId}:buy-now`,
          transactionId: `${auctionId}:txn`,
          auctionId,
          buyerId: 'buyer-1',
          transferId: `${auctionId}:transfer`,
          priceCredits: 100,
          remainingCredits: 0,
          closedAt: new Date(now.getTime() + 60_000),
        }),
      ).rejects.toBeInstanceOf(AuctionAlreadyClosedError)
      await expect(repository.findBuyNowOperationByAuctionId(auctionId)).resolves.toBeNull()
    })

    it('automatica vs manual: una sola cancelacion, con un unico origen y un unico evento', async () => {
      const auctionId = 'auto-vs-manual-1'
      await seedAuction(auctionId)

      const [automaticOutcome, manualOutcome] = await Promise.allSettled([
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
        repository.cancelAuction(manualCommand(auctionId)),
      ])

      const fulfilled = [automaticOutcome, manualOutcome].filter(
        (outcome) => outcome.status === 'fulfilled',
      )
      expect(fulfilled).toHaveLength(1)
      const loser = automaticOutcome.status === 'rejected' ? automaticOutcome : manualOutcome
      expect(loser.status === 'rejected' && (loser.reason as AuctionRuleViolation).code).toBe(
        AuctionRuleCode.AuctionNotActive,
      )
      await expect(repository.findById(auctionId)).resolves.toMatchObject({
        status: AuctionStatus.Cancelled,
      })
      await expect(countRows('auction_cancellations', auctionId)).resolves.toBe(1)
      await expect(countRows('auction_cancellation_operations', auctionId)).resolves.toBe(1)
      const tracking = await cancellations.getByAuctionId(auctionId)
      expect(tracking?.origin).toBe(
        automaticOutcome.status === 'fulfilled' ? 'TERMS_VIOLATION' : 'MANUAL',
      )
      // Efectos coherentes con quien gano: refund solo si fue la manual.
      expect(tracking?.walletRefundStatus).toBe(
        automaticOutcome.status === 'fulfilled'
          ? AuctionCancellationEffectStatus.NotRequired
          : AuctionCancellationEffectStatus.Pending,
      )
      await expect(cancelledEvents(auctionId)).resolves.toHaveLength(1)
    })

    it('automatica vs settlement en el cierre: o CANCELLED sin ganador, o FINISHED sin cancelacion', async () => {
      const auctionId = 'auto-vs-settlement-1'
      // Ya vencida: settlement puede finalizarla en este mismo instante.
      await seedAuction(auctionId, { publishedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) })
      await placeBid(auctionId, 1)
      const aggregate = await repository.findAuctionAggregate(auctionId)
      const leader = await repository.findLeadingBid(auctionId)
      if (aggregate === null || leader === null) throw new Error('Datos de prueba incompletos.')
      const closingResult = aggregate.finish({
        finishedAt: now,
        leadingBid: {
          auctionId,
          bidId: leader.id,
          bidderId: leader.bidderId,
          amountCredits: leader.amountCredits,
        },
      })

      const [cancelOutcome, finishOutcome] = await Promise.allSettled([
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
        repository.finishAuction({ auctionId, finishedAt: now, closingResult }),
      ])

      const row = await db
        .selectFrom('auctions')
        .select(['status', 'winner_id', 'finished_at', 'cancelled_at'])
        .where('id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(
        [cancelOutcome, finishOutcome].filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1)
      if (cancelOutcome.status === 'fulfilled') {
        expect(row).toMatchObject({ status: 'CANCELLED', winner_id: null, finished_at: null })
        const candidates = await repository.findSettlementCandidates(now)
        expect(candidates.find((candidate) => candidate.auctionId === auctionId)).toBeUndefined()
      } else {
        expect(row).toMatchObject({ status: 'FINISHED', cancelled_at: null })
        expect(row.winner_id).toBe(leader.bidderId)
        expect((cancelOutcome.reason as AuctionRuleViolation).code).toBe(
          AuctionRuleCode.AuctionNotActive,
        )
        await expect(cancellations.getByAuctionId(auctionId)).resolves.toBeNull()
      }
    })

    it('una subasta ya finalizada por settlement no se cancela automaticamente y conserva su ganador', async () => {
      const auctionId = 'finished-then-auto-1'
      await seedAuction(auctionId, { publishedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) })
      await placeBid(auctionId, 1)
      const aggregate = await repository.findAuctionAggregate(auctionId)
      const leader = await repository.findLeadingBid(auctionId)
      if (aggregate === null || leader === null) throw new Error('Datos de prueba incompletos.')
      await repository.finishAuction({
        auctionId,
        finishedAt: now,
        closingResult: aggregate.finish({
          finishedAt: now,
          leadingBid: {
            auctionId,
            bidId: leader.id,
            bidderId: leader.bidderId,
            amountCredits: leader.amountCredits,
          },
        }),
      })

      await expect(
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
      ).rejects.toMatchObject({ code: AuctionRuleCode.AuctionNotActive })
      const row = await db
        .selectFrom('auctions')
        .select(['status', 'winner_id', 'cancelled_at'])
        .where('id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(row).toEqual({ status: 'FINISHED', winner_id: leader.bidderId, cancelled_at: null })
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toBeNull()
      // Su reserva ganadora NO entra en ningun plan de release de cancelacion.
      await expect(countRows('auction_cancellation_reservation_releases', auctionId)).resolves.toBe(
        0,
      )
    })

    it('una subasta ya cancelada manualmente no se cancela automaticamente ni cambia de origen', async () => {
      const auctionId = 'manual-then-auto-1'
      await seedAuction(auctionId)
      await repository.cancelAuction(manualCommand(auctionId))

      await expect(
        repository.cancelAuctionAutomatically(automaticCommand(auctionId)),
      ).rejects.toMatchObject({ code: AuctionRuleCode.AuctionNotActive })
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        origin: 'MANUAL',
        refundAmountCredits: 0.5,
      })
      await expect(cancelledEvents(auctionId)).resolves.toHaveLength(1)
    })

    it('una subasta cancelada automaticamente con pujas queda fuera de settlement y no se puede finalizar', async () => {
      const auctionId = 'auto-settlement-excluded-1'
      await seedAuction(auctionId, { publishedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000) })
      await placeBid(auctionId, 1)
      const aggregate = await repository.findAuctionAggregate(auctionId)
      const leader = await repository.findLeadingBid(auctionId)
      if (aggregate === null || leader === null) throw new Error('Datos de prueba incompletos.')
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))

      const afterClose = new Date(now.getTime() + 72 * 60 * 60 * 1000)
      const candidates = await repository.findSettlementCandidates(afterClose)
      expect(candidates.find((candidate) => candidate.auctionId === auctionId)).toBeUndefined()

      const closingResult = aggregate.finish({
        finishedAt: afterClose,
        leadingBid: {
          auctionId,
          bidId: leader.id,
          bidderId: leader.bidderId,
          amountCredits: leader.amountCredits,
        },
      })
      await expect(
        repository.finishAuction({ auctionId, finishedAt: afterClose, closingResult }),
      ).rejects.toThrow('La subasta ya fue finalizada.')
      const row = await db
        .selectFrom('auctions')
        .select(['status', 'winner_id', 'winning_bid_id'])
        .where('id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(row).toEqual({ status: 'CANCELLED', winner_id: null, winning_bid_id: null })
    })
  })

  describe('efectos y reconciler', () => {
    it('el caso de uso completo libera reservas e inventario y no reembolsa la comision', async () => {
      const auctionId = 'auto-e2e-1'
      await seedAuction(auctionId, { durationHours: 48 })
      await placeBid(auctionId, 1)
      await placeBid(auctionId, 2, { completed: false })
      const { automatic, wallet, fees, reconciler, walletCallsFor, inventoryCallsFor } = useCases()

      const result = await automatic.execute({ auctionId, sanctionId })
      await reconciler.runBatch()

      expect(result.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
      // Todo confirmado y el refund NOT_REQUIRED: el reconciler no repite nada.
      expect(walletCallsFor(auctionId).map((call) => call.holdId)).toEqual([
        `${auctionId}:hold-1`,
        `${auctionId}:hold-2`,
      ])
      expect(wallet.captureCalls).toEqual([])
      expect(inventoryCallsFor(auctionId)).toHaveLength(1)
      expect(fees.refundCalls.filter((call) => call.chargeId === `charge:${auctionId}`)).toEqual([])
      expect(result.cancellation).toMatchObject({
        refundAmountCredits: 0,
        walletRefundStatus: AuctionCancellationEffectStatus.NotRequired,
        inventoryReleaseStatus: AuctionCancellationEffectStatus.Confirmed,
      })
      expect(result.cancellation?.reservationReleases.map((release) => release.status)).toEqual([
        AuctionCancellationEffectStatus.Confirmed,
        AuctionCancellationEffectStatus.Confirmed,
      ])
    })

    it('el replay del caso de uso no repite ningun efecto externo', async () => {
      const auctionId = 'auto-e2e-replay-1'
      await seedAuction(auctionId)
      await placeBid(auctionId, 1)
      const { automatic, walletCallsFor, inventoryCallsFor } = useCases()
      await automatic.execute({ auctionId, sanctionId })

      const replay = await automatic.execute({ auctionId, sanctionId })
      const otherSanction = await automatic.execute({ auctionId, sanctionId: 'sanction-2' })

      expect(replay.outcome).toBe(AutomaticCancellationOutcome.AlreadyCancelled)
      expect(otherSanction.outcome).toBe(AutomaticCancellationOutcome.AlreadyCancelled)
      expect(walletCallsFor(auctionId)).toHaveLength(1)
      expect(inventoryCallsFor(auctionId)).toHaveLength(1)
    })

    it('el reconciler retoma releases de reserva e inventario RETRYABLE con los mismos operationId', async () => {
      const auctionId = 'auto-reconcile-1'
      await seedAuction(auctionId)
      await placeBid(auctionId, 1)
      const { automatic, wallet, inventory, reconciler, walletCallsFor, inventoryCallsFor } =
        useCases()
      wallet.outcomes.set(`${auctionId}:hold-1`, 'RETRYABLE')
      inventory.unavailable = true

      await automatic.execute({ auctionId, sanctionId })
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        inventoryReleaseStatus: AuctionCancellationEffectStatus.Retryable,
        reservationReleases: [
          {
            status: AuctionCancellationEffectStatus.Retryable,
            lastError: 'El release Wallet requiere reintento: RETRYABLE.',
          },
        ],
      })

      wallet.outcomes.clear()
      inventory.unavailable = false
      const batch = await reconciler.runBatch()

      expect(batch).toMatchObject({ retryable: 0, terminal: 0, unexpectedErrors: 0 })
      expect(walletCallsFor(auctionId).map((call) => call.operationId)).toEqual([
        `auction:${auctionId}:cancellation:reservation:${auctionId}:hold-1:release`,
        `auction:${auctionId}:cancellation:reservation:${auctionId}:hold-1:release`,
      ])
      expect(inventoryCallsFor(auctionId).map((call) => call.operationId)).toEqual([
        `auction:${auctionId}:cancellation:inventory-release`,
        `auction:${auctionId}:cancellation:inventory-release`,
      ])
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        inventoryReleaseStatus: AuctionCancellationEffectStatus.Confirmed,
        inventoryReleaseLastError: null,
        reservationReleases: [
          { status: AuctionCancellationEffectStatus.Confirmed, lastError: null },
        ],
      })
      // Ya confirmado: otro ciclo del reconciler no repite ningun efecto.
      await reconciler.runBatch()
      expect(walletCallsFor(auctionId)).toHaveLength(2)
      expect(inventoryCallsFor(auctionId)).toHaveLength(2)
    })

    it('un release de reserva terminal queda registrado y no se vuelve a reclamar', async () => {
      const auctionId = 'auto-terminal-1'
      await seedAuction(auctionId)
      await placeBid(auctionId, 1)
      const { automatic, wallet, reconciler, walletCallsFor } = useCases()
      wallet.outcomes.set(`${auctionId}:hold-1`, 'TERMINAL_NOT_FOUND')

      await automatic.execute({ auctionId, sanctionId })
      await reconciler.runBatch()

      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        reservationReleases: [
          {
            status: AuctionCancellationEffectStatus.TerminalError,
            lastError: 'El release Wallet fallo terminalmente: TERMINAL_NOT_FOUND.',
          },
        ],
      })
      expect(walletCallsFor(auctionId)).toHaveLength(1)
    })

    it('claimPendingCancellations reclama una automatica solo por un release de reserva pendiente', async () => {
      const auctionId = 'auto-claim-release-1'
      await seedAuction(auctionId)
      await placeBid(auctionId, 1)
      await repository.cancelAuctionAutomatically(automaticCommand(auctionId))
      await cancellations.markInventoryReleaseConfirmed(auctionId, now)

      const claimed = await cancellations.claimPendingCancellations({
        now,
        workerId: 'worker-claim',
        leaseUntil: new Date(now.getTime() + 60_000),
        limit: 500,
      })

      const mine = claimed.find((candidate) => candidate.auctionId === auctionId)
      expect(mine?.reservationReleases.map((release) => release.status)).toEqual([
        AuctionCancellationEffectStatus.Pending,
      ])

      // Con el lease vigente nadie mas la reclama; confirmar el release lo libera.
      const again = await cancellations.claimPendingCancellations({
        now,
        workerId: 'worker-other',
        leaseUntil: new Date(now.getTime() + 60_000),
        limit: 500,
      })
      expect(again.find((candidate) => candidate.auctionId === auctionId)).toBeUndefined()

      await cancellations.markReservationReleaseConfirmed(auctionId, `${auctionId}:hold-1`, now)
      const settled = await cancellations.claimPendingCancellations({
        now,
        workerId: 'worker-other',
        leaseUntil: new Date(now.getTime() + 60_000),
        limit: 500,
      })
      expect(settled.find((candidate) => candidate.auctionId === auctionId)).toBeUndefined()
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        reservationReleases: [{ status: AuctionCancellationEffectStatus.Confirmed }],
      })
    })

    it('dos reclamos concurrentes nunca devuelven la misma cancelacion automatica (SKIP LOCKED)', async () => {
      const auctionIds = ['auto-skip-1', 'auto-skip-2', 'auto-skip-3', 'auto-skip-4']
      for (const auctionId of auctionIds) {
        await seedAuction(auctionId)
        await placeBid(auctionId, 1)
        await repository.cancelAuctionAutomatically(automaticCommand(auctionId))
      }
      const claim = (workerId: string) =>
        cancellations.claimPendingCancellations({
          now,
          workerId,
          leaseUntil: new Date(now.getTime() + 60_000),
          limit: 500,
        })

      const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')])

      const firstIds = first.map((candidate) => candidate.auctionId)
      const secondIds = second.map((candidate) => candidate.auctionId)
      expect(firstIds.filter((auctionId) => secondIds.includes(auctionId))).toEqual([])
      const claimedIds = [...firstIds, ...secondIds]
      for (const auctionId of auctionIds) {
        expect(claimedIds.filter((claimed) => claimed === auctionId)).toHaveLength(1)
      }
    })
  })

  describe('migracion 019', () => {
    it('se aplica sobre un esquema 001-018 con una cancelacion manual previa y la clasifica MANUAL', async () => {
      const upgradeContainer = await new PostgreSqlContainer('postgres:17-alpine').start()
      const upgradeDb = createDatabase({ connectionString: upgradeContainer.getConnectionUri() })
      try {
        const preMigration019 = Object.fromEntries(
          Object.entries(MIGRATIONS).filter(([name]) => name < '019'),
        )
        const before = await migrateToLatest(upgradeDb, preMigration019)
        expect(before.error).toBeUndefined()

        const closesAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        for (const id of ['pre-019-manual', 'pre-019-automatic']) {
          await sql`
            insert into auctions (
              id, seller_id, product_id, duration_hours, publisher_type, price_kind,
              publication_fee_credits, minimum_bid_credits, status, published_at, closes_at,
              inventory_commitment_id, fee_charge_id, cancelled_at
            ) values (
              ${id}, 'seller-pre-019', ${`product:${id}`}, 24, 'PLAYER', 'CREDITS',
              1, 10, 'CANCELLED', ${now}, ${closesAt},
              ${`commitment:${id}`}, ${`charge:${id}`}, ${now}
            )
          `.execute(upgradeDb)
        }
        await sql`
          insert into auction_cancellations (
            auction_id, operation_id, seller_id, product_id, inventory_commitment_id,
            fee_charge_id, refund_amount_credits, wallet_refund_operation_id,
            wallet_refund_status, inventory_release_operation_id, inventory_release_status,
            cancelled_at, created_at, updated_at
          ) values (
            'pre-019-manual', 'op-pre-019', 'seller-pre-019', 'product:pre-019-manual',
            'commitment:pre-019-manual', 'charge:pre-019-manual', 0.5, 'refund-pre-019',
            'CONFIRMED', 'release-pre-019', 'CONFIRMED', ${now}, ${now}, ${now}
          )
        `.execute(upgradeDb)

        const after = await migrateToLatest(upgradeDb, MIGRATIONS)
        expect(after.error).toBeUndefined()
        expect(after.applied).toEqual(['019-add-automatic-auction-cancellation'])

        const preserved = await sql<{ origin: string; trigger_reference_id: string | null }>`
          select origin, trigger_reference_id from auction_cancellations
          where auction_id = 'pre-019-manual'
        `.execute(upgradeDb)
        expect(preserved.rows[0]).toEqual({ origin: 'MANUAL', trigger_reference_id: null })

        const insertAutomatic = (overrides: {
          refund?: number
          walletStatus?: string
          walletOperationId?: string | null
          trigger?: string | null
        }) =>
          sql`
          insert into auction_cancellations (
            auction_id, operation_id, origin, trigger_reference_id, seller_id, product_id,
            inventory_commitment_id, refund_amount_credits, wallet_refund_operation_id,
            wallet_refund_status, inventory_release_operation_id, inventory_release_status,
            cancelled_at, created_at, updated_at
          ) values (
            'pre-019-automatic', 'op-auto-019', 'TERMS_VIOLATION',
            ${'trigger' in overrides ? overrides.trigger : 'sanction-1'},
            'seller-pre-019', 'product:pre-019-automatic', 'commitment:pre-019-automatic',
            ${overrides.refund ?? 0},
            ${'walletOperationId' in overrides ? overrides.walletOperationId : null},
            ${overrides.walletStatus ?? 'NOT_REQUIRED'}, 'release-auto-019', 'PENDING',
            ${now}, ${now}, ${now}
          )
        `.execute(upgradeDb)

        // Una automatica nunca lleva refund, ni estado de refund, ni carece de sancion.
        await expect(insertAutomatic({ refund: 0.5 })).rejects.toThrow()
        await expect(insertAutomatic({ walletStatus: 'PENDING' })).rejects.toThrow()
        await expect(insertAutomatic({ walletOperationId: 'refund-x' })).rejects.toThrow()
        await expect(insertAutomatic({ trigger: null })).rejects.toThrow()
        // Y una manual sigue sin poder declararse NOT_REQUIRED ni con refund 0.
        await expect(
          sql`
            update auction_cancellations set wallet_refund_status = 'NOT_REQUIRED'
            where auction_id = 'pre-019-manual'
          `.execute(upgradeDb),
        ).rejects.toThrow()
        await expect(
          sql`
            update auction_cancellations set refund_amount_credits = 0
            where auction_id = 'pre-019-manual'
          `.execute(upgradeDb),
        ).rejects.toThrow()

        await insertAutomatic({})
        await sql`
          insert into auction_cancellation_reservation_releases (
            auction_id, reservation_id, operation_id, status, created_at, updated_at
          ) values ('pre-019-automatic', 'hold-1', 'release-op-1', 'PENDING', ${now}, ${now})
        `.execute(upgradeDb)
        // Una reserva se sigue una sola vez por subasta, con estado valido.
        await expect(
          sql`
            insert into auction_cancellation_reservation_releases (
              auction_id, reservation_id, operation_id, status, created_at, updated_at
            ) values ('pre-019-automatic', 'hold-1', 'release-op-2', 'PENDING', ${now}, ${now})
          `.execute(upgradeDb),
        ).rejects.toThrow()
        await expect(
          sql`
            update auction_cancellation_reservation_releases set status = 'NOT_REQUIRED'
            where auction_id = 'pre-019-automatic'
          `.execute(upgradeDb),
        ).rejects.toThrow()
      } finally {
        await upgradeDb.destroy()
        await upgradeContainer.stop()
      }
    }, 120_000)

    it('down revierte el esquema cuando no hay cancelaciones automaticas, y up vuelve a aplicarse', async () => {
      const migrationContainer = await new PostgreSqlContainer('postgres:17-alpine').start()
      const migrationDb = createDatabase({
        connectionString: migrationContainer.getConnectionUri(),
      })
      try {
        const outcome = await migrateToLatest(migrationDb)
        expect(outcome.error).toBeUndefined()
        const migration = MIGRATIONS['019-add-automatic-auction-cancellation']
        if (migration?.down === undefined) throw new Error('La migracion 019 no tiene down.')

        await migration.down(migrationDb)
        const columns = await sql<{ column_name: string }>`
          select column_name from information_schema.columns
          where table_name = 'auction_cancellations'
            and column_name in ('origin', 'trigger_reference_id')
        `.execute(migrationDb)
        expect(columns.rows).toEqual([])
        const table = await sql<{ exists: boolean }>`
          select to_regclass('auction_cancellation_reservation_releases') is not null as exists
        `.execute(migrationDb)
        expect(table.rows[0]?.exists).toBe(false)

        await migration.up(migrationDb)
        const restored = await sql<{ exists: boolean }>`
          select to_regclass('auction_cancellation_reservation_releases') is not null as exists
        `.execute(migrationDb)
        expect(restored.rows[0]?.exists).toBe(true)
      } finally {
        await migrationDb.destroy()
        await migrationContainer.stop()
      }
    }, 120_000)
  })
})
