import { Auction } from '../../src/domain/entities/Auction'
import { AuctionCancellationEffectStatus } from '../../src/application/ports/AuctionCancellationRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import type {
  ChargePublicationFeeCommand,
  PublicationFeeCharge,
  PublicationFeePort,
} from '../../src/application/ports/PublicationFeePort'
import type {
  ClaimedInventoryProductCommitment,
  InventoryProductCommitment,
  InventoryProductEligibility,
  PendingClaimInventoryProductCommitment,
  ProductInventoryPort,
  ReleasedInventoryProductCommitment,
  ReleaseInventoryProductCommand,
} from '../../src/application/ports/ProductInventoryPort'
import { InMemoryAuctionCancellationRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionCancellationRepository'
import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { CancelAuction } from '../../src/application/use-cases/CancelAuction'
import {
  AuctionCancellationReconciler,
  type AuctionCancellationReconcilerLogger,
} from '../../src/application/use-cases/AuctionCancellationReconciler'

const publishedAt = new Date('2026-09-21T12:00:00.000Z')
const closesAt = new Date('2026-09-23T12:00:00.000Z')
const CANCELLATION_WINDOW_MS = 6 * 60 * 60 * 1000
const safeNow = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS - 1)

class StubClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

type RefundBehavior = 'success' | 'unavailable'

class StubPublicationFeePort implements PublicationFeePort {
  readonly refundCalls: { operationId: string; chargeId: string; amount: number }[] = []
  behavior: RefundBehavior = 'success'

  charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge> {
    void command
    throw new Error('No usado en estos tests.')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(operationId: string, chargeId: string, amount: number): Promise<void> {
    this.refundCalls.push({ operationId, chargeId, amount })
    if (this.behavior === 'unavailable') throw new ExternalDependencyUnavailableError('wallet')
  }
}

type ReleaseBehavior = 'success' | 'unavailable' | 'not-found'

class StubProductInventoryPort implements ProductInventoryPort {
  readonly releaseCalls: ReleaseInventoryProductCommand[] = []
  behavior: ReleaseBehavior = 'success'

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
    if (this.behavior === 'unavailable')
      throw new ExternalDependencyUnavailableError('player-inventory')
    if (this.behavior === 'not-found')
      throw new ExternalResourceNotFoundError('player-inventory', command.commitmentId)
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

const silentLogger = (): jest.Mocked<AuctionCancellationReconcilerLogger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
})

const auctionId = 'auction-90-reconciler-1'
const sellerId = 'seller-1'
const productId = 'product-1'

const publish = (auctions: InMemoryAuctionRepository): void => {
  const auction = Auction.publish({
    auctionId,
    sellerId,
    productId,
    durationHours: 48,
    minimumBidCredits: 10,
    buyNowCredits: null,
    publishedAt,
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  })
  void auctions.publish({
    operationId: 'publish-op',
    auction,
    inventoryCommitmentId: 'commitment-1',
    feeChargeId: 'charge-1',
  })
}

const setup = (now = safeNow) => {
  const cancellations = new InMemoryAuctionCancellationRepository()
  const auctions = new InMemoryAuctionRepository(cancellations)
  publish(auctions)
  const fees = new StubPublicationFeePort()
  const inventory = new StubProductInventoryPort()
  const clock = new StubClock(now)
  const cancelAuction = new CancelAuction(auctions, cancellations, fees, inventory, clock)
  const logger = silentLogger()
  const reconciler = new AuctionCancellationReconciler(
    cancellations,
    cancelAuction,
    clock,
    logger,
    {
      batchSize: 50,
      leaseMs: 60_000,
      workerId: 'worker-test',
    },
  )
  return { cancellations, auctions, cancelAuction, fees, inventory, clock, reconciler, logger }
}

describe('AuctionCancellationReconciler', () => {
  it('no reclama nada si no hay cancelaciones pendientes', async () => {
    const { reconciler } = setup()
    const result = await reconciler.runBatch()
    expect(result).toEqual({
      claimed: 0,
      confirmed: 0,
      retryable: 0,
      terminal: 0,
      unexpectedErrors: 0,
    })
  })

  // 1. ambos CONFIRMED -> no se vuelve a procesar.
  it('no reprocesa una cancelacion con Wallet e Inventory ya CONFIRMED', async () => {
    const { cancelAuction, reconciler, fees, inventory } = setup()
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })
    fees.refundCalls.length = 0
    inventory.releaseCalls.length = 0

    const result = await reconciler.runBatch()
    expect(result.claimed).toBe(0)
    expect(fees.refundCalls).toHaveLength(0)
    expect(inventory.releaseCalls).toHaveLength(0)
  })

  // 2/9. recuperacion tras "crash": la cancelacion se confirma localmente
  // (vía el repositorio, sin pasar por CancelAuction.execute) y el
  // reconciler es quien completa Wallet/Inventory por primera vez.
  it('completa Wallet e Inventory de una cancelacion nunca resuelta, sin que el cliente reintente', async () => {
    const { cancellations, auctions, reconciler, fees, inventory } = setup()
    await auctions.cancelAuction({
      operationId: 'op-1',
      auctionId,
      sellerId,
      productId,
      cancelledAt: safeNow,
      inventoryCommitmentId: 'commitment-1',
      feeChargeId: 'charge-1',
      refundAmountCredits: 1.5,
      walletRefundOperationId: `auction:${auctionId}:cancellation:wallet-refund`,
      inventoryReleaseOperationId: `auction:${auctionId}:cancellation:inventory-release`,
    })
    expect((await cancellations.getByAuctionId(auctionId))?.walletRefundStatus).toBe(
      AuctionCancellationEffectStatus.Pending,
    )

    const result = await reconciler.runBatch()
    expect(result.confirmed).toBe(1)
    expect(fees.refundCalls).toHaveLength(1)
    expect(inventory.releaseCalls).toHaveLength(1)
  })

  // 3. Wallet RETRYABLE -> CONFIRMED.
  it('reintenta Wallet RETRYABLE hasta CONFIRMED', async () => {
    const { cancelAuction, reconciler, fees } = setup()
    fees.behavior = 'unavailable'
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })

    fees.behavior = 'success'
    const result = await reconciler.runBatch()
    expect(result.confirmed).toBe(1)
    expect(fees.refundCalls).toHaveLength(2)
  })

  // 4. Inventory RETRYABLE -> CONFIRMED.
  it('reintenta Inventory RETRYABLE hasta CONFIRMED', async () => {
    const { cancelAuction, reconciler, inventory } = setup()
    inventory.behavior = 'unavailable'
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })

    inventory.behavior = 'success'
    const result = await reconciler.runBatch()
    expect(result.confirmed).toBe(1)
    expect(inventory.releaseCalls).toHaveLength(2)
  })

  // 5. Wallet CONFIRMED + Inventory RETRYABLE -> solo ejecuta Inventory.
  it('no vuelve a llamar a Wallet si ya esta CONFIRMED', async () => {
    const { cancelAuction, reconciler, fees, inventory } = setup()
    inventory.behavior = 'unavailable'
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(fees.refundCalls).toHaveLength(1)

    inventory.behavior = 'success'
    await reconciler.runBatch()
    expect(fees.refundCalls).toHaveLength(1)
    expect(inventory.releaseCalls).toHaveLength(2)
  })

  // 6. TERMINAL_ERROR no se reintenta.
  it('no reintenta un release en TERMINAL_ERROR', async () => {
    const { cancelAuction, reconciler, inventory } = setup()
    inventory.behavior = 'not-found'
    const result = await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(result.cancellation.inventoryReleaseStatus).toBe(
      AuctionCancellationEffectStatus.TerminalError,
    )

    inventory.releaseCalls.length = 0
    const batch = await reconciler.runBatch()
    expect(batch.claimed).toBe(0)
    expect(inventory.releaseCalls).toHaveLength(0)
  })

  // 7/12. mismo operationId en cada reintento.
  it('reutiliza el mismo operationId de Wallet y de Inventory en cada reintento', async () => {
    const { cancelAuction, reconciler, fees, inventory } = setup()
    fees.behavior = 'unavailable'
    inventory.behavior = 'unavailable'
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })

    fees.behavior = 'success'
    inventory.behavior = 'success'
    await reconciler.runBatch()

    const walletIds = new Set(fees.refundCalls.map((call) => call.operationId))
    const inventoryIds = new Set(inventory.releaseCalls.map((call) => call.operationId))
    expect(walletIds.size).toBe(1)
    expect(inventoryIds.size).toBe(1)
    expect([...walletIds][0]).toBe(`auction:${auctionId}:cancellation:wallet-refund`)
    expect([...inventoryIds][0]).toBe(`auction:${auctionId}:cancellation:inventory-release`)
  })

  // 8. dos ejecuciones del reconciler no duplican refund/release ya CONFIRMED.
  it('dos ejecuciones consecutivas no duplican efectos ya confirmados', async () => {
    const { cancelAuction, reconciler, fees, inventory } = setup()
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })
    fees.refundCalls.length = 0
    inventory.releaseCalls.length = 0

    await reconciler.runBatch()
    await reconciler.runBatch()
    expect(fees.refundCalls).toHaveLength(0)
    expect(inventory.releaseCalls).toHaveLength(0)
  })

  it('cuenta un fallo no clasificado como unexpectedError sin detener el batch', async () => {
    const { cancellations, auctions, reconciler, fees } = setup()
    await auctions.cancelAuction({
      operationId: 'op-1',
      auctionId,
      sellerId,
      productId,
      cancelledAt: safeNow,
      inventoryCommitmentId: 'commitment-1',
      feeChargeId: 'charge-1',
      refundAmountCredits: 1.5,
      walletRefundOperationId: `auction:${auctionId}:cancellation:wallet-refund`,
      inventoryReleaseOperationId: `auction:${auctionId}:cancellation:inventory-release`,
    })
    fees.refund = () => Promise.reject(new Error('fallo inesperado de Wallet'))

    const result = await reconciler.runBatch()
    expect(result.unexpectedErrors).toBe(1)
    expect((await cancellations.getByAuctionId(auctionId))?.walletRefundStatus).toBe(
      AuctionCancellationEffectStatus.Pending,
    )
  })

  it('registra inicio, resultado y fin del batch cuando reclama trabajo', async () => {
    const { cancelAuction, reconciler, fees, logger } = setup()
    fees.behavior = 'unavailable'
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })

    await reconciler.runBatch()
    expect(logger.info).toHaveBeenCalledWith(
      'auction_cancellation_reconciler_batch_started',
      expect.objectContaining({ claimed: 1 }),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      'auction_cancellation_reconciler_retryable',
      expect.objectContaining({ auctionId }),
    )
    expect(logger.info).toHaveBeenCalledWith(
      'auction_cancellation_reconciler_batch_completed',
      expect.objectContaining({ claimed: 1, retryable: 1 }),
    )
  })

  it('no emite logs de batch cuando no hay nada que reclamar', async () => {
    const { cancelAuction, reconciler, logger } = setup()
    await cancelAuction.execute({ operationId: 'op-1', auctionId, sellerId })

    await reconciler.runBatch()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
