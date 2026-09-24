import type { AuctionInventorySettlementIntentRepositoryPort } from '../../src/application/ports/AuctionInventorySettlementIntentRepositoryPort'
import type {
  AuctionRepositoryPort,
  BuyNowOperationRecord,
} from '../../src/application/ports/AuctionRepositoryPort'
import { BuyNowPendingClaimRegistrationService } from '../../src/application/services/BuyNowPendingClaimRegistrationService'
import { InMemoryAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { RetryBuyNowPendingClaims } from '../../src/application/use-cases/RetryBuyNowPendingClaims'

const intent = (status: 'RETRYABLE' | 'CONFIRMED' | 'TERMINAL_ERROR' = 'RETRYABLE') => ({
  auctionId: 'auction-1',
  operationId: 'auction:auction-1:inventory:pending-claim',
  action: 'PENDING_CLAIM' as const,
  commitmentId: 'commitment-1',
  sellerId: 'seller-1',
  productId: 'product-1',
  winnerId: 'buyer-1',
  status,
  lastError: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  confirmedAt: null,
})
const operation: BuyNowOperationRecord = {
  auction: {} as BuyNowOperationRecord['auction'],
  transactionId: 'tx',
  buyerId: 'buyer-1',
  transferId: 'transfer',
  priceCredits: 50,
  remainingCredits: 0,
  completedAt: new Date('2026-01-02'),
}

const fixture = () => {
  const intents = {
    findRetryablePendingClaims: jest.fn().mockResolvedValue([intent()]),
  } as unknown as jest.Mocked<AuctionInventorySettlementIntentRepositoryPort>
  const auctions = {
    findBuyNowOperationByAuctionId: jest.fn().mockResolvedValue(operation),
  } as unknown as jest.Mocked<AuctionRepositoryPort>
  const registration = {
    retryClaim: jest.fn().mockResolvedValue({ ...intent(), status: 'CONFIRMED' as const }),
  } as unknown as jest.Mocked<BuyNowPendingClaimRegistrationService>
  return {
    worker: new RetryBuyNowPendingClaims(intents, auctions, registration, { batchSize: 10 }),
    intents,
    auctions,
    registration,
  }
}

describe('RetryBuyNowPendingClaims', () => {
  it('confirma un retry HU-64 usando la operacion durable', async () => {
    const { worker, registration } = fixture()
    await expect(worker.runBatch()).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      unexpectedErrors: 0,
    })
    expect(registration.retryClaim).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: intent().operationId }),
      operation,
    )
  })
  it('excluye HU-65 si no existe operacion buy-now durable', async () => {
    const { worker, auctions, registration } = fixture()
    auctions.findBuyNowOperationByAuctionId.mockResolvedValue(null)
    await expect(worker.runBatch()).resolves.toMatchObject({ claimed: 0, confirmed: 0 })
    expect(registration.retryClaim).not.toHaveBeenCalled()
  })
  it.each([
    ['retryable', 'RETRYABLE'],
    ['terminal', 'TERMINAL_ERROR'],
  ] as const)('cuenta %s sin error inesperado', async (_name, status) => {
    const { worker, registration } = fixture()
    registration.retryClaim.mockResolvedValue({ ...intent(), status })
    await expect(worker.runBatch()).resolves.toMatchObject({
      [status === 'RETRYABLE' ? 'retryable' : 'terminal']: 1,
      unexpectedErrors: 0,
    })
  })

  it('terminaliza buyer/winner inconsistente sin llamar Inventory', async () => {
    const intents = new InMemoryAuctionInventorySettlementIntentRepository()
    await intents.getOrCreate({
      ...intent(),
      winnerId: 'player-winner',
      createdAt: new Date('2026-01-01'),
    })
    await intents.markRetryable('auction-1', 'timeout', new Date())
    const inventory = { markPendingClaim: jest.fn() }
    const pendingClaims = { createIfAbsent: jest.fn() }
    const service = new BuyNowPendingClaimRegistrationService(
      {} as AuctionRepositoryPort,
      inventory as never,
      intents,
      pendingClaims as never,
      { now: () => new Date() },
    )
    const worker = new RetryBuyNowPendingClaims(
      intents,
      {
        findBuyNowOperationByAuctionId: jest
          .fn()
          .mockResolvedValue({ ...operation, buyerId: 'player-buyer' }),
      } as never,
      service,
      { batchSize: 10 },
    )
    await expect(worker.runBatch()).resolves.toMatchObject({ terminal: 1, unexpectedErrors: 0 })
    expect(inventory.markPendingClaim).not.toHaveBeenCalled()
    expect(pendingClaims.createIfAbsent).not.toHaveBeenCalled()
    await expect(intents.getByAuctionId('auction-1')).resolves.toMatchObject({
      status: 'TERMINAL_ERROR',
    })
  })

  it('usa datos buy-now durables y no duplica el pending claim', async () => {
    const intents = new InMemoryAuctionInventorySettlementIntentRepository()
    await intents.getOrCreate({ ...intent(), createdAt: new Date('2026-01-01') })
    await intents.markRetryable('auction-1', 'timeout', new Date())
    const inventory = { markPendingClaim: jest.fn().mockResolvedValue({}) }
    const pendingClaims = { createIfAbsent: jest.fn().mockResolvedValue({}) }
    const service = new BuyNowPendingClaimRegistrationService(
      {} as AuctionRepositoryPort,
      inventory as never,
      intents,
      pendingClaims as never,
      { now: () => new Date('2099-01-01') },
    )
    const auctions = {
      findBuyNowOperationByAuctionId: jest.fn().mockResolvedValue(operation),
    } as never
    const worker = new RetryBuyNowPendingClaims(intents, auctions, service, { batchSize: 10 })
    await worker.runBatch()
    await worker.runBatch()
    expect(pendingClaims.createIfAbsent).toHaveBeenCalledTimes(1)
    expect(pendingClaims.createIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        winnerId: 'buyer-1',
        finalAmountCredits: 50,
        settledAt: operation.completedAt,
        createdAt: operation.completedAt,
        winningBidId: 'buy-now:auction-1',
      }),
    )
    expect(inventory.markPendingClaim).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: intent().operationId }),
    )
  })

  it('dos workers concurrentes confirman idempotentemente el mismo intent', async () => {
    const intents = new InMemoryAuctionInventorySettlementIntentRepository()
    await intents.getOrCreate({ ...intent(), createdAt: new Date('2026-01-01') })
    await intents.markRetryable('auction-1', 'timeout', new Date())
    let arrivals = 0
    let release!: () => void
    const operationIds: string[] = []
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const inventory = {
      markPendingClaim: jest.fn(async (command: { operationId: string }) => {
        operationIds.push(command.operationId)
        arrivals += 1
        if (arrivals === 2) release()
        await barrier
        return {}
      }),
    }
    const claims = new InMemoryAuctionPendingClaimRepository()
    const service = new BuyNowPendingClaimRegistrationService(
      {} as AuctionRepositoryPort,
      inventory as never,
      intents,
      claims,
      { now: () => new Date() },
    )
    const auctions = {
      findBuyNowOperationByAuctionId: jest.fn().mockResolvedValue(operation),
    } as never
    const workerA = new RetryBuyNowPendingClaims(intents, auctions, service, { batchSize: 10 })
    const workerB = new RetryBuyNowPendingClaims(intents, auctions, service, { batchSize: 10 })
    const [left, right] = await Promise.all([workerA.runBatch(), workerB.runBatch()])
    expect(inventory.markPendingClaim).toHaveBeenCalledTimes(2)
    expect(operationIds).toEqual([intent().operationId, intent().operationId])
    await expect(claims.findByAuctionId('auction-1')).resolves.toMatchObject({
      winnerId: 'buyer-1',
    })
    await expect(claims.findPendingByWinnerId('buyer-1')).resolves.toHaveLength(1)
    await expect(intents.getByAuctionId('auction-1')).resolves.toMatchObject({
      status: 'CONFIRMED',
    })
    expect(left.unexpectedErrors).toBe(0)
    expect(right.unexpectedErrors).toBe(0)
  })
})
