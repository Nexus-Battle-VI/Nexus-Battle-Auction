import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely, type Migration } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import { PostgresEarlyClosureNotificationRepository } from '../../src/adapters/outbound/persistence/PostgresEarlyClosureNotificationRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import {
  AuctionAlreadyClosedError,
  BuyNowIdempotencyConflictError,
} from '../../src/application/errors/BuyNowTransactionError'
import type {
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../src/application/ports/BidCreditsPort'
import { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { PostgresAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionSettlementRepository'
import { PostgresAuctionSettlementOutboxRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionSettlementOutboxRepository'
import { PostgresAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionPendingClaimRepository'
import { PostgresBidCreditOperationReader } from '../../src/adapters/outbound/persistence/PostgresBidCreditOperationReader'
import {
  AuctionSettlementStatus,
  CaptureStatus,
  ReleaseStatus,
} from '../../src/application/ports/AuctionSettlementRepositoryPort'
import { Auction, AuctionClosingOutcome, AuctionStatus } from '../../src/domain/entities/Auction'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import { Bid } from '../../src/domain/entities/Bid'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import { createAuctionSettledEventV1 } from '../../src/domain/events/AuctionSettledEventV1'
import { ClassifyAuctionLoserCredits } from '../../src/application/use-cases/ClassifyAuctionLoserCredits'
import { PrepareAuctionLoserReleaseTasks } from '../../src/application/use-cases/PrepareAuctionLoserReleaseTasks'
import { SettleAuction } from '../../src/application/use-cases/SettleAuction'
import { PostgresAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionInventorySettlementIntentRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  AuctionWalletPort,
  CaptureAuctionHoldCommand,
  ReleaseAuctionHoldCommand,
  WalletHoldOutcome,
  WalletHoldResult,
} from '../../src/application/ports/AuctionWalletPort'
import type {
  MarkInventoryProductPendingClaimCommand,
  ProductInventoryPort,
  ReleaseInventoryProductCommand,
} from '../../src/application/ports/ProductInventoryPort'
import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
} from '../../src/domain/entities/OfficialAuction'
import { AuctionPriceKind } from '../../src/domain/value-objects/AuctionPublicationPricing'
import {
  MIGRATIONS,
  createDatabase,
  migrateToLatest,
  pingDatabase,
} from '../../src/infrastructure/persistence/database'

/**
 * Infraestructura de persistencia contra un PostgreSQL REAL.
 *
 * Lo que se comprueba no se puede comprobar con un doble: que el pool conecta,
 * que el migrador registra lo aplicado y que una migracion rota se informa en
 * lugar de darse por buena.
 */
describe('Persistencia PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let containerStarted = false
  let databaseInitialized = false

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    containerStarted = true

    db = createDatabase({
      connectionString: container.getConnectionUri(),
    })
    databaseInitialized = true
  }, 120_000)

  afterAll(async () => {
    // beforeAll puede fallar antes de asignar recursos si Docker no esta disponible.
    if (databaseInitialized) await db.destroy()
    if (containerStarted) await container.stop()
  })

  it('la sonda responde contra un motor disponible', async () => {
    await expect(pingDatabase(db)).resolves.toBe(true)
  })

  it('aplica las migraciones del producto sin error', async () => {
    const outcome = await migrateToLatest(db)

    expect(outcome.error).toBeUndefined()
  })

  it('registra las migraciones aplicadas y no las repite', async () => {
    const migrations: Record<string, Migration> = {
      ...MIGRATIONS,
      '900-prueba': {
        up: async (conexion: Kysely<unknown>) => {
          await conexion.schema.createTable('prueba').addColumn('id', 'text').execute()
        },
      },
    }

    expect((await migrateToLatest(db, migrations)).applied).toEqual(['900-prueba'])

    expect((await migrateToLatest(db, migrations)).applied).toEqual([])

    const { rows } = await sql<{ existe: boolean }>`
        select
          to_regclass('public.prueba')
          is not null as existe
      `.execute(db)

    expect(rows[0]?.existe).toBe(true)
  })

  it('informa una migracion rota en lugar de darla por aplicada', async () => {
    const outcome = await migrateToLatest(db, {
      ...MIGRATIONS,
      '900-prueba': {
        up: () => Promise.resolve(),
      },
      '901-rota': {
        up: () => Promise.reject(new Error('sql invalido')),
      },
    })

    expect(outcome.applied).toEqual([])

    expect(outcome.error).toBeInstanceOf(Error)
  })

  /**
   * Reproduce lo que tumbaba el servicio: el motor corta una conexion que
   * espera ociosa en el pool. Sin oyente de `error`, Jest veria el proceso
   * terminar; con el, el error llega a `onIdleError` y la siguiente consulta
   * abre una conexion nueva.
   */
  it('sobrevive a que el motor corte una conexion ociosa del pool', async () => {
    const errores: Error[] = []

    const aplicacion = 'prueba-conexion-ociosa'

    const propia = createDatabase({
      connectionString: `${container.getConnectionUri()}?application_name=${aplicacion}`,
      onIdleError: (error) => errores.push(error),
    })

    try {
      await expect(pingDatabase(propia)).resolves.toBe(true)

      await sql`
        select
          pg_terminate_backend(pid)
        from pg_stat_activity
        where application_name = ${aplicacion}
          and state = 'idle'
      `.execute(db)

      for (let intento = 0; intento < 50 && errores.length === 0; intento += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(errores.length).toBeGreaterThan(0)

      await expect(pingDatabase(propia)).resolves.toBe(true)
    } finally {
      await propia.destroy()
    }
  })

  /**
   * El control de la primera prueba: con el motor inalcanzable la sonda dice
   * `false`. Sin este caso, una sonda que devolviera siempre `true` pasaria.
   */
  it('la sonda falla contra un motor inalcanzable', async () => {
    const inalcanzable = createDatabase({
      connectionString: 'postgres://nadie:nada@127.0.0.1:1/ninguna',
    })

    try {
      await expect(pingDatabase(inalcanzable)).resolves.toBe(false)
    } finally {
      await inalcanzable.destroy()
    }
  })

  describe('repositorio de publicaciones', () => {
    const now = new Date('2026-09-23T12:00:00.000Z')

    const publication = (id: string, sellerId = 'seller-1', productId = `product-${id}`) => ({
      operationId: `operation-${id}`,
      auction: Auction.publish({
        auctionId: id,
        sellerId,
        productId,
        durationHours: 24,
        minimumBidCredits: 10,
        buyNowCredits: 20,
        publishedAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: {
          productOwnedBySeller: true,
          productInUse: false,
          productTradable: true,
          sellerHasActiveSanctions: false,
          activeAuctionCount: 0,
        },
      }),
      inventoryCommitmentId: `commitment-${id}`,
      feeChargeId: `charge-${id}`,
    })

    const bid = (
      bidId: string,
      auctionId: string,
      bidderId: string,
      amountCredits: number,
      placedAt: Date,
      currentBidCredits: number | null,
    ) =>
      Bid.register({
        bidId,
        auctionId,
        bidderId,
        amountCredits,
        placedAt,
        eligibility: {
          auctionStatus: 'ACTIVE',
          sellerId: 'seller-1',
          currentBidCredits,
          minimumIncrementCredits: 10,
          lastBidAtByBidder: null,
          activeBidCount: 0,
        },
      })

    beforeEach(async () => {
      await sql`
        truncate
          auction_settlement_releases,
          auction_settlements,
          auction_early_closure_notifications,
          auction_bid_credit_failures,
          auction_bid_credit_operations,
          auction_bids,
          auction_publication_operations,
          auction_audit_log,
          auction_publication_failures,
          outbox_events,
          auctions
        restart identity cascade
      `.execute(db)
    })

    const expectRehydratedAuctionToRejectSecondFinish = (auction: Auction): void => {
      let error: unknown

      try {
        auction.finish({
          finishedAt: new Date('2026-09-23T12:00:00.000Z'),
          leadingBid: null,
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(AuctionRuleViolation)
      expect(error).toMatchObject({ code: AuctionRuleCode.AuctionAlreadyFinished })
    }

    const winnerSettlement = (auctionId: string) => ({
      auctionId,
      resultType: 'WITH_WINNER' as const,
      sellerId: 'seller-1',
      winningBidId: `${auctionId}-bid`,
      winnerId: `${auctionId}-winner`,
      winningHoldId: `${auctionId}-hold`,
      finalAmountCredits: 30,
      captureOperationId: `auction:${auctionId}:settlement:capture`,
      createdAt: new Date('2026-09-23T12:00:00.000Z'),
    })

    const fixedClock: ClockPort = { now: () => new Date(now) }

    class FakeDbWallet implements AuctionWalletPort {
      readonly captureCalls: CaptureAuctionHoldCommand[] = []
      readonly releaseCalls: ReleaseAuctionHoldCommand[] = []
      constructor(
        private readonly captureOutcome: WalletHoldOutcome = 'SUCCESS',
        private readonly releaseOutcome: WalletHoldOutcome = 'SUCCESS',
        private readonly applied = true,
      ) {}
      captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> {
        this.captureCalls.push(command)
        return Promise.resolve({
          outcome: this.captureOutcome,
          operationId: command.operationId,
          holdId: command.holdId,
          applied: this.applied,
        })
      }
      releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> {
        this.releaseCalls.push(command)
        return Promise.resolve({
          outcome: this.releaseOutcome,
          operationId: command.operationId,
          holdId: command.holdId,
          applied: this.applied,
        })
      }
    }

    class FakeDbInventory implements ProductInventoryPort {
      readonly releaseCalls: ReleaseInventoryProductCommand[] = []
      readonly pendingClaimCalls: MarkInventoryProductPendingClaimCommand[] = []

      inspect(): Promise<{ readonly ownedByPlayer: boolean; readonly inUse: boolean }> {
        return Promise.resolve({ ownedByPlayer: true, inUse: false })
      }

      commit(): Promise<never> {
        return Promise.reject(new Error('No debe invocarse commit durante settlement.'))
      }

      release(command: ReleaseInventoryProductCommand) {
        this.releaseCalls.push(command)
        return Promise.resolve({
          operationId: command.operationId,
          commitmentId: command.commitmentId,
          status: 'RELEASED' as const,
          applied: true,
        })
      }

      markPendingClaim(command: MarkInventoryProductPendingClaimCommand) {
        this.pendingClaimCalls.push(command)
        return Promise.resolve({
          operationId: command.operationId,
          commitmentId: command.commitmentId,
          status: 'PENDING_CLAIM' as const,
          winnerId: command.winnerId,
          applied: true,
        })
      }

      confirmClaim(): Promise<never> {
        return Promise.reject(new Error('No debe invocarse confirmClaim durante settlement.'))
      }
    }

    const createSettleAuctionForDb = (
      wallet = new FakeDbWallet(),
      inventory = new FakeDbInventory(),
    ) => {
      const auctions = new PostgresAuctionRepository(db)
      const settlements = new PostgresAuctionSettlementRepository(db)
      return {
        wallet,
        inventory,
        auctions,
        settlements,
        useCase: new SettleAuction(
          auctions,
          settlements,
          fixedClock,
          wallet,
          new ClassifyAuctionLoserCredits(new PostgresBidCreditOperationReader(db)),
          new PrepareAuctionLoserReleaseTasks(settlements),
          inventory,
          new PostgresAuctionInventorySettlementIntentRepository(db),
          new PostgresAuctionPendingClaimRepository(db),
        ),
      }
    }

    const withoutBidsFixture = (auctionId: string) => ({
      auctionId,
      sellerId: 'seller-1',
      closesAt: publication(auctionId).auction.snapshot().closesAt,
    })

    const withWinnerFixture = async (auctionId: string, withLoser = false) => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publish(publication(auctionId))
      if (withLoser)
        await repository.persistBid(
          bid(
            `${auctionId}-loser`,
            auctionId,
            'loser',
            20,
            new Date('2026-09-21T12:00:10.000Z'),
            null,
          ),
          `${auctionId}-loser-hold`,
        )
      await repository.persistBid(
        bid(
          `${auctionId}-winner`,
          auctionId,
          'winner',
          30,
          new Date('2026-09-21T12:00:11.000Z'),
          null,
        ),
        `${auctionId}-winner-hold`,
      )
      return {
        auctionId,
        sellerId: 'seller-1',
        winningBidId: `${auctionId}-winner`,
        winningHoldId: `${auctionId}-winner-hold`,
      }
    }

    it('construye SettleAuction con adapters PostgreSQL', () => {
      const fixture = withoutBidsFixture('settle-auction-smoke')
      expect(fixture.sellerId).toBe('seller-1')
      expect(createSettleAuctionForDb().useCase).toBeInstanceOf(SettleAuction)
    })

    it('recupera WITHOUT_BIDS desde PostgreSQL tras recrear SettleAuction', async () => {
      const auctionId = 'settle-auction-without-bids-recovery'
      withoutBidsFixture(auctionId)
      const walletA = new FakeDbWallet()
      const first = createSettleAuctionForDb(walletA)
      await first.auctions.publish(publication(auctionId))

      await expect(first.useCase.execute({ auctionId })).resolves.toMatchObject({
        status: AuctionSettlementStatus.Completed,
        resultType: 'WITHOUT_BIDS',
        captureStatus: CaptureStatus.NotRequired,
      })
      const auctionAfterFirst = await first.auctions.findAuctionAggregate(auctionId)
      const settlementAfterFirst = await first.settlements.getByAuctionId(auctionId)
      expect(auctionAfterFirst).toMatchObject({
        status: 'FINISHED',
        finishedAt: now,
        closingResult: { outcome: AuctionClosingOutcome.WithoutBids },
      })
      expect(settlementAfterFirst).toMatchObject({
        status: AuctionSettlementStatus.Completed,
        resultType: 'WITHOUT_BIDS',
        captureStatus: CaptureStatus.NotRequired,
        winningBidId: null,
        winnerId: null,
        winningHoldId: null,
        finalAmountCredits: null,
        captureOperationId: null,
      })
      if (auctionAfterFirst === null || settlementAfterFirst === null)
        throw new Error('Estado esperado.')

      const walletB = new FakeDbWallet()
      const second = createSettleAuctionForDb(walletB)
      await expect(second.useCase.execute({ auctionId })).resolves.toMatchObject({
        status: AuctionSettlementStatus.Completed,
        resultType: 'WITHOUT_BIDS',
        captureStatus: CaptureStatus.NotRequired,
      })
      await expect(second.auctions.findAuctionAggregate(auctionId)).resolves.toMatchObject({
        status: 'FINISHED',
        finishedAt: auctionAfterFirst.finishedAt,
        closingResult: { outcome: AuctionClosingOutcome.WithoutBids },
      })
      await expect(second.settlements.getByAuctionId(auctionId)).resolves.toEqual(
        settlementAfterFirst,
      )
      expect(walletA.captureCalls).toHaveLength(0)
      expect(walletA.releaseCalls).toHaveLength(0)
      expect(walletB.captureCalls).toHaveLength(0)
      expect(walletB.releaseCalls).toHaveLength(0)
      const row = await db
        .selectFrom('auction_settlements')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(row.count).toBe(1)
    })

    it('recupera capture RETRYABLE con el mismo intent Wallet tras restart', async () => {
      const auctionId = 'settle-auction-capture-retry-recovery'
      const fixture = await withWinnerFixture(auctionId)
      const walletA = new FakeDbWallet('RETRYABLE')
      const first = createSettleAuctionForDb(walletA)

      await expect(first.useCase.execute({ auctionId })).resolves.toMatchObject({
        captureStatus: CaptureStatus.Retryable,
      })
      const beforeRestart = await first.settlements.getByAuctionId(auctionId)
      expect(beforeRestart).toMatchObject({
        resultType: 'WITH_WINNER',
        captureStatus: CaptureStatus.Retryable,
        winningBidId: fixture.winningBidId,
        winnerId: 'winner',
        winningHoldId: fixture.winningHoldId,
        sellerId: fixture.sellerId,
        finalAmountCredits: 30,
        captureOperationId: `auction:${auctionId}:settlement:capture`,
      })
      if (beforeRestart === null) throw new Error('Settlement esperado.')
      expect(walletA.captureCalls).toEqual([
        expect.objectContaining({
          holdId: beforeRestart.winningHoldId,
          operationId: beforeRestart.captureOperationId,
          beneficiaryPlayerId: fixture.sellerId,
          auctionId,
          winningBidId: fixture.winningBidId,
        }),
      ])

      const walletB = new FakeDbWallet('SUCCESS', 'SUCCESS', false)
      const second = createSettleAuctionForDb(walletB)
      await second.useCase.execute({ auctionId })
      expect(walletB.captureCalls).toEqual([
        expect.objectContaining({
          holdId: beforeRestart.winningHoldId,
          operationId: beforeRestart.captureOperationId,
        }),
      ])
      await expect(second.settlements.getByAuctionId(auctionId)).resolves.toMatchObject({
        captureStatus: CaptureStatus.Confirmed,
        winningHoldId: beforeRestart.winningHoldId,
        captureOperationId: beforeRestart.captureOperationId,
      })
      const row = await db
        .selectFrom('auction_settlements')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(row.count).toBe(1)
    })

    it('no recaptura un WITH_WINNER CONFIRMED tras recrear SettleAuction', async () => {
      const auctionId = 'settle-auction-capture-confirmed-restart'
      const fixture = await withWinnerFixture(auctionId)
      const first = createSettleAuctionForDb(new FakeDbWallet('SUCCESS'))
      await first.useCase.execute({ auctionId })
      const beforeRestart = await first.settlements.getByAuctionId(auctionId)
      expect(beforeRestart).toMatchObject({
        resultType: 'WITH_WINNER',
        captureStatus: CaptureStatus.Confirmed,
        captureOperationId: `auction:${auctionId}:settlement:capture`,
        winningHoldId: fixture.winningHoldId,
      })
      if (beforeRestart === null) throw new Error('Settlement esperado.')

      const walletB = new FakeDbWallet('TERMINAL_CONFLICT')
      const second = createSettleAuctionForDb(walletB)
      await second.useCase.execute({ auctionId })
      expect(walletB.captureCalls).toHaveLength(0)
      await expect(second.settlements.getByAuctionId(auctionId)).resolves.toMatchObject({
        captureStatus: CaptureStatus.Confirmed,
        captureOperationId: beforeRestart.captureOperationId,
        winningHoldId: beforeRestart.winningHoldId,
      })
      const row = await db
        .selectFrom('auction_settlements')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(row.count).toBe(1)
    })

    it('recupera release RETRYABLE con mismo intent tras restart', async () => {
      const auctionId = 'settle-auction-release-retry-recovery'
      await withWinnerFixture(auctionId, true)
      const walletA = new FakeDbWallet('SUCCESS', 'RETRYABLE')
      const first = createSettleAuctionForDb(walletA)
      await first.useCase.execute({ auctionId })
      await first.useCase.execute({ auctionId })
      const releaseBeforeRestart = (await first.settlements.listReleaseTasks(auctionId))[0]
      const settlementBeforeRestart = await first.settlements.getByAuctionId(auctionId)
      expect(releaseBeforeRestart).toMatchObject({
        status: ReleaseStatus.Retryable,
        holdId: `${auctionId}-loser-hold`,
        operationId: `auction:${auctionId}:bid:${auctionId}-loser:release`,
        reason: 'AUCTION_SETTLEMENT_LOST',
        lastError: expect.any(String),
      })
      expect(settlementBeforeRestart).toMatchObject({ captureStatus: CaptureStatus.Confirmed })
      if (releaseBeforeRestart === undefined || settlementBeforeRestart === null)
        throw new Error('Estado durable esperado.')

      const walletB = new FakeDbWallet('TERMINAL_CONFLICT', 'SUCCESS', false)
      const second = createSettleAuctionForDb(walletB)
      await second.useCase.execute({ auctionId })
      expect(walletB.captureCalls).toHaveLength(0)
      expect(walletB.releaseCalls).toEqual([
        expect.objectContaining({
          holdId: releaseBeforeRestart.holdId,
          operationId: releaseBeforeRestart.operationId,
          reason: releaseBeforeRestart.reason,
        }),
      ])
      await expect(second.settlements.listReleaseTasks(auctionId)).resolves.toEqual([
        expect.objectContaining({ status: ReleaseStatus.Released }),
      ])
      await expect(second.settlements.getByAuctionId(auctionId)).resolves.toMatchObject({
        captureStatus: CaptureStatus.Confirmed,
      })
      const row = await db
        .selectFrom('auction_settlement_releases')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .where('bid_id', '=', `${auctionId}-loser`)
        .executeTakeFirstOrThrow()
      expect(row.count).toBe(1)
    })

    it('no reintenta una release TERMINAL_ERROR tras restart', async () => {
      const auctionId = 'settle-auction-release-terminal-recovery'
      await withWinnerFixture(auctionId, true)
      const first = createSettleAuctionForDb(new FakeDbWallet('SUCCESS', 'TERMINAL_NOT_FOUND'))
      await first.useCase.execute({ auctionId })
      await first.useCase.execute({ auctionId })
      const releaseBeforeRestart = (await first.settlements.listReleaseTasks(auctionId))[0]
      const settlementBeforeRestart = await first.settlements.getByAuctionId(auctionId)
      expect(releaseBeforeRestart).toMatchObject({
        status: ReleaseStatus.TerminalError,
        holdId: `${auctionId}-loser-hold`,
        operationId: `auction:${auctionId}:bid:${auctionId}-loser:release`,
        reason: 'AUCTION_SETTLEMENT_LOST',
        lastError: expect.any(String),
      })
      expect(settlementBeforeRestart).toMatchObject({ captureStatus: CaptureStatus.Confirmed })
      if (releaseBeforeRestart === undefined || settlementBeforeRestart === null)
        throw new Error('Estado durable esperado.')

      const walletB = new FakeDbWallet('TERMINAL_CONFLICT', 'SUCCESS')
      const second = createSettleAuctionForDb(walletB)
      await second.useCase.execute({ auctionId })
      expect(walletB.captureCalls).toHaveLength(0)
      expect(walletB.releaseCalls).toHaveLength(0)
      await expect(second.settlements.listReleaseTasks(auctionId)).resolves.toEqual([
        expect.objectContaining({
          status: ReleaseStatus.TerminalError,
          holdId: releaseBeforeRestart.holdId,
          operationId: releaseBeforeRestart.operationId,
          lastError: expect.any(String),
        }),
      ])
      await expect(second.settlements.getByAuctionId(auctionId)).resolves.toMatchObject({
        captureStatus: CaptureStatus.Confirmed,
        status: expect.not.stringMatching('COMPLETED'),
      })
      const row = await db
        .selectFrom('auction_settlement_releases')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .where('bid_id', '=', `${auctionId}-loser`)
        .executeTakeFirstOrThrow()
      expect(row.count).toBe(1)
    })

    it('reproduce settlement WITH_WINNER COMPLETED sin nuevas operaciones tras restart', async () => {
      const auctionId = 'settle-auction-completed-restart'
      await withWinnerFixture(auctionId, true)
      const first = createSettleAuctionForDb(new FakeDbWallet('SUCCESS', 'SUCCESS'))
      await first.useCase.execute({ auctionId })
      await expect(first.useCase.execute({ auctionId })).resolves.toMatchObject({
        status: AuctionSettlementStatus.Completed,
        captureStatus: CaptureStatus.Confirmed,
      })
      const auctionBeforeRestart = await first.auctions.findAuctionAggregate(auctionId)
      const settlementBeforeRestart = await first.settlements.getByAuctionId(auctionId)
      const releaseBeforeRestart = (await first.settlements.listReleaseTasks(auctionId))[0]
      if (
        auctionBeforeRestart === null ||
        settlementBeforeRestart === null ||
        releaseBeforeRestart === undefined
      ) {
        throw new Error('Estado durable esperado.')
      }
      expect(releaseBeforeRestart.status).toBe(ReleaseStatus.Released)

      const walletB = new FakeDbWallet('TERMINAL_CONFLICT', 'TERMINAL_CONFLICT')
      const second = createSettleAuctionForDb(walletB)
      await expect(second.useCase.execute({ auctionId })).resolves.toMatchObject({
        status: AuctionSettlementStatus.Completed,
      })
      expect(walletB.captureCalls).toHaveLength(0)
      expect(walletB.releaseCalls).toHaveLength(0)
      await expect(second.auctions.findAuctionAggregate(auctionId)).resolves.toEqual(
        auctionBeforeRestart,
      )
      await expect(second.settlements.getByAuctionId(auctionId)).resolves.toEqual(
        settlementBeforeRestart,
      )
      await expect(second.settlements.listReleaseTasks(auctionId)).resolves.toEqual([
        releaseBeforeRestart,
      ])
      const settlements = await db
        .selectFrom('auction_settlements')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .executeTakeFirstOrThrow()
      const releases = await db
        .selectFrom('auction_settlement_releases')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('auction_id', '=', auctionId)
        .where('bid_id', '=', `${auctionId}-loser`)
        .executeTakeFirstOrThrow()
      expect(settlements.count).toBe(1)
      expect(releases.count).toBe(1)
    })

    const classifyPersistedLoser = async (
      status: 'COMPLETED' | 'COMPENSATION_PENDING',
      holdId: string | null,
    ) => {
      const auctionId = `hu63-${status}-${holdId ?? 'missing'}`
      const repository = new PostgresAuctionRepository(db)
      await repository.publish(publication(auctionId))
      const loser = bid(
        `${auctionId}-bid`,
        auctionId,
        'loser',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )
      await repository.persistBid(loser, holdId)
      await repository.createBidCreditOperation({
        operationId: `${auctionId}:operation`,
        bidId: `${auctionId}-next`,
        auctionId,
        bidderId: 'next',
        amountCredits: 30,
        createdAt: now,
      })
      await repository.updateBidCreditOperation({
        operationId: `${auctionId}:operation`,
        status,
        reservationId: 'new-hold',
        previousReservationId: holdId,
        updatedAt: now,
      })
      return {
        auctionId,
        loser: { ...loser.snapshot(), ...(holdId === null ? {} : { creditReservationId: holdId }) },
        operationId: `${auctionId}:operation`,
      }
    }

    it('clasifica durablemente un hold HU-63 ya liberado', async () => {
      const scenario = await classifyPersistedLoser('COMPLETED', 'hold-released')
      const actions = await new ClassifyAuctionLoserCredits(
        new PostgresBidCreditOperationReader(db),
      ).execute(scenario.auctionId, [scenario.loser], null)
      expect(actions).toMatchObject([{ classification: 'ALREADY_RELEASED' }])
    })

    it('reutiliza durablemente operationId HU-63 pendiente sin duplicar task', async () => {
      const scenario = await classifyPersistedLoser('COMPENSATION_PENDING', 'hold-pending')
      const actions = await new ClassifyAuctionLoserCredits(
        new PostgresBidCreditOperationReader(db),
      ).execute(scenario.auctionId, [scenario.loser], null)
      const settlements = new PostgresAuctionSettlementRepository(db)
      const prepare = new PrepareAuctionLoserReleaseTasks(settlements)
      await prepare.execute(actions, now)
      await prepare.execute(actions, now)
      await expect(settlements.listReleaseTasks(scenario.auctionId)).resolves.toMatchObject([
        { operationId: scenario.operationId, holdId: 'hold-pending' },
      ])
    })

    it('clasifica durablemente un hold activo y prepara operationId HU-65', async () => {
      const auctionId = 'hu63-active'
      const actions = await new ClassifyAuctionLoserCredits(
        new PostgresBidCreditOperationReader(db),
      ).execute(
        auctionId,
        [
          {
            id: 'loser',
            auctionId,
            bidderId: 'loser',
            amountCredits: 20,
            placedAt: now,
            creditReservationId: 'hold-active',
          },
        ],
        null,
      )
      const settlements = new PostgresAuctionSettlementRepository(db)
      await new PrepareAuctionLoserReleaseTasks(settlements).execute(actions, now)
      await expect(settlements.listReleaseTasks(auctionId)).resolves.toMatchObject([
        { operationId: 'auction:hu63-active:bid:loser:release' },
      ])
    })

    it('clasifica durablemente una compensacion sin hold como inconsistente', async () => {
      const scenario = await classifyPersistedLoser('COMPENSATION_PENDING', null)
      const actions = await new ClassifyAuctionLoserCredits(
        new PostgresBidCreditOperationReader(db),
      ).execute(scenario.auctionId, [scenario.loser], null)
      expect(actions).toMatchObject([{ classification: 'INCONSISTENT' }])
    })

    it('crea settlement idempotentemente y conserva el registro durable', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      const input = winnerSettlement('settlement-idempotent')
      const first = await repository.createIfAbsent(input)
      const replay = await repository.createIfAbsent({
        ...input,
        createdAt: new Date('2027-01-01'),
      })

      expect(first).toEqual(replay)
      await expect(repository.getByAuctionId(input.auctionId)).resolves.toMatchObject({
        status: AuctionSettlementStatus.CapturePending,
        captureStatus: CaptureStatus.Pending,
        captureOperationId: input.captureOperationId,
      })
      const { amount } = await db
        .selectFrom('auction_settlements')
        .select(sql<number>`count(*)::integer`.as('amount'))
        .where('auction_id', '=', input.auctionId)
        .executeTakeFirstOrThrow()
      expect(amount).toBe(1)
    })

    it('mantiene un solo settlement ante createIfAbsent concurrente', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      const input = winnerSettlement('settlement-concurrent')
      const [left, right] = await Promise.all([
        repository.createIfAbsent(input),
        repository.createIfAbsent(input),
      ])

      expect(left).toEqual(right)
      const { amount } = await db
        .selectFrom('auction_settlements')
        .select(sql<number>`count(*)::integer`.as('amount'))
        .where('auction_id', '=', input.auctionId)
        .executeTakeFirstOrThrow()
      expect(amount).toBe(1)
    })

    it('rechaza un intent de settlement incompatible y acepta replay identico', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      const input = winnerSettlement('settlement-conflict')
      await repository.createIfAbsent(input)
      await expect(
        repository.createIfAbsent({ ...input, winningHoldId: 'other-hold' }),
      ).rejects.toThrow('Conflicto de intent')
      await expect(
        repository.createIfAbsent({ ...input, createdAt: new Date('2027-01-01') }),
      ).resolves.toMatchObject({ winningHoldId: input.winningHoldId })
    })

    it('mantiene un release unico y persiste sus transiciones', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      const auctionId = 'settlement-release'
      await repository.createIfAbsent(winnerSettlement(auctionId))
      const release = {
        auctionId,
        bidId: 'loser-bid',
        holdId: 'loser-hold',
        operationId: 'auction:settlement-release:release:loser-bid',
        createdAt: new Date('2026-09-23T12:00:00.000Z'),
      }
      const [left, right] = await Promise.all([
        repository.createReleaseIfAbsent(release),
        repository.createReleaseIfAbsent(release),
      ])

      expect(left).toEqual(right)
      await repository.markReleaseRetryable(
        auctionId,
        release.bidId,
        'timeout',
        new Date('2026-09-23T12:01:00.000Z'),
      )
      await expect(repository.listPendingReleaseTasks(auctionId)).resolves.toMatchObject([
        { status: ReleaseStatus.Retryable },
      ])
      await repository.markReleaseConfirmed(
        auctionId,
        release.bidId,
        new Date('2026-09-23T12:02:00.000Z'),
      )
      await expect(
        repository.markReleaseRetryable(auctionId, release.bidId, 'again', new Date()),
      ).rejects.toThrow()
      const { amount } = await db
        .selectFrom('auction_settlement_releases')
        .select(sql<number>`count(*)::integer`.as('amount'))
        .where('auction_id', '=', auctionId)
        .where('bid_id', '=', release.bidId)
        .executeTakeFirstOrThrow()
      expect(amount).toBe(1)
    })

    it('rechaza un intent de release incompatible y acepta replay identico', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      const auctionId = 'settlement-release-conflict'
      await repository.createIfAbsent(winnerSettlement(auctionId))
      const release = {
        auctionId,
        bidId: 'loser',
        holdId: 'hold',
        operationId: 'release-op',
        createdAt: now,
      }
      await repository.createReleaseIfAbsent(release)
      await expect(
        repository.createReleaseIfAbsent({ ...release, holdId: 'other' }),
      ).rejects.toThrow('Conflicto de intent')
      await expect(
        repository.createReleaseIfAbsent({ ...release, createdAt: new Date('2027-01-01') }),
      ).resolves.toMatchObject({ holdId: 'hold', operationId: 'release-op' })
    })

    it('persiste PENDING -> RETRYABLE -> CONFIRMED para capture', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      const auctionId = 'settlement-capture'
      await repository.createIfAbsent(winnerSettlement(auctionId))
      await repository.markCaptureRetryable(
        auctionId,
        'timeout',
        new Date('2026-09-23T12:01:00.000Z'),
      )
      await expect(repository.getByAuctionId(auctionId)).resolves.toMatchObject({
        captureStatus: CaptureStatus.Retryable,
      })
      await repository.markCaptureConfirmed(auctionId, new Date('2026-09-23T12:02:00.000Z'))
      await expect(repository.getByAuctionId(auctionId)).resolves.toMatchObject({
        captureStatus: CaptureStatus.Confirmed,
      })
      await expect(
        repository.markCaptureRetryable(auctionId, 'again', new Date()),
      ).rejects.toThrow()
    })

    it('completa WITHOUT_BIDS sin captura', async () => {
      const repository = new PostgresAuctionSettlementRepository(db)
      await repository.createIfAbsent({
        auctionId: 'settlement-empty',
        resultType: 'WITHOUT_BIDS',
        sellerId: 'seller-1',
        createdAt: new Date('2026-09-23T12:00:00.000Z'),
      })
      await repository.markCompleted('settlement-empty', new Date('2026-09-23T12:01:00.000Z'))

      await expect(repository.getByAuctionId('settlement-empty')).resolves.toMatchObject({
        status: AuctionSettlementStatus.Completed,
        captureStatus: CaptureStatus.NotRequired,
        winningBidId: null,
        winnerId: null,
        winningHoldId: null,
        finalAmountCredits: null,
        captureOperationId: null,
      })
    })

    it('rehidrata desde PostgreSQL un cierre WITH_WINNER', async () => {
      const repository = new PostgresAuctionRepository(db)
      const command = publication('auction-finished-winner')
      const finishedAt = new Date('2026-09-23T12:00:00.000Z')
      const closingResult = AuctionClosingResult.withWinner({
        finishedAt,
        bidderId: 'winner-1',
        bidId: 'winning-bid-1',
        amountCredits: 30,
      })

      await repository.publish(command)
      await repository.finishAuction({
        auctionId: command.auction.snapshot().id,
        finishedAt,
        closingResult,
      })

      const rehydrated = await repository.findAuctionAggregate(command.auction.snapshot().id)

      expect(rehydrated).not.toBeNull()
      expect(rehydrated?.status).toBe('FINISHED')
      expect(rehydrated?.finishedAt).toEqual(finishedAt)
      expect(rehydrated?.closingResult).toEqual({
        outcome: AuctionClosingOutcome.WithWinner,
        finishedAt,
        winnerId: 'winner-1',
        winningBidId: 'winning-bid-1',
        finalAmountCredits: 30,
      })
      expectRehydratedAuctionToRejectSecondFinish(rehydrated!)
    })

    it('rehidrata desde PostgreSQL un cierre WITHOUT_BIDS', async () => {
      const repository = new PostgresAuctionRepository(db)
      const command = publication('auction-finished-without-bids')
      const finishedAt = new Date('2026-09-23T12:00:00.000Z')
      const closingResult = AuctionClosingResult.withoutBids(finishedAt)

      await repository.publish(command)
      await repository.finishAuction({
        auctionId: command.auction.snapshot().id,
        finishedAt,
        closingResult,
      })

      const rehydrated = await repository.findAuctionAggregate(command.auction.snapshot().id)

      expect(rehydrated).not.toBeNull()
      expect(rehydrated?.status).toBe('FINISHED')
      expect(rehydrated?.finishedAt).toEqual(finishedAt)
      expect(rehydrated?.closingResult).toEqual({
        outcome: AuctionClosingOutcome.WithoutBids,
        finishedAt,
        winnerId: null,
        winningBidId: null,
        finalAmountCredits: null,
      })
      expectRehydratedAuctionToRejectSecondFinish(rehydrated!)
    })

    it('rechaza un segundo cierre y conserva el primer resultado persistido', async () => {
      const repository = new PostgresAuctionRepository(db)
      const command = publication('auction-finished-once')
      const firstFinishedAt = new Date('2026-09-23T12:00:00.000Z')
      const firstResult = AuctionClosingResult.withWinner({
        finishedAt: firstFinishedAt,
        bidderId: 'winner-a',
        bidId: 'winning-bid-a',
        amountCredits: 40,
      })

      await repository.publish(command)
      await repository.finishAuction({
        auctionId: command.auction.snapshot().id,
        finishedAt: firstFinishedAt,
        closingResult: firstResult,
      })
      await expect(
        repository.finishAuction({
          auctionId: command.auction.snapshot().id,
          finishedAt: new Date('2026-09-24T12:00:00.000Z'),
          closingResult: AuctionClosingResult.withoutBids(new Date('2026-09-24T12:00:00.000Z')),
        }),
      ).rejects.toThrow('ya fue finalizada')

      await expect(
        repository.findAuctionAggregate(command.auction.snapshot().id),
      ).resolves.toMatchObject({
        status: 'FINISHED',
        finishedAt: firstFinishedAt,
        closingResult: {
          outcome: AuctionClosingOutcome.WithWinner,
          finishedAt: firstFinishedAt,
          winnerId: 'winner-a',
          winningBidId: 'winning-bid-a',
          finalAmountCredits: 40,
        },
      })
    })

    /** Verifica las migraciones de creditos mediante operaciones reales e idempotentes. */
    it('persiste reservas, cambio de lider y estado de creditos atomicamente', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publish(publication('auction-credit-flow'))
      const now = new Date('2026-09-21T12:00:10.000Z')
      const first = bid('bid-credit-first', 'auction-credit-flow', 'bidder-1', 20, now, null)
      const second = bid('bid-credit-second', 'auction-credit-flow', 'bidder-2', 30, now, 20)
      const command = {
        operationId: 'credit-flow',
        bidId: second.snapshot().id,
        auctionId: 'auction-credit-flow',
        bidderId: 'bidder-2',
        amountCredits: 30,
        createdAt: now,
      }
      await expect(repository.findBidCreditOperation(command.operationId)).resolves.toBeNull()
      await repository.createBidCreditOperation(command)
      await repository.createBidCreditOperation(command)
      await expect(repository.findBidCreditOperation(command.operationId)).resolves.toEqual({
        ...command,
        status: 'PENDING_RESERVATION',
        reservationId: null,
        previousReservationId: null,
        updatedAt: now,
      })
      await expect(
        repository.createBidCreditOperation({ ...command, amountCredits: 40 }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
      await expect(
        repository.createBidCreditOperation({ ...command, operationId: 'another-operation' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
      await repository.updateBidCreditOperation({
        operationId: command.operationId,
        status: 'RESERVED',
        reservationId: 'reserve-second',
        previousReservationId: null,
        updatedAt: now,
      })
      await repository.persistBid(first, 'reserve-first')
      await expect(
        repository.persistBid(second, 'reserve-second', command.operationId),
      ).resolves.toEqual({
        bid: second.snapshot(),
        previousLeader: { ...first.snapshot(), creditReservationId: 'reserve-first' },
        previousLeaderReservationId: 'reserve-first',
      })
      await expect(repository.findBidCreditOperation(command.operationId)).resolves.toMatchObject({
        status: 'BID_PERSISTED',
        reservationId: 'reserve-second',
        previousReservationId: 'reserve-first',
      })
    })

    it('rechaza operaciones de creditos inexistentes o de otra puja sin efectos parciales', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publish(publication('auction-credit-invalid'))
      const now = new Date('2026-09-21T12:00:10.000Z')
      const candidate = bid(
        'bid-credit-invalid',
        'auction-credit-invalid',
        'bidder-1',
        20,
        now,
        null,
      )
      await expect(
        repository.updateBidCreditOperation({
          operationId: 'missing',
          status: 'RESERVED',
          reservationId: 'reserve',
          previousReservationId: null,
          updatedAt: now,
        }),
      ).rejects.toThrow('no existe')
      await expect(repository.persistBid(candidate, 'reserve', 'missing')).rejects.toThrow(
        'no existe',
      )
      await repository.createBidCreditOperation({
        operationId: 'wrong-intent',
        bidId: 'different-bid',
        auctionId: 'auction-credit-invalid',
        bidderId: 'bidder-1',
        amountCredits: 20,
        createdAt: now,
      })
      await expect(
        repository.persistBid(candidate, 'reserve', 'wrong-intent'),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
      await expect(repository.findLeadingBid('auction-credit-invalid')).resolves.toBeNull()
      await expect(repository.findBidHistory('auction-credit-invalid')).resolves.toEqual([])
    })

    it('actualiza el fallo de compensacion sin duplicar el registro', async () => {
      const repository = new PostgresAuctionRepository(db)
      const failure = {
        operationId: 'credit-failure',
        bidId: 'bid-failure',
        auctionId: 'auction-failure',
        bidderId: 'bidder-1',
        stage: 'RELEASING_NEW_RESERVATION' as const,
        reason: 'offline',
        newReservationId: 'reserve',
        previousReservationId: null,
        newReservationReleased: false,
        previousReservationReleased: false,
        occurredAt: new Date('2026-09-21T12:00:00.000Z'),
      }
      await repository.recordBidCreditFailure(failure)
      await repository.recordBidCreditFailure({
        ...failure,
        reason: 'recovered',
        newReservationReleased: true,
      })
      const rows = await db
        .selectFrom('auction_bid_credit_failures')
        .selectAll()
        .where('operation_id', '=', failure.operationId)
        .execute()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ reason: 'recovered', new_reservation_released: true })
    })

    it('persiste la subasta, auditoria y outbox en una unidad atomica', async () => {
      const repository = new PostgresAuctionRepository(db)

      const result = await repository.publish(publication('auction-1'))

      expect(result.replayed).toBe(false)

      await expect(repository.findById('auction-1')).resolves.toEqual(result.auction)

      await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(1)

      const audit = await db.selectFrom('auction_audit_log').selectAll().execute()

      const outbox = await db.selectFrom('outbox_events').selectAll().execute()

      expect(audit).toHaveLength(1)

      expect(audit[0]).toMatchObject({
        auction_id: 'auction-1',
        operation_id: 'operation-auction-1',
        action: 'AUCTION_PUBLISHED',
      })

      expect(outbox).toHaveLength(1)

      expect(outbox[0]).toMatchObject({
        aggregate_id: 'auction-1',
        event_type: 'auction.published.v1',
        published_at: null,
      })
    })

    it('un reintento devuelve la publicacion sin duplicar efectos locales', async () => {
      const repository = new PostgresAuctionRepository(db)

      const command = publication('auction-idempotent')

      const retry = {
        ...publication('auction-generated-again', 'seller-1', 'product-auction-idempotent'),
        operationId: command.operationId,
      }

      await expect(repository.publish(command)).resolves.toMatchObject({
        replayed: false,
      })

      await expect(repository.publish(retry)).resolves.toMatchObject({
        replayed: true,
        auction: {
          id: 'auction-idempotent',
        },
      })

      const { amount } = await db
        .selectFrom('outbox_events')
        .select(
          sql<number>`
              count(*)::integer
            `.as('amount'),
        )
        .executeTakeFirstOrThrow()

      expect(amount).toBe(1)
    })

    it('revierte todos los registros si la publicacion viola una restriccion', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-first', 'seller-1', 'same-product'))

      await expect(
        repository.publish(publication('auction-failed', 'seller-2', 'same-product')),
      ).rejects.toBeDefined()

      await expect(repository.findById('auction-failed')).resolves.toBeNull()

      const operation = await db
        .selectFrom('auction_publication_operations')
        .selectAll()
        .where('operation_id', '=', 'operation-auction-failed')
        .executeTakeFirst()

      expect(operation).toBeUndefined()
    })

    it('serializa publicaciones concurrentes y no supera diez activas', async () => {
      const repository = new PostgresAuctionRepository(db)

      await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          repository.publish(publication(`auction-${String(index)}`, 'seller-limit')),
        ),
      )

      const outcomes = await Promise.allSettled([
        repository.publish(publication('auction-9', 'seller-limit')),
        repository.publish(publication('auction-10', 'seller-limit')),
      ])

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)

      const rejected = outcomes.find(({ status }) => status === 'rejected')

      expect(rejected).toMatchObject({
        reason: expect.any(ActiveAuctionLimitExceededError),
      })

      await expect(repository.countActiveBySeller('seller-limit')).resolves.toBe(10)
    })

    it('permanece disponible desde una conexion nueva', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-durable'))

      const restarted = createDatabase({
        connectionString: container.getConnectionUri(),
      })

      try {
        await expect(
          new PostgresAuctionRepository(restarted).findById('auction-durable'),
        ).resolves.toMatchObject({
          id: 'auction-durable',
          status: 'ACTIVE',
        })
      } finally {
        await restarted.destroy()
      }
    })

    it('registra y actualiza de forma idempotente un fallo compensable', async () => {
      const repository = new PostgresAuctionRepository(db)

      const failure = {
        operationId: 'operation-failed',
        auctionId: 'auction-failed',
        sellerId: 'seller-failed',
        stage: 'PERSISTING_AUCTION',
        reason: 'database unavailable',
        feeChargeId: 'charge-failed',
        inventoryCommitmentId: 'commitment-failed',
        feeRefunded: false,
        inventoryReleased: false,
        occurredAt: new Date('2026-09-21T12:00:00.000Z'),
      }

      await repository.recordFailure(failure)

      await repository.recordFailure({
        ...failure,
        feeRefunded: true,
        inventoryReleased: true,
      })

      const rows = await db.selectFrom('auction_publication_failures').selectAll().execute()

      expect(rows).toHaveLength(1)

      expect(rows[0]).toMatchObject({
        fee_refunded: true,
        inventory_released: true,
      })
    })

    it('persiste la primera puja como lider', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-first'))

      const firstBid = bid(
        'bid-1',
        'auction-bid-first',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      await expect(repository.persistBid(firstBid)).resolves.toEqual({
        bid: firstBid.snapshot(),
        previousLeader: null,
        previousLeaderReservationId: null,
      })

      await expect(repository.findLeadingBid('auction-bid-first')).resolves.toEqual(
        firstBid.snapshot(),
      )

      const rows = await db
        .selectFrom('auction_bids')
        .selectAll()
        .where('auction_id', '=', 'auction-bid-first')
        .execute()

      expect(rows).toHaveLength(1)

      expect(rows[0]).toMatchObject({
        id: 'bid-1',
        auction_id: 'auction-bid-first',
        bidder_id: 'bidder-1',
        amount_credits: 20,
        is_leader: true,
      })
    })

    it('reemplaza el lider anterior y conserva el historial', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-history'))

      const firstBid = bid(
        'bid-history-1',
        'auction-bid-history',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const secondBid = bid(
        'bid-history-2',
        'auction-bid-history',
        'bidder-2',
        30,
        new Date('2026-09-21T12:00:20.000Z'),
        20,
      )

      await repository.persistBid(firstBid)

      await expect(repository.persistBid(secondBid)).resolves.toEqual({
        bid: secondBid.snapshot(),
        previousLeader: firstBid.snapshot(),
        previousLeaderReservationId: null,
      })

      await expect(repository.findLeadingBid('auction-bid-history')).resolves.toEqual(
        secondBid.snapshot(),
      )

      await expect(repository.findBidHistory('auction-bid-history')).resolves.toEqual([
        firstBid.snapshot(),
        secondBid.snapshot(),
      ])

      const rows = await db
        .selectFrom('auction_bids')
        .select(['id', 'is_leader'])
        .where('auction_id', '=', 'auction-bid-history')
        .orderBy('placed_at', 'asc')
        .execute()

      expect(rows).toEqual([
        {
          id: 'bid-history-1',
          is_leader: false,
        },
        {
          id: 'bid-history-2',
          is_leader: true,
        },
      ])
    })

    it('devuelve la ultima puja realizada por un jugador', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-last-bid-1'))

      await repository.publish(publication('auction-last-bid-2'))

      const firstBid = bid(
        'bid-last-1',
        'auction-last-bid-1',
        'bidder-last',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const secondBid = bid(
        'bid-last-2',
        'auction-last-bid-2',
        'bidder-last',
        30,
        new Date('2026-09-21T12:00:20.000Z'),
        null,
      )

      const anotherBid = bid(
        'bid-another',
        'auction-last-bid-1',
        'bidder-other',
        30,
        new Date('2026-09-21T12:00:30.000Z'),
        20,
      )

      await repository.persistBid(firstBid)

      await repository.persistBid(secondBid)

      await repository.persistBid(anotherBid)

      await expect(repository.findLastBidByBidder('bidder-last')).resolves.toEqual(
        secondBid.snapshot(),
      )

      await expect(repository.findLastBidByBidder('bidder-without-bids')).resolves.toBeNull()
    })

    it('cuenta solo las pujas activas donde el jugador sigue siendo lider', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-active-bid-1'))

      await repository.publish(publication('auction-active-bid-2'))

      await repository.publish(publication('auction-active-bid-3'))

      const leadingFirstAuction = bid(
        'bid-active-1',
        'auction-active-bid-1',
        'bidder-active',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const leadingSecondAuction = bid(
        'bid-active-2',
        'auction-active-bid-2',
        'bidder-active',
        20,
        new Date('2026-09-21T12:00:20.000Z'),
        null,
      )

      const initiallyLeadingThirdAuction = bid(
        'bid-active-3',
        'auction-active-bid-3',
        'bidder-active',
        20,
        new Date('2026-09-21T12:00:30.000Z'),
        null,
      )

      const replacementThirdAuction = bid(
        'bid-active-replacement',
        'auction-active-bid-3',
        'bidder-other',
        30,
        new Date('2026-09-21T12:00:40.000Z'),
        20,
      )

      await repository.persistBid(leadingFirstAuction)

      await repository.persistBid(leadingSecondAuction)

      await repository.persistBid(initiallyLeadingThirdAuction)

      await repository.persistBid(replacementThirdAuction)

      await expect(repository.countActiveBidsByBidder('bidder-active')).resolves.toBe(2)

      await expect(repository.countActiveBidsByBidder('bidder-other')).resolves.toBe(1)

      await expect(repository.countActiveBidsByBidder('bidder-without-active-bids')).resolves.toBe(
        0,
      )
    })

    it('rechaza un identificador de puja duplicado', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-duplicate'))

      const firstBid = bid(
        'bid-duplicate',
        'auction-bid-duplicate',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      await repository.persistBid(firstBid)

      await expect(repository.persistBid(firstBid)).rejects.toBeInstanceOf(BidAlreadyExistsError)

      await expect(repository.findBidHistory('auction-bid-duplicate')).resolves.toHaveLength(1)
    })

    it('rechaza persistir una puja para una subasta inexistente', async () => {
      const repository = new PostgresAuctionRepository(db)

      const orphanBid = bid(
        'bid-orphan',
        'auction-does-not-exist',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      await expect(repository.persistBid(orphanBid)).rejects.toBeInstanceOf(
        PersistedAuctionNotFoundError,
      )

      const rows = await db
        .selectFrom('auction_bids')
        .selectAll()
        .where('id', '=', 'bid-orphan')
        .execute()

      expect(rows).toHaveLength(0)
    })

    it('serializa pujas concurrentes y mantiene un unico lider', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-concurrent'))

      const lowerBid = bid(
        'bid-concurrent-20',
        'auction-bid-concurrent',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const higherBid = bid(
        'bid-concurrent-30',
        'auction-bid-concurrent',
        'bidder-2',
        30,
        new Date('2026-09-21T12:00:11.000Z'),
        null,
      )

      const [lowerResult, higherResult] = await Promise.allSettled([
        repository.persistBid(lowerBid),
        repository.persistBid(higherBid),
      ])

      expect(higherResult.status).toBe('fulfilled')

      if (lowerResult.status === 'fulfilled') {
        expect(lowerResult.value.bid).toEqual(lowerBid.snapshot())
      } else {
        expect(lowerResult.reason).toBeInstanceOf(ConcurrentBidConflictError)
      }

      const history = await repository.findBidHistory('auction-bid-concurrent')

      expect(history).toHaveLength(lowerResult.status === 'fulfilled' ? 2 : 1)
      expect(history.some((entry) => entry.id === higherBid.snapshot().id)).toBe(true)

      await expect(repository.findLeadingBid('auction-bid-concurrent')).resolves.toEqual(
        higherBid.snapshot(),
      )

      const leaders = await db
        .selectFrom('auction_bids')
        .select(['id', 'amount_credits'])
        .where('auction_id', '=', 'auction-bid-concurrent')
        .where('is_leader', '=', true)
        .execute()

      expect(leaders).toHaveLength(1)

      expect(leaders[0]).toEqual({
        id: 'bid-concurrent-30',
        amount_credits: 30,
      })
    })

    it('conserva solo la reserva del lider cuando compiten dos pujas', async () => {
      const repository = new PostgresAuctionRepository(db)
      const auctionId = 'auction-concurrent-credits'

      await repository.publish(publication(auctionId))

      const activeReservations = new Set<string>()
      const reserve = jest.fn((command: ReserveBidCreditsCommand) => {
        const reservationId = `reservation-${command.bidId}`
        activeReservations.add(reservationId)
        return Promise.resolve({ reservationId })
      })
      const release = jest.fn((operationId: string, reservationId: string) => {
        void operationId
        activeReservations.delete(reservationId)
        return Promise.resolve()
      })
      const credits: BidCreditsPort = {
        getAvailableCredits: () => Promise.resolve({ availableCredits: 100 }),
        reserve,
        release,
      }
      const clock = { now: (): Date => new Date('2026-09-21T12:00:10.000Z') }
      const persistence = new PersistBidWithCredits(repository, credits, clock)

      const lowerBid = bid(
        'bid-credit-concurrent-20',
        auctionId,
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )
      const higherBid = bid(
        'bid-credit-concurrent-30',
        auctionId,
        'bidder-2',
        30,
        new Date('2026-09-21T12:00:11.000Z'),
        null,
      )

      const [lowerResult, higherResult] = await Promise.allSettled([
        persistence.execute({
          operationId: 'operation-credit-concurrent-20',
          bid: lowerBid,
          expiresAt: new Date('2026-09-22T12:00:00.000Z'),
        }),
        persistence.execute({
          operationId: 'operation-credit-concurrent-30',
          bid: higherBid,
          expiresAt: new Date('2026-09-22T12:00:00.000Z'),
        }),
      ])

      expect(higherResult.status).toBe('fulfilled')
      if (lowerResult.status === 'rejected') {
        expect(lowerResult.reason).toBeInstanceOf(ConcurrentBidConflictError)
      }

      await expect(repository.findLeadingBid(auctionId)).resolves.toEqual({
        ...higherBid.snapshot(),
        creditReservationId: 'reservation-bid-credit-concurrent-30',
      })
      expect(activeReservations).toEqual(new Set(['reservation-bid-credit-concurrent-30']))
      expect(reserve).toHaveBeenCalledTimes(2)
      expect(release).toHaveBeenCalledTimes(1)
      await expect(
        repository.findBidCreditOperation('operation-credit-concurrent-30'),
      ).resolves.toMatchObject({ status: 'COMPLETED' })
      await expect(
        repository.findBidCreditOperation('operation-credit-concurrent-20'),
      ).resolves.toMatchObject({
        status: lowerResult.status === 'fulfilled' ? 'COMPLETED' : 'COMPENSATED',
      })
    })

    describe('compra inmediata HU-64', () => {
      const closeCommand = (
        auctionId: string,
        overrides: Partial<Parameters<PostgresAuctionRepository['closeByBuyNow']>[0]> = {},
      ) => ({
        operationId: `operation-buy-now-${auctionId}`,
        transactionId: `txn-${auctionId}`,
        auctionId,
        buyerId: 'buyer-1',
        transferId: `transfer-${auctionId}`,
        priceCredits: 20,
        remainingCredits: 80,
        closedAt: new Date('2026-09-21T15:00:00.000Z'),
        ...overrides,
      })

      it('CA-01: cierra la subasta y deja auditoria y outbox para HU-64.5', async () => {
        const repository = new PostgresAuctionRepository(db)

        await repository.publish(publication('auction-buy-now-1'))

        const result = await repository.closeByBuyNow(closeCommand('auction-buy-now-1'))

        expect(result).toEqual({
          auction: expect.objectContaining({
            id: 'auction-buy-now-1',
            status: AuctionStatus.SoldByBuyNow,
            closesAt: new Date('2026-09-21T15:00:00.000Z'),
          }),
          transactionId: 'txn-auction-buy-now-1',
          replayed: false,
        })

        const audit = await db
          .selectFrom('auction_audit_log')
          .selectAll()
          .where('action', '=', 'AUCTION_CLOSED_BY_BUY_NOW')
          .execute()

        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({
          auction_id: 'auction-buy-now-1',
          actor_id: 'buyer-1',
        })

        const outbox = await db
          .selectFrom('outbox_events')
          .selectAll()
          .where('event_type', '=', 'auction.closed_by_buy_now.v1')
          .execute()

        expect(outbox).toHaveLength(1)
        expect(outbox[0]).toMatchObject({
          aggregate_id: 'auction-buy-now-1',
          published_at: null,
        })
        expect(outbox[0]?.payload).toMatchObject({
          auctionId: 'auction-buy-now-1',
          productId: 'product-auction-buy-now-1',
        })
      })

      it('reintentar el mismo operationId devuelve la misma confirmacion sin duplicar efectos', async () => {
        const repository = new PostgresAuctionRepository(db)

        await repository.publish(publication('auction-buy-now-retry'))

        const command = closeCommand('auction-buy-now-retry')

        const first = await repository.closeByBuyNow(command)
        const second = await repository.closeByBuyNow(command)

        expect(second).toEqual({ ...first, replayed: true })

        const { amount } = await db
          .selectFrom('outbox_events')
          .select(
            sql<number>`
              count(*)::integer
            `.as('amount'),
          )
          .where('event_type', '=', 'auction.closed_by_buy_now.v1')
          .executeTakeFirstOrThrow()

        expect(amount).toBe(1)
      })

      it('rechaza reutilizar el operationId con datos distintos', async () => {
        const repository = new PostgresAuctionRepository(db)

        await repository.publish(publication('auction-buy-now-conflict'))

        await repository.closeByBuyNow(closeCommand('auction-buy-now-conflict'))

        await expect(
          repository.closeByBuyNow({
            ...closeCommand('auction-buy-now-conflict'),
            priceCredits: 999,
          }),
        ).rejects.toBeInstanceOf(BuyNowIdempotencyConflictError)
      })

      it('rechaza cerrar una subasta inexistente', async () => {
        const repository = new PostgresAuctionRepository(db)

        await expect(
          repository.closeByBuyNow(closeCommand('auction-does-not-exist')),
        ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)
      })

      it('rechaza cerrar una subasta que ya fue vendida', async () => {
        const repository = new PostgresAuctionRepository(db)

        await repository.publish(publication('auction-buy-now-closed'))

        await repository.closeByBuyNow(closeCommand('auction-buy-now-closed'))

        await expect(
          repository.closeByBuyNow(
            closeCommand('auction-buy-now-closed', {
              operationId: 'operation-buy-now-closed-otra',
              transactionId: 'txn-otra',
              transferId: 'transfer-otra',
            }),
          ),
        ).rejects.toBeInstanceOf(AuctionAlreadyClosedError)
      })

      it('serializa dos compras inmediatas concurrentes: solo una cierra la subasta', async () => {
        const repository = new PostgresAuctionRepository(db)

        await repository.publish(publication('auction-buy-now-concurrent'))

        const outcomes = await Promise.allSettled([
          repository.closeByBuyNow(
            closeCommand('auction-buy-now-concurrent', {
              operationId: 'operation-race-1',
              transactionId: 'txn-race-1',
              transferId: 'transfer-race-1',
              buyerId: 'buyer-1',
            }),
          ),
          repository.closeByBuyNow(
            closeCommand('auction-buy-now-concurrent', {
              operationId: 'operation-race-2',
              transactionId: 'txn-race-2',
              transferId: 'transfer-race-2',
              buyerId: 'buyer-2',
            }),
          ),
        ])

        expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)

        const rejected = outcomes.find(({ status }) => status === 'rejected')

        expect(rejected).toMatchObject({ reason: expect.any(AuctionAlreadyClosedError) })

        await expect(repository.findById('auction-buy-now-concurrent')).resolves.toMatchObject({
          status: AuctionStatus.SoldByBuyNow,
        })

        const operations = await db.selectFrom('auction_buy_now_operations').selectAll().execute()

        expect(operations).toHaveLength(1)
      })

      it('findBuyNowOperation reconstruye la confirmacion sin volver a evaluar la subasta', async () => {
        const repository = new PostgresAuctionRepository(db)

        await repository.publish(publication('auction-buy-now-lookup'))

        await expect(repository.findBuyNowOperation('operation-inexistente')).resolves.toBeNull()

        await repository.closeByBuyNow(closeCommand('auction-buy-now-lookup'))

        const found = await repository.findBuyNowOperation(
          'operation-buy-now-auction-buy-now-lookup',
        )

        expect(found).toMatchObject({
          transactionId: 'txn-auction-buy-now-lookup',
          buyerId: 'buyer-1',
          transferId: 'transfer-auction-buy-now-lookup',
          priceCredits: 20,
          remainingCredits: 80,
          auction: expect.objectContaining({
            id: 'auction-buy-now-lookup',
            status: AuctionStatus.SoldByBuyNow,
          }),
        })
      })

      it('registra y actualiza de forma idempotente un fallo de compra inmediata', async () => {
        const repository = new PostgresAuctionRepository(db)

        const failure = {
          operationId: 'operation-buy-now-failed',
          auctionId: 'auction-buy-now-failed',
          buyerId: 'buyer-1',
          stage: 'CLOSING_AUCTION',
          reason: 'timeout',
          transferId: 'transfer-failed',
          creditsReversed: false,
          occurredAt: new Date('2026-09-21T15:00:00.000Z'),
        }

        await repository.recordBuyNowFailure(failure)
        await repository.recordBuyNowFailure({ ...failure, creditsReversed: true })

        const rows = await db.selectFrom('auction_buy_now_failures').selectAll().execute()

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ credits_reversed: true })
      })

      it('findBidCreditOperationByBid encuentra la operacion por bidId, no por operationId', async () => {
        const repository = new PostgresAuctionRepository(db)

        await expect(repository.findBidCreditOperationByBid('bid-lookup')).resolves.toBeNull()

        const createdAt = new Date('2026-09-21T12:00:10.000Z')

        await repository.createBidCreditOperation({
          operationId: 'operation-lookup',
          bidId: 'bid-lookup',
          auctionId: 'auction-lookup',
          bidderId: 'bidder-lookup',
          amountCredits: 25,
          createdAt,
        })

        await repository.updateBidCreditOperation({
          operationId: 'operation-lookup',
          status: 'RESERVED',
          reservationId: 'reservation-lookup',
          previousReservationId: null,
          updatedAt: createdAt,
        })

        await expect(repository.findBidCreditOperationByBid('bid-lookup')).resolves.toMatchObject({
          operationId: 'operation-lookup',
          bidId: 'bid-lookup',
          reservationId: 'reservation-lookup',
        })
      })
    })

    describe('notificaciones de cierre anticipado HU-64.5', () => {
      const pendingInput = (
        auctionId: string,
        overrides: Partial<
          Parameters<PostgresEarlyClosureNotificationRepository['ensurePending']>[0]
        > = {},
      ) => ({
        auctionId,
        bidderId: 'bidder-1',
        transactionId: 'txn-1',
        bidId: 'bid-1',
        amountCredits: 20,
        closedAt: new Date('2026-09-21T15:00:00.000Z'),
        creditOperationId: 'operation-1',
        creditReservationId: 'reservation-1',
        ...overrides,
      })

      it('crea el registro PENDING con creditsReleased derivado de la reserva', async () => {
        const repository = new PostgresEarlyClosureNotificationRepository(db)

        await new PostgresAuctionRepository(db).publish(publication('auction-notif-1'))

        const withReservation = await repository.ensurePending(pendingInput('auction-notif-1'))

        expect(withReservation).toMatchObject({
          status: 'PENDING',
          attempts: 0,
          creditsReleased: false,
          lastError: null,
        })

        const withoutReservation = await repository.ensurePending(
          pendingInput('auction-notif-1', {
            bidderId: 'bidder-2',
            creditOperationId: null,
            creditReservationId: null,
          }),
        )

        // Nada que liberar para este postor: nace ya liberado.
        expect(withoutReservation.creditsReleased).toBe(true)

        const rows = await db
          .selectFrom('auction_early_closure_notifications')
          .selectAll()
          .execute()

        expect(rows).toHaveLength(2)
      })

      it('reutiliza el registro existente en llamadas posteriores del mismo evento', async () => {
        const repository = new PostgresEarlyClosureNotificationRepository(db)

        await new PostgresAuctionRepository(db).publish(publication('auction-notif-2'))

        const first = await repository.ensurePending(pendingInput('auction-notif-2'))
        const second = await repository.ensurePending(
          pendingInput('auction-notif-2', { amountCredits: 999 }),
        )

        expect(second).toEqual(first)

        const rows = await db
          .selectFrom('auction_early_closure_notifications')
          .selectAll()
          .execute()

        expect(rows).toHaveLength(1)
      })

      it('recordAttempt actualiza el estado y findByAuction/findFailed lo reflejan', async () => {
        const repository = new PostgresEarlyClosureNotificationRepository(db)

        await new PostgresAuctionRepository(db).publish(publication('auction-notif-3'))

        await repository.ensurePending(pendingInput('auction-notif-3'))

        await repository.recordAttempt({
          auctionId: 'auction-notif-3',
          bidderId: 'bidder-1',
          transactionId: 'txn-1',
          status: 'FAILED',
          attempts: 1,
          creditsReleased: false,
          lastError: 'wallet caido',
          occurredAt: new Date('2026-09-21T15:05:00.000Z'),
        })

        await expect(repository.findByAuction('auction-notif-3')).resolves.toEqual([
          expect.objectContaining({
            status: 'FAILED',
            attempts: 1,
            creditsReleased: false,
            lastError: 'wallet caido',
          }),
        ])

        await expect(repository.findFailed()).resolves.toEqual([
          expect.objectContaining({ auctionId: 'auction-notif-3', status: 'FAILED' }),
        ])

        await repository.recordAttempt({
          auctionId: 'auction-notif-3',
          bidderId: 'bidder-1',
          transactionId: 'txn-1',
          status: 'SENT',
          attempts: 2,
          creditsReleased: true,
          lastError: null,
          occurredAt: new Date('2026-09-21T15:06:00.000Z'),
        })

        await expect(repository.findFailed()).resolves.toEqual([])
      })

      it('distingue notificaciones de distintos postores para la misma subasta', async () => {
        const repository = new PostgresEarlyClosureNotificationRepository(db)

        await new PostgresAuctionRepository(db).publish(publication('auction-notif-4'))

        await repository.ensurePending(pendingInput('auction-notif-4', { bidderId: 'bidder-1' }))
        await repository.ensurePending(
          pendingInput('auction-notif-4', { bidderId: 'bidder-2', bidId: 'bid-2' }),
        )

        await expect(repository.findByAuction('auction-notif-4')).resolves.toHaveLength(2)
      })
    })
  })

  describe('pending claims HU-65.3', () => {
    const persistAuctionForClaim = async (auctionId: string): Promise<void> => {
      await db
        .insertInto('auctions')
        .values({
          id: auctionId,
          seller_id: 'seller',
          product_id: `product-${auctionId}`,
          duration_hours: 24,
          publisher_type: 'PLAYER',
          price_kind: 'CREDITS',
          publication_fee_credits: 1,
          minimum_bid_credits: 1,
          buy_now_credits: null,
          status: 'FINISHED',
          published_at: new Date('2026-01-01'),
          closes_at: new Date('2026-01-02'),
          inventory_commitment_id: 'commitment',
          fee_charge_id: 'fee',
          finished_at: new Date('2026-01-02'),
          closing_result_type: 'WITH_WINNER',
          winning_bid_id: `bid-${auctionId}`,
          winner_id: 'winner',
          final_amount_credits: 30,
        })
        .execute()
    }
    const input = (auctionId: string) => ({
      auctionId,
      winnerId: 'winner',
      productId: `product-${auctionId}`,
      winningBidId: `bid-${auctionId}`,
      finalAmountCredits: 30,
      settledAt: new Date('2026-01-03'),
      createdAt: new Date('2026-01-03'),
    })
    it('persiste, reproduce, consulta y mantiene un unico claim tras concurrencia/restart', async () => {
      const auctionId = 'claim-durable'
      await persistAuctionForClaim(auctionId)
      const repository = new PostgresAuctionPendingClaimRepository(db)
      const [first, replay] = await Promise.all([
        repository.createIfAbsent(input(auctionId)),
        repository.createIfAbsent(input(auctionId)),
      ])
      expect(first).toEqual(replay)
      expect(
        (await repository.findPendingByWinnerId('winner')).some(
          (claim) => claim.auctionId === auctionId,
        ),
      ).toBe(true)
      const restarted = new PostgresAuctionPendingClaimRepository(db)
      await expect(restarted.findByAuctionId(auctionId)).resolves.toMatchObject({
        claimStatus: 'PENDING',
        productId: `product-${auctionId}`,
      })
      const count = await db
        .selectFrom('auction_pending_claims')
        .select(sql<string>`count(*)::text`.as('count'))
        .where('auction_id', '=', auctionId)
        .executeTakeFirstOrThrow()
      expect(count.count).toBe('1')
      await expect(
        repository.createIfAbsent({ ...input(auctionId), productId: 'other' }),
      ).rejects.toThrow('Conflicto de intent')
    })
    it('impone FK y constraints de claim', async () => {
      const now = new Date('2026-01-03')
      await expect(
        db
          .insertInto('auction_pending_claims')
          .values({
            auction_id: 'missing',
            winner_id: 'winner',
            product_id: 'product',
            winning_bid_id: 'bid',
            final_amount_credits: 1,
            settled_at: now,
            claim_status: 'PENDING',
            claimed_at: null,
            created_at: now,
            updated_at: now,
          })
          .execute(),
      ).rejects.toThrow()
      const auctionId = 'claim-constraints'
      await persistAuctionForClaim(auctionId)
      await expect(
        db
          .insertInto('auction_pending_claims')
          .values({
            auction_id: auctionId,
            winner_id: 'winner',
            product_id: 'product',
            winning_bid_id: 'bid',
            final_amount_credits: 0,
            settled_at: now,
            claim_status: 'PENDING',
            claimed_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute(),
      ).rejects.toThrow()
    })

    describe('findExpirablePending / markExpired (HU-69.6)', () => {
      it('el limite exacto del dia 7 no expira; 1 ms despues si, y registra auditoria', async () => {
        const boundaryId = 'claim-expire-boundary'
        const pastId = 'claim-expire-past'
        await persistAuctionForClaim(boundaryId)
        await persistAuctionForClaim(pastId)
        const repository = new PostgresAuctionPendingClaimRepository(db)
        const settledAt = new Date('2026-01-03T00:00:00.000Z')
        await repository.createIfAbsent({ ...input(boundaryId), settledAt, createdAt: settledAt })
        await repository.createIfAbsent({ ...input(pastId), settledAt, createdAt: settledAt })
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
        const deadline = new Date(settledAt.getTime() + sevenDaysMs)
        const pastDeadline = new Date(deadline.getTime() + 1)

        const atDeadline = await repository.findExpirablePending(deadline, 1_000)
        expect(atDeadline.map((c) => c.auctionId)).not.toEqual(
          expect.arrayContaining([boundaryId, pastId]),
        )
        // boundaryId y pastId comparten settledAt: en pastDeadline (1ms despues
        // del limite) ambos ya vencieron su propio claimDeadline y son
        // candidatos legitimos. La distincion real "limite exacto vs vencido"
        // se prueba comparando el resultado en `deadline` (ninguno) contra
        // `pastDeadline` (ambos), y con markExpired(boundaryId, deadline) abajo.
        const candidates = await repository.findExpirablePending(pastDeadline, 1_000)
        expect(candidates.map((c) => c.auctionId)).toEqual(
          expect.arrayContaining([boundaryId, pastId]),
        )

        await expect(repository.markExpired(boundaryId, deadline)).rejects.toThrow()
        await expect(repository.markExpired(pastId, pastDeadline)).resolves.toMatchObject({
          claimStatus: 'EXPIRED',
          claimedAt: null,
        })
        await expect(repository.findByAuctionId(boundaryId)).resolves.toMatchObject({
          claimStatus: 'PENDING',
        })

        const audit = await db
          .selectFrom('auction_audit_log')
          .selectAll()
          .where('auction_id', '=', pastId)
          .where('action', '=', 'AUCTION_PENDING_CLAIM_EXPIRED')
          .executeTakeFirst()
        expect(audit).toMatchObject({ actor_id: 'winner' })
      })

      it('no permite expirar un pending-claim ya CLAIMED ni reclamar uno ya EXPIRED', async () => {
        const claimedId = 'claim-expire-already-claimed'
        await persistAuctionForClaim(claimedId)
        const repository = new PostgresAuctionPendingClaimRepository(db)
        const settledAt = new Date('2026-01-03T00:00:00.000Z')
        await repository.createIfAbsent({ ...input(claimedId), settledAt, createdAt: settledAt })
        await repository.markClaimed(claimedId, new Date(settledAt.getTime() + 1000))
        const farFuture = new Date('2026-02-01T00:00:00.000Z')

        await expect(repository.markExpired(claimedId, farFuture)).rejects.toThrow()

        const expiredId = 'claim-expire-then-claim'
        await persistAuctionForClaim(expiredId)
        await repository.createIfAbsent({ ...input(expiredId), settledAt, createdAt: settledAt })
        await repository.markExpired(expiredId, farFuture)

        await expect(repository.markClaimed(expiredId, farFuture)).rejects.toThrow()
        await expect(repository.markExpired(expiredId, farFuture)).rejects.toThrow()
      })

      it('procesa varios vencidos en una misma ejecucion y respeta el limite del batch', async () => {
        const ids = ['claim-batch-a', 'claim-batch-b', 'claim-batch-c']
        for (const id of ids) {
          await persistAuctionForClaim(id)
        }
        const repository = new PostgresAuctionPendingClaimRepository(db)
        // settledAt propio y mas reciente que el resto de fixtures del describe,
        // para poder distinguir "mis" candidatos del limite exacto devuelto.
        const settledAt = new Date('2026-01-05T00:00:00.000Z')
        for (const id of ids) {
          await repository.createIfAbsent({ ...input(id), settledAt, createdAt: settledAt })
        }
        const farFuture = new Date('2026-02-01T00:00:00.000Z')

        const limited = await repository.findExpirablePending(farFuture, 2)
        expect(limited.length).toBeLessThanOrEqual(2)
        const own = limited.filter((c) => ids.includes(c.auctionId))
        for (const candidate of own) {
          await repository.markExpired(candidate.auctionId, farFuture)
        }
        const remainingOwn = (await repository.findExpirablePending(farFuture, 1_000)).filter((c) =>
          ids.includes(c.auctionId),
        )
        expect(remainingOwn).toHaveLength(ids.length - own.length)
      })
    })
  })

  describe('completion atomica HU-65.3', () => {
    const setupWinner = async (auctionId: string) => {
      await db
        .insertInto('auctions')
        .values({
          id: auctionId,
          seller_id: 'seller',
          product_id: `product-${auctionId}`,
          duration_hours: 24,
          publisher_type: 'PLAYER',
          price_kind: 'CREDITS',
          publication_fee_credits: 1,
          minimum_bid_credits: 1,
          buy_now_credits: null,
          status: 'FINISHED',
          published_at: new Date('2026-01-01'),
          closes_at: new Date('2026-01-02'),
          inventory_commitment_id: 'commitment',
          fee_charge_id: 'fee',
          finished_at: new Date('2026-01-02'),
          closing_result_type: 'WITH_WINNER',
          winning_bid_id: `bid-${auctionId}`,
          winner_id: 'winner',
          final_amount_credits: 30,
        })
        .execute()
      const repository = new PostgresAuctionSettlementRepository(db)
      const at = new Date('2026-01-03T00:00:00.000Z')
      await repository.createIfAbsent({
        auctionId,
        resultType: 'WITH_WINNER',
        sellerId: 'seller',
        winningBidId: `bid-${auctionId}`,
        winnerId: 'winner',
        winningHoldId: 'hold',
        finalAmountCredits: 30,
        captureOperationId: `capture-${auctionId}`,
        createdAt: at,
      })
      await repository.markCaptureConfirmed(auctionId, at)
      return {
        repository,
        at,
        input: {
          auctionId,
          resultType: 'WITH_WINNER' as const,
          productId: `product-${auctionId}`,
          winnerId: 'winner',
          winningBidId: `bid-${auctionId}`,
          finalAmountCredits: 30,
          loserBidderIds: [],
          settledAt: at,
          event: createAuctionSettledEventV1({
            auctionId,
            productId: `product-${auctionId}`,
            sellerId: 'seller',
            resultType: 'WITH_WINNER',
            winnerId: 'winner',
            winningBidId: `bid-${auctionId}`,
            finalAmountCredits: 30,
            loserBidderIds: [],
            settledAt: at,
          }),
        },
      }
    }
    it('completa WITH_WINNER con claim, audit, outbox y replay estable', async () => {
      const { repository, input } = await setupWinner('completion-winner')
      const first = await repository.completeSettlement(input)
      const replay = await new PostgresAuctionSettlementRepository(db).completeSettlement(input)
      expect(replay).toEqual(first)
      const claim = await db
        .selectFrom('auction_pending_claims')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .execute()
      const audit = await db
        .selectFrom('auction_audit_log')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .where('action', '=', 'AUCTION_SETTLED')
        .execute()
      const outbox = await db
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', `auction:${input.auctionId}:settled`)
        .execute()
      expect(first).toMatchObject({
        status: AuctionSettlementStatus.Completed,
        settledAt: input.settledAt,
      })
      expect(claim).toHaveLength(1)
      expect(claim[0]).toMatchObject({
        winner_id: 'winner',
        product_id: input.productId,
        winning_bid_id: input.winningBidId,
        claim_status: 'PENDING',
        claimed_at: null,
      })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.details).toMatchObject({
        ...input,
        settledAt: input.settledAt.toISOString(),
      })
      expect(outbox).toHaveLength(1)
      expect(outbox[0]).toMatchObject({ event_type: 'auction.settled.v1' })
      expect(outbox[0]?.payload).toMatchObject({
        eventId: `auction:${input.auctionId}:settled`,
        eventType: 'auction.settled',
        eventVersion: 1,
        aggregateId: input.auctionId,
        occurredAt: input.settledAt.toISOString(),
        producer: 'auction',
        correlationId: `auction:${input.auctionId}:settlement`,
        data: {
          auctionId: input.auctionId,
          productId: input.productId,
          sellerId: 'seller',
          resultType: 'WITH_WINNER',
          winnerId: input.winnerId,
          winningBidId: input.winningBidId,
          finalAmountCredits: input.finalAmountCredits,
          loserBidderIds: input.loserBidderIds,
          settledAt: input.settledAt.toISOString(),
        },
      })
    })
    it('completa concurrentemente una sola vez', async () => {
      const { input } = await setupWinner('completion-concurrent')
      const [a, b] = await Promise.all([
        new PostgresAuctionSettlementRepository(db).completeSettlement(input),
        new PostgresAuctionSettlementRepository(db).completeSettlement(input),
      ])
      expect(a.settledAt).toEqual(b.settledAt)
      const claims = await db
        .selectFrom('auction_pending_claims')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .execute()
      const audits = await db
        .selectFrom('auction_audit_log')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .where('action', '=', 'AUCTION_SETTLED')
        .execute()
      expect(claims).toHaveLength(1)
      expect(audits).toHaveLength(1)
    })
    it('revierte completion al encontrar un claim persistido con intent conflictivo', async () => {
      const { repository, input, at } = await setupWinner('completion-claim-conflict')
      await db
        .insertInto('auction_pending_claims')
        .values({
          auction_id: input.auctionId,
          winner_id: input.winnerId,
          product_id: 'other-product',
          winning_bid_id: input.winningBidId,
          final_amount_credits: input.finalAmountCredits,
          settled_at: at,
          claim_status: 'PENDING',
          claimed_at: null,
          created_at: at,
          updated_at: at,
        })
        .execute()
      await expect(repository.completeSettlement(input)).rejects.toThrow()
      await expect(repository.getByAuctionId(input.auctionId)).resolves.toMatchObject({
        status: AuctionSettlementStatus.Captured,
        settledAt: null,
      })
      await expect(
        db
          .selectFrom('auction_pending_claims')
          .selectAll()
          .where('auction_id', '=', input.auctionId)
          .execute(),
      ).resolves.toMatchObject([{ product_id: 'other-product' }])
      await expect(
        db
          .selectFrom('auction_audit_log')
          .selectAll()
          .where('auction_id', '=', input.auctionId)
          .where('action', '=', 'AUCTION_SETTLED')
          .execute(),
      ).resolves.toHaveLength(0)
      await expect(
        db
          .selectFrom('outbox_events')
          .selectAll()
          .where('id', '=', `auction:${input.auctionId}:settled`)
          .execute(),
      ).resolves.toHaveLength(0)
    })
    it('completa WITHOUT_BIDS sin claim', async () => {
      const auctionId = 'completion-empty'
      const at = new Date('2026-01-03')
      await db
        .insertInto('auctions')
        .values({
          id: auctionId,
          seller_id: 'seller',
          product_id: 'product-empty',
          duration_hours: 24,
          publisher_type: 'PLAYER',
          price_kind: 'CREDITS',
          publication_fee_credits: 1,
          minimum_bid_credits: 1,
          buy_now_credits: null,
          status: 'FINISHED',
          published_at: new Date('2026-01-01'),
          closes_at: new Date('2026-01-02'),
          inventory_commitment_id: 'commitment',
          fee_charge_id: 'fee',
          finished_at: at,
          closing_result_type: 'WITHOUT_BIDS',
          winning_bid_id: null,
          winner_id: null,
          final_amount_credits: null,
        })
        .execute()
      const repo = new PostgresAuctionSettlementRepository(db)
      await repo.createIfAbsent({
        auctionId,
        resultType: 'WITHOUT_BIDS',
        sellerId: 'seller',
        createdAt: at,
      })
      await expect(
        repo.completeSettlement({
          auctionId,
          resultType: 'WITHOUT_BIDS',
          productId: 'product-empty',
          settledAt: at,
          event: createAuctionSettledEventV1({
            auctionId,
            productId: 'product-empty',
            sellerId: 'seller',
            resultType: 'WITHOUT_BIDS',
            settledAt: at,
          }),
        }),
      ).resolves.toMatchObject({ status: AuctionSettlementStatus.Completed, settledAt: at })
      await expect(
        db
          .selectFrom('auction_pending_claims')
          .selectAll()
          .where('auction_id', '=', auctionId)
          .execute(),
      ).resolves.toHaveLength(0)
    })
  })

  describe('outbox settlement HU-65.6', () => {
    beforeEach(async () => {
      await db.deleteFrom('outbox_events').execute()
    })

    it('lee pendientes en orden estable y marca solo el evento settlement sin publicar', async () => {
      const older = createAuctionSettledEventV1({
        auctionId: 'outbox-older',
        productId: 'product',
        sellerId: 'seller',
        resultType: 'WITHOUT_BIDS',
        settledAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      const newer = createAuctionSettledEventV1({
        auctionId: 'outbox-newer',
        productId: 'product',
        sellerId: 'seller',
        resultType: 'WITHOUT_BIDS',
        settledAt: new Date('2026-01-02T00:00:00.000Z'),
      })
      await db
        .insertInto('outbox_events')
        .values([
          {
            id: newer.eventId,
            aggregate_id: newer.aggregateId,
            event_type: 'auction.settled.v1',
            payload: newer,
            occurred_at: new Date(newer.occurredAt),
            published_at: null,
          },
          {
            id: older.eventId,
            aggregate_id: older.aggregateId,
            event_type: 'auction.settled.v1',
            payload: older,
            occurred_at: new Date(older.occurredAt),
            published_at: null,
          },
        ])
        .execute()
      const repository = new PostgresAuctionSettlementOutboxRepository(db)

      await expect(repository.findPending({ limit: 1 })).resolves.toEqual([older])
      await repository.markPublished({
        eventId: older.eventId,
        publishedAt: new Date('2026-01-03'),
      })
      await repository.markPublished({
        eventId: older.eventId,
        publishedAt: new Date('2026-01-04'),
      })

      await expect(repository.findPending({ limit: 10 })).resolves.toEqual([newer])
      await expect(
        db
          .selectFrom('outbox_events')
          .select('published_at')
          .where('id', '=', older.eventId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ published_at: new Date('2026-01-03') })
    })
  })

  describe('repositorio de publicaciones oficiales (HU-66)', () => {
    const officialPublication = (
      id: string,
      options: { readonly productId?: string; readonly mark?: OfficialAuctionMark } = {},
    ) => ({
      operationId: `operation-${id}`,
      auction: OfficialAuction.publish({
        auctionId: id,
        publisherId: 'upb-company-subject',
        publisherType: AuctionPublisherType.GameMaster,
        productId: options.productId ?? `exclusive-${id}`,
        durationHours: 48,
        pricing: {
          kind: AuctionPriceKind.RealMoney,
          minimumBid: { amountMinor: 150_000, currency: 'COP' },
          buyNow: { amountMinor: 300_000, currency: 'COP' },
        },
        mark: options.mark ?? OfficialAuctionMark.Official,
        publishedAt: new Date('2026-09-21T12:00:00.000Z'),
      }),
    })

    beforeEach(async () => {
      await sql`
        truncate auction_publication_operations, auction_audit_log,
        auction_publication_failures, outbox_events, auctions restart identity cascade
      `.execute(db)
    })

    it.each([OfficialAuctionMark.Official, OfficialAuctionMark.Premium])(
      'persiste una subasta %s en dinero real, auditoria y outbox en una unidad atomica',
      async (mark) => {
        const repository = new PostgresAuctionRepository(db)
        const result = await repository.publishOfficial(officialPublication('official-1', { mark }))

        expect(result.replayed).toBe(false)
        expect(result.auction).toMatchObject({
          publisherId: 'upb-company-subject',
          publisherType: AuctionPublisherType.GameMaster,
          publicationFeeCredits: 0,
          currency: 'COP',
          minimumBidAmountMinor: 150_000,
          buyNowAmountMinor: 300_000,
          mark,
        })
        await expect(repository.findOfficialById('official-1')).resolves.toEqual(result.auction)

        const audit = await db
          .selectFrom('auction_audit_log')
          .selectAll()
          .where('auction_id', '=', 'official-1')
          .execute()
        const outbox = await db
          .selectFrom('outbox_events')
          .selectAll()
          .where('aggregate_id', '=', 'official-1')
          .execute()
        expect(audit).toHaveLength(1)
        expect(audit[0]).toMatchObject({
          auction_id: 'official-1',
          operation_id: 'operation-official-1',
          action: 'OFFICIAL_AUCTION_PUBLISHED',
          actor_id: 'upb-company-subject',
        })
        expect(outbox).toHaveLength(1)
        expect(outbox[0]).toMatchObject({
          aggregate_id: 'official-1',
          event_type: 'auction.official-published.v1',
          published_at: null,
        })
      },
    )

    it('un reintento devuelve la publicacion sin duplicar efectos locales', async () => {
      const repository = new PostgresAuctionRepository(db)
      const command = officialPublication('official-idempotent')
      const retry = {
        ...officialPublication('official-generated-again', {
          productId: 'exclusive-official-idempotent',
        }),
        operationId: command.operationId,
      }

      await expect(repository.publishOfficial(command)).resolves.toMatchObject({
        replayed: false,
      })
      await expect(repository.publishOfficial(retry)).resolves.toMatchObject({
        replayed: true,
        auction: { id: 'official-idempotent' },
      })

      const { amount } = await db
        .selectFrom('outbox_events')
        .select(sql<number>`count(*)::integer`.as('amount'))
        .executeTakeFirstOrThrow()
      expect(amount).toBe(1)
    })

    /**
     * HU-66.7: el reintento de arriba prueba la idempotencia en SERIE; esta
     * prueba la prueba bajo la misma carrera real que sufriria un doble clic
     * o un reintento automatico solapado -dos conexiones que llegan a la vez
     * con identica operationId-. El `pg_advisory_xact_lock` de
     * `publishOfficial` (mismo mecanismo que HU-62) debe serializarlas: una
     * sola crea la fila, la otra se reproduce sobre ella, y ninguna deja
     * auditoria ni outbox duplicados.
     */
    it('serializa dos publicaciones oficiales concurrentes con la misma operationId', async () => {
      const repository = new PostgresAuctionRepository(db)
      const command = officialPublication('official-concurrent')
      const sameOperation = {
        ...officialPublication('official-concurrent-generated-again', {
          productId: 'exclusive-official-concurrent',
        }),
        operationId: command.operationId,
      }

      const [first, second] = await Promise.all([
        repository.publishOfficial(command),
        repository.publishOfficial(sameOperation),
      ])

      expect([first.replayed, second.replayed].sort()).toEqual([false, true])
      expect(first.auction.id).toBe('official-concurrent')
      expect(second.auction.id).toBe('official-concurrent')

      const operations = await db
        .selectFrom('auction_publication_operations')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .execute()
      expect(operations).toHaveLength(1)

      const audit = await db
        .selectFrom('auction_audit_log')
        .selectAll()
        .where('auction_id', '=', 'official-concurrent')
        .execute()
      expect(audit).toHaveLength(1)

      const outbox = await db
        .selectFrom('outbox_events')
        .selectAll()
        .where('aggregate_id', '=', 'official-concurrent')
        .execute()
      expect(outbox).toHaveLength(1)

      await expect(repository.findOfficialById('official-concurrent-generated-again')).resolves.toBeNull()
    })

    it('rechaza reutilizar la operacion con otra intencion funcional', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publishOfficial(officialPublication('official-1'))

      await expect(
        repository.publishOfficial({
          ...officialPublication('official-2', { mark: OfficialAuctionMark.Premium }),
          operationId: 'operation-official-1',
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
    })

    it('revierte todos los registros si la publicacion oficial viola una restriccion', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publishOfficial(
        officialPublication('official-first', { productId: 'same-exclusive-product' }),
      )

      await expect(
        repository.publishOfficial(
          officialPublication('official-failed', { productId: 'same-exclusive-product' }),
        ),
      ).rejects.toBeDefined()

      await expect(repository.findOfficialById('official-failed')).resolves.toBeNull()
      const operation = await db
        .selectFrom('auction_publication_operations')
        .selectAll()
        .where('operation_id', '=', 'operation-official-failed')
        .executeTakeFirst()
      expect(operation).toBeUndefined()
      const audit = await db
        .selectFrom('auction_audit_log')
        .selectAll()
        .where('auction_id', '=', 'official-failed')
        .execute()
      expect(audit).toHaveLength(0)
    })

    it('mantiene disponible la lectura de subastas HU-62 junto a publicaciones oficiales', async () => {
      const repository = new PostgresAuctionRepository(db)
      const playerCommand = {
        operationId: 'operation-player-1',
        auction: Auction.publish({
          auctionId: 'player-1',
          sellerId: 'seller-1',
          productId: 'player-product-1',
          durationHours: 24,
          minimumBidCredits: 10,
          buyNowCredits: 20,
          publishedAt: new Date('2026-09-21T12:00:00.000Z'),
          eligibility: {
            productOwnedBySeller: true,
            productInUse: false,
            productTradable: true,
            sellerHasActiveSanctions: false,
            activeAuctionCount: 0,
          },
        }),
        inventoryCommitmentId: 'commitment-1',
        feeChargeId: 'charge-1',
      }

      await repository.publish(playerCommand)
      await repository.publishOfficial(officialPublication('official-1'))

      await expect(repository.findById('player-1')).resolves.toMatchObject({
        id: 'player-1',
        minimumBidCredits: 10,
      })
      await expect(repository.findById('official-1')).resolves.toBeNull()
      await expect(repository.findOfficialById('official-1')).resolves.toMatchObject({
        id: 'official-1',
        publisherType: AuctionPublisherType.GameMaster,
      })
      await expect(repository.findOfficialById('player-1')).resolves.toBeNull()
    })

    it('permanece disponible desde una conexion nueva', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publishOfficial(officialPublication('official-durable'))

      const restarted = createDatabase({ connectionString: container.getConnectionUri() })
      try {
        await expect(
          new PostgresAuctionRepository(restarted).findOfficialById('official-durable'),
        ).resolves.toMatchObject({ id: 'official-durable', status: 'ACTIVE' })
      } finally {
        await restarted.destroy()
      }
    })

    it('la restriccion discriminada rechaza combinaciones invalidas de columnas', async () => {
      const base = {
        id: 'invalid-row',
        seller_id: 'upb-company-subject',
        product_id: 'exclusive-invalid',
        duration_hours: 48,
        publisher_type: 'GAME_MASTER',
        price_kind: 'REAL_MONEY',
        publication_fee_credits: 0,
        currency: 'COP',
        minimum_bid_amount_minor: 150_000,
        buy_now_amount_minor: null,
        official_mark: 'OFFICIAL',
        status: 'ACTIVE',
        published_at: new Date('2026-09-21T12:00:00.000Z'),
        closes_at: new Date('2026-09-23T12:00:00.000Z'),
        inventory_commitment_id: null,
        fee_charge_id: null,
      }

      // Una fila REAL_MONEY con un precio en creditos tambien puesto es la
      // mezcla que la restriccion existe para impedir.
      await expect(
        db
          .insertInto('auctions')
          .values({ ...base, minimum_bid_credits: 10 })
          .execute(),
      ).rejects.toBeDefined()

      // Un GAME_MASTER sin marca oficial tampoco es una fila valida.
      await expect(
        db
          .insertInto('auctions')
          .values({ ...base, minimum_bid_credits: null, official_mark: null })
          .execute(),
      ).rejects.toBeDefined()
    })
  })
})
