import { Auction, AuctionStatus } from '../../src/domain/entities/Auction'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import {
  AuctionCancellationNotFoundError,
  AuctionCancellationOwnershipError,
} from '../../src/application/errors/AuctionCancellationError'
import { IdempotencyConflictError } from '../../src/application/errors/AuctionPersistenceError'
import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import { AuctionCancellationEffectStatus } from '../../src/application/ports/AuctionCancellationRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
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

const CANCELLATION_WINDOW_MS = 6 * 60 * 60 * 1000
const publishedAt = new Date('2026-09-21T12:00:00.000Z')
// 48h de duracion (ver `publish()` mas abajo, fee=3 -> refund=1.5).
const closesAt = new Date('2026-09-23T12:00:00.000Z')
const safeNow = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS - 1)

class StubClock implements ClockPort {
  constructor(private current: Date) {}
  now(): Date {
    return this.current
  }
}

type RefundBehavior = 'success' | 'unavailable' | 'conflict' | 'other'

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
    if (this.behavior === 'conflict') throw new IdempotencyConflictError()
    if (this.behavior === 'other') throw new Error('fallo inesperado de Wallet')
  }
}

type ReleaseBehavior = 'success' | 'unavailable' | 'not-found' | 'other'

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
    if (this.behavior === 'other') throw new Error('fallo inesperado de Inventory')
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

const auctionId = 'auction-90-1'
const sellerId = 'seller-1'
const productId = 'product-1'

/** `publicationFeeCredits=3` (48h) para que el 50% (1.5) no coincida por accidente con otro numero del test. */
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
  // El mismo `cancellations` que recibe `InMemoryAuctionRepository`: es el
  // almacen que `cancelAuction()` puebla, igual que en produccion comparten
  // la misma transaccion Postgres (ver app.module.ts).
  const cancellations = new InMemoryAuctionCancellationRepository()
  const auctions = new InMemoryAuctionRepository(cancellations)
  publish(auctions)
  const fees = new StubPublicationFeePort()
  const inventory = new StubProductInventoryPort()
  const clock = new StubClock(now)
  const useCase = new CancelAuction(auctions, cancellations, fees, inventory, clock)
  return { auctions, cancellations, fees, inventory, clock, useCase }
}

describe('CancelAuction (HU-90)', () => {
  // 5. no owner -> rechazo.
  it('rechaza cancelar si el solicitante no es el vendedor', async () => {
    const { useCase } = setup()
    await expect(
      useCase.execute({ operationId: 'op-1', auctionId, sellerId: 'another-player' }),
    ).rejects.toBeInstanceOf(AuctionCancellationOwnershipError)
  })

  it('rechaza cancelar una subasta inexistente', async () => {
    const { useCase } = setup()
    await expect(
      useCase.execute({ operationId: 'op-1', auctionId: 'missing', sellerId }),
    ).rejects.toBeInstanceOf(AuctionCancellationNotFoundError)
  })

  it('propaga la regla de dominio (ventana de 6h) sin tocar Wallet/Inventory', async () => {
    const closesSoon = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS)
    const { useCase, fees, inventory } = setup(closesSoon)
    await expect(
      useCase.execute({ operationId: 'op-1', auctionId, sellerId }),
    ).rejects.toBeInstanceOf(AuctionRuleViolation)
    expect(fees.refundCalls).toHaveLength(0)
    expect(inventory.releaseCalls).toHaveLength(0)
  })

  // 19/20. fee 1 -> refund 0.5; fee 3 -> refund 1.5 (aqui con fee 3 -> 1.5; el
  // caso fee 1 -> 0.5 se cubre en el test de integracion HTTP y en DB).
  it('calcula el refund como el 50% exacto de publicationFeeCredits (3 -> 1.5)', async () => {
    const { useCase, fees, cancellations } = setup()
    const result = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })

    expect(result.cancellation.refundAmountCredits).toBe(1.5)
    expect(fees.refundCalls).toEqual([
      { operationId: fees.refundCalls[0]!.operationId, chargeId: 'charge-1', amount: 1.5 },
    ])
    const stored = await cancellations.getByAuctionId(auctionId)
    expect(stored?.refundAmountCredits).toBe(1.5)
    expect(stored?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
  })

  // 21. operationId del refund estable (deterministico por auctionId).
  it('usa un operationId de Wallet deterministico', async () => {
    const { useCase, fees } = setup()
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(fees.refundCalls[0]?.operationId).toBe(`auction:${auctionId}:cancellation:wallet-refund`)
  })

  // 22. retry no produce refund doble.
  it('un replay no vuelve a llamar a Wallet si el refund ya quedo confirmado', async () => {
    const { useCase, fees } = setup()
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(fees.refundCalls).toHaveLength(1)

    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(fees.refundCalls).toHaveLength(1)
  })

  // 23. error Wallet tratado segun la estrategia definida (retryable vs terminal).
  it('marca RETRYABLE si Wallet no esta disponible, y lo resuelve en el siguiente intento', async () => {
    const { useCase, fees } = setup()
    fees.behavior = 'unavailable'
    const result = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(result.cancellation.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Retryable)
    expect(result.cancellation.walletRefundLastError).toContain(
      'ExternalDependencyUnavailableError',
    )

    fees.behavior = 'success'
    const retried = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(retried.cancellation.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
    expect(fees.refundCalls).toHaveLength(2)
  })

  it('marca TERMINAL_ERROR ante un conflicto de idempotencia en Wallet y no lo reintenta', async () => {
    const { useCase, fees, cancellations } = setup()
    fees.behavior = 'conflict'
    const result = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(result.cancellation.walletRefundStatus).toBe(
      AuctionCancellationEffectStatus.TerminalError,
    )

    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(fees.refundCalls).toHaveLength(1)
    const stored = await cancellations.getByAuctionId(auctionId)
    expect(stored?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.TerminalError)
  })

  it('propaga un fallo no clasificado de Wallet en lugar de ocultarlo', async () => {
    const { useCase, fees } = setup()
    fees.behavior = 'other'
    await expect(useCase.execute({ operationId: 'op-1', auctionId, sellerId })).rejects.toThrow(
      'fallo inesperado de Wallet',
    )
  })

  // 24. usa reason AUCTION_CANCELLED.
  it('libera el commitment en Inventory con reason AUCTION_CANCELLED', async () => {
    const { useCase, inventory } = setup()
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(inventory.releaseCalls[0]).toMatchObject({
      commitmentId: 'commitment-1',
      auctionId,
      ownerId: sellerId,
      productId,
      reason: 'AUCTION_CANCELLED',
    })
  })

  // 25. operationId estable.
  it('usa un operationId de Inventory deterministico', async () => {
    const { useCase, inventory } = setup()
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(inventory.releaseCalls[0]?.operationId).toBe(
      `auction:${auctionId}:cancellation:inventory-release`,
    )
  })

  // 26. retry no duplica release.
  it('un replay no vuelve a llamar a Inventory si el release ya quedo confirmado', async () => {
    const { useCase, inventory } = setup()
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(inventory.releaseCalls).toHaveLength(1)
  })

  // 27. error Inventory tratado segun la estrategia definida.
  it('marca RETRYABLE si Inventory no esta disponible, y lo resuelve en el siguiente intento', async () => {
    const { useCase, inventory } = setup()
    inventory.behavior = 'unavailable'
    const result = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(result.cancellation.inventoryReleaseStatus).toBe(
      AuctionCancellationEffectStatus.Retryable,
    )

    inventory.behavior = 'success'
    const retried = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(retried.cancellation.inventoryReleaseStatus).toBe(
      AuctionCancellationEffectStatus.Confirmed,
    )
  })

  it('marca TERMINAL_ERROR si Inventory responde que el commitment no existe', async () => {
    const { useCase, inventory } = setup()
    inventory.behavior = 'not-found'
    const result = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(result.cancellation.inventoryReleaseStatus).toBe(
      AuctionCancellationEffectStatus.TerminalError,
    )
  })

  it('propaga un fallo no clasificado de Inventory en lugar de ocultarlo', async () => {
    const { useCase, inventory } = setup()
    inventory.behavior = 'other'
    await expect(useCase.execute({ operationId: 'op-1', auctionId, sellerId })).rejects.toThrow(
      'fallo inesperado de Inventory',
    )
  })

  it('transiciona la subasta a CANCELLED y resuelve ambos efectos en una sola ejecucion sin fallos', async () => {
    const { useCase, auctions } = setup()
    const result = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })

    expect(result.auction.status).toBe(AuctionStatus.Cancelled)
    expect(result.replayed).toBe(false)
    expect(result.cancellation.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
    expect(result.cancellation.inventoryReleaseStatus).toBe(
      AuctionCancellationEffectStatus.Confirmed,
    )
    const persisted = await auctions.findById(auctionId)
    expect(persisted?.status).toBe(AuctionStatus.Cancelled)
  })

  it('un operationId distinto contra una subasta ya cancelada se rechaza como AUCTION_NOT_ACTIVE', async () => {
    const { useCase } = setup()
    await useCase.execute({ operationId: 'op-1', auctionId, sellerId })

    await expect(
      useCase.execute({ operationId: 'op-2', auctionId, sellerId }),
    ).rejects.toMatchObject({ code: AuctionRuleCode.AuctionNotActive })
  })

  it('reporta replayed=true en una ejecucion repetida con el mismo Idempotency-Key', async () => {
    const { useCase } = setup()
    const first = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(first.replayed).toBe(false)

    const replay = await useCase.execute({ operationId: 'op-1', auctionId, sellerId })
    expect(replay.replayed).toBe(true)
  })
})
