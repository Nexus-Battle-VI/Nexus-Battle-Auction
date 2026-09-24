import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionInventorySettlementIntentRepository'
import { PostgresAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionPendingClaimRepository'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import { PostgresAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionSettlementRepository'
import { PostgresAuctionSettlementWorkRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionSettlementWorkRepository'
import { PostgresBidCreditOperationReader } from '../../src/adapters/outbound/persistence/PostgresBidCreditOperationReader'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
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
import { ClassifyAuctionLoserCredits } from '../../src/application/use-cases/ClassifyAuctionLoserCredits'
import { PrepareAuctionLoserReleaseTasks } from '../../src/application/use-cases/PrepareAuctionLoserReleaseTasks'
import { ProcessExpiredAuctions } from '../../src/application/use-cases/ProcessExpiredAuctions'
import type { ProcessExpiredAuctionsLogger } from '../../src/application/use-cases/ProcessExpiredAuctions'
import { SettleAuction } from '../../src/application/use-cases/SettleAuction'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }

class ContractWallet implements AuctionWalletPort {
  readonly captureCalls: CaptureAuctionHoldCommand[] = []
  readonly releaseCalls: ReleaseAuctionHoldCommand[] = []

  constructor(
    private readonly trace: string[],
    private readonly captureOutcome: WalletHoldOutcome = 'SUCCESS',
  ) {}

  captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> {
    this.trace.push('wallet:capture')
    this.captureCalls.push(command)
    return Promise.resolve({
      outcome: this.captureOutcome,
      operationId: command.operationId,
      holdId: command.holdId,
      applied: true,
    })
  }

  releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> {
    this.trace.push('wallet:release')
    this.releaseCalls.push(command)
    return Promise.resolve({
      outcome: 'SUCCESS',
      operationId: command.operationId,
      holdId: command.holdId,
      applied: true,
    })
  }
}

class ContractInventory implements ProductInventoryPort {
  readonly releaseCalls: ReleaseInventoryProductCommand[] = []
  readonly pendingClaimCalls: MarkInventoryProductPendingClaimCommand[] = []
  readonly confirmClaim = jest.fn(() =>
    Promise.reject(new Error('No debe reclamar durante settlement.')),
  )
  private pendingClaimAttempt = 0

  constructor(
    private readonly trace: string[],
    private readonly pendingClaimOutcomes: readonly ('SUCCESS' | 'RETRYABLE')[] = ['SUCCESS'],
  ) {}

  inspect(): Promise<{ readonly ownedByPlayer: boolean; readonly inUse: boolean }> {
    return Promise.resolve({ ownedByPlayer: true, inUse: false })
  }

  commit(): Promise<never> {
    return Promise.reject(new Error('No debe invocarse commit durante settlement.'))
  }

  release(command: ReleaseInventoryProductCommand) {
    this.trace.push('inventory:release')
    this.releaseCalls.push(command)
    return Promise.resolve({
      operationId: command.operationId,
      commitmentId: command.commitmentId,
      status: 'RELEASED' as const,
      applied: true,
    })
  }

  markPendingClaim(command: MarkInventoryProductPendingClaimCommand) {
    this.trace.push('inventory:pending-claim')
    this.pendingClaimCalls.push(command)
    const outcome =
      this.pendingClaimOutcomes[
        Math.min(this.pendingClaimAttempt, this.pendingClaimOutcomes.length - 1)
      ]
    this.pendingClaimAttempt += 1
    if (outcome === 'RETRYABLE')
      return Promise.reject(new ExternalDependencyUnavailableError('Inventory no disponible.'))
    return Promise.resolve({
      operationId: command.operationId,
      commitmentId: command.commitmentId,
      status: 'PENDING_CLAIM' as const,
      winnerId: command.winnerId,
      applied: true,
    })
  }
}

describe('HU-65.7 - acceptance of auction settlement', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error !== undefined) throw new Error('No se pudieron aplicar las migraciones.')
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  beforeEach(async () => {
    await sql`
      truncate
        auction_settlement_work,
        auction_inventory_settlement_intents,
        auction_pending_claims,
        auction_settlement_releases,
        auction_settlements,
        auction_bids,
        auction_publication_operations,
        auction_audit_log,
        auction_publication_failures,
        outbox_events,
        auctions
      restart identity cascade
    `.execute(db)
  })

  const publish = async (auctionId: string, publishedAt = new Date('2026-09-21T12:00:00.000Z')) => {
    const repository = new PostgresAuctionRepository(db)
    await repository.publish({
      operationId: `publish:${auctionId}`,
      auction: Auction.publish({
        auctionId,
        sellerId: 'seller-1',
        productId: `product-${auctionId}`,
        durationHours: 24,
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
      inventoryCommitmentId: `commitment-${auctionId}`,
      feeChargeId: `fee-${auctionId}`,
    })
    return repository
  }

  const persistBid = async (
    auctionId: string,
    bidId: string,
    bidderId: string,
    amountCredits: number,
    creditReservationId: string,
    currentBidCredits: number | null,
  ): Promise<void> => {
    const repository = new PostgresAuctionRepository(db)
    await repository.persistBid(
      Bid.register({
        bidId,
        auctionId,
        bidderId,
        amountCredits,
        placedAt: new Date('2026-09-22T12:00:00.000Z'),
        eligibility: {
          auctionStatus: 'ACTIVE',
          sellerId: 'seller-1',
          currentBidCredits,
          minimumIncrementCredits: 1,
          lastBidAtByBidder: null,
          activeBidCount: 0,
        },
      }),
      creditReservationId,
    )
  }

  const createApplication = (wallet: ContractWallet, inventory: ContractInventory) => {
    const auctions = new PostgresAuctionRepository(db)
    const settlements = new PostgresAuctionSettlementRepository(db)
    const inventoryIntents = new PostgresAuctionInventorySettlementIntentRepository(db)
    const pendingClaims = new PostgresAuctionPendingClaimRepository(db)
    return {
      auctions,
      settlements,
      inventoryIntents,
      pendingClaims,
      useCase: new SettleAuction(
        auctions,
        settlements,
        clock,
        wallet,
        new ClassifyAuctionLoserCredits(new PostgresBidCreditOperationReader(db)),
        new PrepareAuctionLoserReleaseTasks(settlements),
        inventory,
        inventoryIntents,
        pendingClaims,
      ),
    }
  }

  const rowsFor = async (auctionId: string) => {
    const [claims, audit, outbox] = await Promise.all([
      db
        .selectFrom('auction_pending_claims')
        .selectAll()
        .where('auction_id', '=', auctionId)
        .execute(),
      db
        .selectFrom('auction_audit_log')
        .selectAll()
        .where('auction_id', '=', auctionId)
        .where('action', '=', 'AUCTION_SETTLED')
        .execute(),
      db
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', `auction:${auctionId}:settled`)
        .execute(),
    ])
    return { claims, audit, outbox }
  }

  it('CP-01 / CA-05: settles winner, releases losers and publishes one event after PENDING_CLAIM', async () => {
    const auctionId = 'acceptance-winner'
    await publish(auctionId)
    await persistBid(auctionId, 'bid-a', 'bidder-a', 20, 'hold-a', null)
    await persistBid(auctionId, 'bid-b', 'bidder-b', 30, 'hold-b', 20)
    await persistBid(auctionId, 'bid-c', 'bidder-c', 40, 'hold-c', 30)
    const trace: string[] = []
    const wallet = new ContractWallet(trace)
    const inventory = new ContractInventory(trace)
    const app = createApplication(wallet, inventory)

    await expect(app.useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'LOSER_RELEASES_PENDING',
    })
    await expect(app.useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      resultType: 'WITH_WINNER',
      winnerId: 'bidder-c',
      winningBidId: 'bid-c',
      finalAmountCredits: 40,
    })

    expect(wallet.captureCalls).toEqual([
      expect.objectContaining({
        holdId: 'hold-c',
        operationId: `auction:${auctionId}:settlement:capture`,
        beneficiaryPlayerId: 'seller-1',
        auctionId,
        winningBidId: 'bid-c',
      }),
    ])
    expect(wallet.releaseCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          holdId: 'hold-a',
          operationId: `auction:${auctionId}:bid:bid-a:release`,
        }),
        expect.objectContaining({
          holdId: 'hold-b',
          operationId: `auction:${auctionId}:bid:bid-b:release`,
        }),
      ]),
    )
    expect(wallet.releaseCalls).toHaveLength(2)
    expect(wallet.releaseCalls.map((call) => call.holdId)).not.toContain('hold-c')
    expect(inventory.pendingClaimCalls).toEqual([
      expect.objectContaining({
        operationId: `auction:${auctionId}:inventory:pending-claim`,
        commitmentId: `commitment-${auctionId}`,
        winnerId: 'bidder-c',
      }),
    ])
    expect(inventory.confirmClaim).not.toHaveBeenCalled()
    expect(trace.indexOf('wallet:capture')).toBeLessThan(trace.indexOf('inventory:pending-claim'))

    await expect(app.auctions.findBidHistory(auctionId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'bid-a',
          bidderId: 'bidder-a',
          creditReservationId: 'hold-a',
        }),
        expect.objectContaining({
          id: 'bid-b',
          bidderId: 'bidder-b',
          creditReservationId: 'hold-b',
        }),
        expect.objectContaining({
          id: 'bid-c',
          bidderId: 'bidder-c',
          creditReservationId: 'hold-c',
        }),
      ]),
    )
    const { claims, audit, outbox } = await rowsFor(auctionId)
    expect(claims).toEqual([
      expect.objectContaining({ winner_id: 'bidder-c', claim_status: 'PENDING', claimed_at: null }),
    ])
    expect(audit).toHaveLength(1)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ event_type: 'auction.settled.v1' })
    expect(outbox[0]?.payload).toMatchObject({
      eventId: `auction:${auctionId}:settled`,
      eventType: 'auction.settled',
      eventVersion: 1,
      aggregateId: auctionId,
      producer: 'auction',
      data: {
        auctionId,
        sellerId: 'seller-1',
        winnerId: 'bidder-c',
        winningBidId: 'bid-c',
        finalAmountCredits: 40,
        loserBidderIds: ['bidder-a', 'bidder-b'],
        resultType: 'WITH_WINNER',
      },
    })
  })

  it('CP-02: termina WITHOUT_BIDS, libera Inventory y no produce movimientos Wallet ni refund de fee', async () => {
    const auctionId = 'acceptance-without-bids'
    await publish(auctionId)
    const trace: string[] = []
    const wallet = new ContractWallet(trace)
    const inventory = new ContractInventory(trace)
    const app = createApplication(wallet, inventory)

    await expect(app.useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      resultType: 'WITHOUT_BIDS',
      captureStatus: 'NOT_REQUIRED',
    })

    // El contrato Wallet de Auction solo expone capture/release de holds de puja;
    // la evidencia verificable de no reembolso de fee es ausencia total de esas llamadas.
    expect(wallet.captureCalls).toHaveLength(0)
    expect(wallet.releaseCalls).toHaveLength(0)
    expect(inventory.releaseCalls).toEqual([
      expect.objectContaining({
        operationId: `auction:${auctionId}:inventory:release`,
        commitmentId: `commitment-${auctionId}`,
        reason: 'AUCTION_WITHOUT_BIDS',
      }),
    ])
    expect(inventory.pendingClaimCalls).toHaveLength(0)
    expect(inventory.confirmClaim).not.toHaveBeenCalled()

    const { claims, audit, outbox } = await rowsFor(auctionId)
    expect(claims).toHaveLength(0)
    expect(audit).toHaveLength(1)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.payload).toMatchObject({
      data: { auctionId, sellerId: 'seller-1', resultType: 'WITHOUT_BIDS' },
    })
    const eventData = (outbox[0]?.payload as { readonly data?: object }).data
    expect(eventData).not.toHaveProperty('winnerId')
    expect(eventData).not.toHaveProperty('winningBidId')
    expect(eventData).not.toHaveProperty('finalAmountCredits')
    expect(eventData).not.toHaveProperty('loserBidderIds')
  })

  it('recovers the Inventory intent after an application restart without a second capture', async () => {
    const auctionId = 'acceptance-inventory-recovery'
    await publish(auctionId)
    await persistBid(auctionId, 'bid-winner', 'winner', 30, 'hold-winner', null)
    const firstTrace: string[] = []
    const walletA = new ContractWallet(firstTrace)
    const inventoryA = new ContractInventory(firstTrace, ['RETRYABLE'])
    const first = createApplication(walletA, inventoryA)

    await expect(first.useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'CAPTURED',
    })
    await expect(first.inventoryIntents.getByAuctionId(auctionId)).resolves.toMatchObject({
      action: 'PENDING_CLAIM',
      status: 'RETRYABLE',
      operationId: `auction:${auctionId}:inventory:pending-claim`,
    })
    expect(walletA.captureCalls).toHaveLength(1)

    const secondTrace: string[] = []
    const walletB = new ContractWallet(secondTrace)
    const inventoryB = new ContractInventory(secondTrace)
    const restarted = createApplication(walletB, inventoryB)
    await expect(restarted.useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
    })

    expect(walletB.captureCalls).toHaveLength(0)
    expect(inventoryA.pendingClaimCalls[0]).toMatchObject({
      operationId: `auction:${auctionId}:inventory:pending-claim`,
    })
    expect(inventoryB.pendingClaimCalls[0]).toMatchObject({
      operationId: `auction:${auctionId}:inventory:pending-claim`,
    })
    const { claims, audit, outbox } = await rowsFor(auctionId)
    expect(claims).toHaveLength(1)
    expect(audit).toHaveLength(1)
    expect(outbox).toHaveLength(1)
  })

  it('CA-04: el procesador real toma closesAt exacto y excluye now + 1 ms', async () => {
    const exactAuctionId = 'acceptance-scheduler-exact'
    const futureAuctionId = 'acceptance-scheduler-future'
    await publish(exactAuctionId, new Date(now.getTime() - 24 * 60 * 60 * 1000))
    await publish(futureAuctionId, new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1))
    const trace: string[] = []
    const wallet = new ContractWallet(trace)
    const inventory = new ContractInventory(trace)
    const app = createApplication(wallet, inventory)
    const logger: jest.Mocked<ProcessExpiredAuctionsLogger> = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const processor = new ProcessExpiredAuctions(
      new PostgresAuctionSettlementWorkRepository(db),
      app.useCase,
      app.inventoryIntents,
      clock,
      logger,
      {
        batchSize: 10,
        concurrency: 1,
        leaseMs: 60_000,
        retryDelayMs: 1_000,
        workerId: 'acceptance-worker',
      },
    )

    await expect(processor.runBatch()).resolves.toMatchObject({ claimed: 1, completed: 1 })
    await expect(app.settlements.getByAuctionId(exactAuctionId)).resolves.toMatchObject({
      status: 'COMPLETED',
      resultType: 'WITHOUT_BIDS',
    })
    await expect(app.settlements.getByAuctionId(futureAuctionId)).resolves.toBeNull()
    expect(wallet.captureCalls).toHaveLength(0)
    expect(wallet.releaseCalls).toHaveLength(0)
    expect(inventory.releaseCalls).toHaveLength(1)
    expect((await rowsFor(exactAuctionId)).outbox).toHaveLength(1)
    expect((await rowsFor(futureAuctionId)).outbox).toHaveLength(0)
  })
})
