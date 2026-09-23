import { InMemoryAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'
import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { InMemoryAuctionSettlementWorkRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementWorkRepository'
import type { AuctionInventorySettlementIntentRepositoryPort } from '../../src/application/ports/AuctionInventorySettlementIntentRepositoryPort'
import {
  AuctionSettlementStatus,
  CaptureStatus,
  type AuctionSettlementSnapshot,
} from '../../src/application/ports/AuctionSettlementRepositoryPort'
import {
  AuctionSettlementWorkStatus,
  type AuctionSettlementCandidateReaderPort,
  type AuctionSettlementWorkRepositoryPort,
  type AuctionSettlementWorkSnapshot,
  type ClaimDueAuctionSettlementsInput,
  type MarkAuctionSettlementRetryableInput,
  type MarkAuctionSettlementTerminalInput,
  type MarkAuctionSettlementWorkInput,
} from '../../src/application/ports/AuctionSettlementWorkRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ProcessExpiredAuctions } from '../../src/application/use-cases/ProcessExpiredAuctions'
import type { ProcessExpiredAuctionsLogger } from '../../src/application/use-cases/ProcessExpiredAuctions'
import { AuctionStatus } from '../../src/domain/entities/Auction'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }

const settlement = (
  auctionId: string,
  status: AuctionSettlementStatus,
  lastError: string | null = null,
): AuctionSettlementSnapshot => ({
  auctionId,
  status,
  resultType: 'WITHOUT_BIDS',
  winningBidId: null,
  winnerId: null,
  winningHoldId: null,
  sellerId: 'seller-1',
  finalAmountCredits: null,
  captureOperationId: null,
  captureStatus: CaptureStatus.NotRequired,
  lastError,
  createdAt: new Date(now),
  updatedAt: new Date(now),
  settledAt: status === AuctionSettlementStatus.Completed ? new Date(now) : null,
})

const workItem = (auctionId: string): AuctionSettlementWorkSnapshot => ({
  auctionId,
  status: AuctionSettlementWorkStatus.Leased,
  availableAt: new Date(now),
  leaseOwner: 'worker-1',
  leaseUntil: new Date(now.getTime() + 300_000),
  attempts: 1,
  lastError: null,
  createdAt: new Date(now),
  updatedAt: new Date(now),
  completedAt: null,
  terminalAt: null,
})

class FakeWorkRepository implements AuctionSettlementWorkRepositoryPort {
  readonly completed: string[] = []
  readonly retryable: MarkAuctionSettlementRetryableInput[] = []
  readonly terminal: MarkAuctionSettlementTerminalInput[] = []

  constructor(private readonly claimed: readonly AuctionSettlementWorkSnapshot[]) {}

  claimDue(
    input: ClaimDueAuctionSettlementsInput,
  ): Promise<readonly AuctionSettlementWorkSnapshot[]> {
    return Promise.resolve(this.claimed.slice(0, input.limit))
  }

  markCompleted(input: MarkAuctionSettlementWorkInput): Promise<AuctionSettlementWorkSnapshot> {
    this.completed.push(input.auctionId)
    return Promise.resolve({
      ...workItem(input.auctionId),
      status: AuctionSettlementWorkStatus.Completed,
    })
  }

  markRetryable(
    input: MarkAuctionSettlementRetryableInput,
  ): Promise<AuctionSettlementWorkSnapshot> {
    this.retryable.push(input)
    return Promise.resolve({
      ...workItem(input.auctionId),
      status: AuctionSettlementWorkStatus.Retryable,
    })
  }

  markTerminal(input: MarkAuctionSettlementTerminalInput): Promise<AuctionSettlementWorkSnapshot> {
    this.terminal.push(input)
    return Promise.resolve({
      ...workItem(input.auctionId),
      status: AuctionSettlementWorkStatus.Terminal,
    })
  }

  getByAuctionId(): Promise<AuctionSettlementWorkSnapshot | null> {
    return Promise.resolve(null)
  }
}

const logger = (): jest.Mocked<ProcessExpiredAuctionsLogger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
})

const createProcessor = (
  work: AuctionSettlementWorkRepositoryPort,
  execute: (input: { readonly auctionId: string }) => Promise<AuctionSettlementSnapshot>,
  log = logger(),
  concurrency = 4,
  inventoryIntents: AuctionInventorySettlementIntentRepositoryPort = new InMemoryAuctionInventorySettlementIntentRepository(),
) =>
  new ProcessExpiredAuctions(work, { execute }, inventoryIntents, clock, log, {
    batchSize: 25,
    concurrency,
    leaseMs: 300_000,
    retryDelayMs: 30_000,
    workerId: 'worker-1',
  })

describe('ProcessExpiredAuctions', () => {
  it('marca COMPLETED cuando SettleAuction completa el settlement', async () => {
    const work = new FakeWorkRepository([workItem('auction-1')])
    const result = await createProcessor(work, ({ auctionId }) =>
      Promise.resolve(settlement(auctionId, AuctionSettlementStatus.Completed)),
    ).runBatch()

    expect(result).toMatchObject({ claimed: 1, completed: 1, retryable: 0, terminal: 0 })
    expect(work.completed).toEqual(['auction-1'])
  })

  it('programa retry con delay para un resultado reintentable', async () => {
    const work = new FakeWorkRepository([workItem('auction-1')])
    await createProcessor(work, ({ auctionId }) =>
      Promise.resolve(
        settlement(auctionId, AuctionSettlementStatus.FailedRetryable, 'wallet down'),
      ),
    ).runBatch()

    expect(work.retryable[0]).toMatchObject({
      auctionId: 'auction-1',
      error: 'wallet down',
      availableAt: new Date('2026-09-23T12:00:30.000Z'),
    })
  })

  it('marca terminal un settlement con fallo terminal', async () => {
    const work = new FakeWorkRepository([workItem('auction-1')])
    await createProcessor(work, ({ auctionId }) =>
      Promise.resolve(settlement(auctionId, AuctionSettlementStatus.FailedTerminal, 'conflict')),
    ).runBatch()

    expect(work.terminal).toHaveLength(1)
    expect(work.terminal[0]?.error).toBe('conflict')
  })

  it('marca terminal cuando el intent de Inventory es terminal', async () => {
    const work = new FakeWorkRepository([workItem('auction-1')])
    const intents = new InMemoryAuctionInventorySettlementIntentRepository()
    await intents.getOrCreate({
      auctionId: 'auction-1',
      operationId: 'inventory-operation-1',
      action: 'RELEASE',
      commitmentId: 'commitment-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      createdAt: now,
    })
    await intents.markTerminalError('auction-1', 'inventory conflict', now)

    await createProcessor(
      work,
      ({ auctionId }) =>
        Promise.resolve(settlement(auctionId, AuctionSettlementStatus.FailedRetryable)),
      logger(),
      4,
      intents,
    ).runBatch()

    expect(work.terminal[0]?.error).toBe('inventory conflict')
  })

  it('mantiene retryable mientras el intent de Inventory este pendiente', async () => {
    const work = new FakeWorkRepository([workItem('auction-1')])
    const intents = new InMemoryAuctionInventorySettlementIntentRepository()
    await intents.getOrCreate({
      auctionId: 'auction-1',
      operationId: 'inventory-operation-1',
      action: 'RELEASE',
      commitmentId: 'commitment-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      createdAt: now,
    })

    await createProcessor(
      work,
      ({ auctionId }) => Promise.resolve(settlement(auctionId, AuctionSettlementStatus.Completed)),
      logger(),
      4,
      intents,
    ).runBatch()

    expect(work.completed).toEqual([])
    expect(work.retryable).toHaveLength(1)
  })

  it('convierte una excepcion inesperada en retry y continua el batch', async () => {
    const work = new FakeWorkRepository([workItem('auction-1'), workItem('auction-2')])
    const log = logger()
    const result = await createProcessor(
      work,
      ({ auctionId }) => {
        if (auctionId === 'auction-1') return Promise.reject(new Error('boom'))
        return Promise.resolve(settlement(auctionId, AuctionSettlementStatus.Completed))
      },
      log,
    ).runBatch()

    expect(result).toMatchObject({ completed: 1, retryable: 1, unexpectedErrors: 1 })
    expect(work.retryable[0]?.error).toBe('Error: boom')
    expect(log.error).toHaveBeenCalledWith(
      'auction_settlement_unexpected_error',
      expect.objectContaining({ auctionId: 'auction-1' }),
    )
  })

  it('no supera la concurrencia configurada', async () => {
    const work = new FakeWorkRepository(
      Array.from({ length: 7 }, (_, index) => workItem(`auction-${String(index)}`)),
    )
    let active = 0
    let maximum = 0
    const processor = createProcessor(
      work,
      async ({ auctionId }) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise<void>((resolve) => setImmediate(resolve))
        active -= 1
        return settlement(auctionId, AuctionSettlementStatus.Completed)
      },
      logger(),
      2,
    )

    await processor.runBatch()
    expect(maximum).toBe(2)
  })

  it('registra inicio y fin aunque el batch este vacio', async () => {
    const work = new FakeWorkRepository([])
    const log = logger()
    await createProcessor(work, () => Promise.reject(new Error('no esperado')), log).runBatch()

    expect(log.info).toHaveBeenCalledWith(
      'auction_settlement_batch_started',
      expect.objectContaining({ claimed: 0 }),
    )
    expect(log.info).toHaveBeenCalledWith(
      'auction_settlement_batch_completed',
      expect.objectContaining({ claimed: 0 }),
    )
  })

  it('procesa closesAt anterior o igual a now y deja fuera now + 1 ms', async () => {
    const candidates: AuctionSettlementCandidateReaderPort = {
      findSettlementCandidates: (at) =>
        Promise.resolve(
          [
            { auctionId: 'before', closesAt: new Date(now.getTime() - 1) },
            { auctionId: 'exact', closesAt: new Date(now) },
            { auctionId: 'after', closesAt: new Date(now.getTime() + 1) },
          ]
            .filter((candidate) => candidate.closesAt.getTime() <= at.getTime())
            .map((candidate) => ({ ...candidate, status: AuctionStatus.Active })),
        ),
    }
    const work = new InMemoryAuctionSettlementWorkRepository(
      candidates,
      new InMemoryAuctionSettlementRepository(),
    )
    const processed: string[] = []
    const result = await createProcessor(work, ({ auctionId }) => {
      processed.push(auctionId)
      return Promise.resolve(settlement(auctionId, AuctionSettlementStatus.Completed))
    }).runBatch()

    expect(result.claimed).toBe(2)
    expect(processed).toEqual(['before', 'exact'])
  })

  it('reclama un retry exactamente al alcanzar availableAt, sin sleeps', async () => {
    let currentTime = new Date(now)
    const mutableClock: ClockPort = { now: () => new Date(currentTime) }
    const candidates: AuctionSettlementCandidateReaderPort = {
      findSettlementCandidates: () =>
        Promise.resolve([
          {
            auctionId: 'auction-retry',
            status: AuctionStatus.Active,
            closesAt: new Date(now),
          },
        ]),
    }
    const work = new InMemoryAuctionSettlementWorkRepository(
      candidates,
      new InMemoryAuctionSettlementRepository(),
    )
    let invocation = 0
    const processor = new ProcessExpiredAuctions(
      work,
      {
        execute: ({ auctionId }) => {
          invocation += 1
          return Promise.resolve(
            settlement(
              auctionId,
              invocation === 1
                ? AuctionSettlementStatus.FailedRetryable
                : AuctionSettlementStatus.Completed,
            ),
          )
        },
      },
      new InMemoryAuctionInventorySettlementIntentRepository(),
      mutableClock,
      logger(),
      {
        batchSize: 25,
        concurrency: 4,
        leaseMs: 300_000,
        retryDelayMs: 30_000,
        workerId: 'worker-1',
      },
    )

    await expect(processor.runBatch()).resolves.toMatchObject({ retryable: 1 })
    currentTime = new Date(now.getTime() + 29_999)
    await expect(processor.runBatch()).resolves.toMatchObject({ claimed: 0 })
    currentTime = new Date(now.getTime() + 30_000)
    await expect(processor.runBatch()).resolves.toMatchObject({ claimed: 1, completed: 1 })
    expect(invocation).toBe(2)
  })
})
