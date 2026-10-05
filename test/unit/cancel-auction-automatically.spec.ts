import { InMemoryAuctionCancellationRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionCancellationRepository'
import { InMemoryAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { InMemoryBidCreditOperationReader } from '../../src/adapters/outbound/persistence/InMemoryBidCreditOperationReader'
import { AuctionCancellationNotFoundError } from '../../src/application/errors/AuctionCancellationError'
import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
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
import type {
  ClaimedInventoryProductCommitment,
  InventoryProductCommitment,
  InventoryProductEligibility,
  PendingClaimInventoryProductCommitment,
  ProductInventoryPort,
  ReleasedInventoryProductCommitment,
  ReleaseInventoryProductCommand,
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
import { ClassifyAuctionLoserCredits } from '../../src/application/use-cases/ClassifyAuctionLoserCredits'
import { PrepareAuctionLoserReleaseTasks } from '../../src/application/use-cases/PrepareAuctionLoserReleaseTasks'
import { SettleAuction } from '../../src/application/use-cases/SettleAuction'
import { Auction, AuctionStatus } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import {
  AuctionCancellationOrigin,
  createAuctionCancelledEventV1,
} from '../../src/domain/events/AuctionCancelledEventV1'

const publishedAt = new Date('2026-09-21T12:00:00.000Z')
const now = new Date('2026-09-21T13:00:00.000Z')
const auctionId = 'auction-ca05-1'
const sellerId = 'seller-1'
const productId = 'product-1'
const sanctionId = 'sanction-1'

class StubClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

class StubWallet implements AuctionWalletPort {
  readonly releaseCalls: ReleaseAuctionHoldCommand[] = []
  readonly captureCalls: CaptureAuctionHoldCommand[] = []
  /** Resultado por hold; lo no listado responde SUCCESS. */
  readonly outcomes = new Map<string, WalletHoldOutcome>()
  /** Para outcome SUCCESS: holdStatus/applied por hold; por defecto RELEASED/true. */
  readonly successResults = new Map<string, { holdStatus: string; applied: boolean }>()

  captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> {
    this.captureCalls.push(command)
    return Promise.resolve({
      outcome: 'SUCCESS',
      operationId: command.operationId,
      holdId: command.holdId,
      holdStatus: 'CAPTURED',
      applied: true,
    })
  }

  releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> {
    this.releaseCalls.push(command)
    const outcome = this.outcomes.get(command.holdId) ?? 'SUCCESS'
    if (outcome !== 'SUCCESS') {
      return Promise.resolve({ outcome, operationId: command.operationId, holdId: command.holdId })
    }
    const success = this.successResults.get(command.holdId) ?? {
      holdStatus: 'RELEASED',
      applied: true,
    }
    return Promise.resolve({
      outcome,
      operationId: command.operationId,
      holdId: command.holdId,
      holdStatus: success.holdStatus,
      applied: success.applied,
    })
  }
}

type ReleaseBehavior = 'success' | 'unavailable' | 'not-found' | 'other'

class StubInventory implements ProductInventoryPort {
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

const publish = async (
  auctions: InMemoryAuctionRepository,
  durationHours: 24 | 48,
  id = auctionId,
): Promise<void> => {
  await auctions.publish({
    operationId: `publish:${id}`,
    auction: Auction.publish({
      auctionId: id,
      sellerId,
      productId: id === auctionId ? productId : `product:${id}`,
      durationHours,
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
    }),
    inventoryCommitmentId: `commitment:${id}`,
    feeChargeId: `charge:${id}`,
  })
}

/**
 * Puja completa por el mismo camino que `PersistBidWithCredits`: operacion
 * RESERVED -> puja persistida -> (opcional) COMPLETED cuando Wallet confirmo
 * el release del lider anterior.
 */
const placeBid = async (
  auctions: InMemoryAuctionRepository,
  index: number,
  options: { readonly completed?: boolean } = {},
): Promise<string> => {
  const operationId = `bid-op-${String(index)}`
  const bidId = `bid-${String(index)}`
  const reservationId = `hold-${String(index)}`
  const placedAt = new Date(publishedAt.getTime() + index * 60_000)
  const amountCredits = 10 * index
  await auctions.createBidCreditOperation({
    operationId,
    bidId,
    auctionId,
    bidderId: `bidder-${String(index)}`,
    amountCredits,
    createdAt: placedAt,
  })
  await auctions.updateBidCreditOperation({
    operationId,
    status: 'RESERVED',
    reservationId,
    previousReservationId: null,
    updatedAt: placedAt,
  })
  const persisted = await auctions.persistBid(
    Bid.restore({
      id: bidId,
      auctionId,
      bidderId: `bidder-${String(index)}`,
      amountCredits,
      placedAt,
    }),
    reservationId,
    operationId,
  )
  if (options.completed ?? true) {
    await auctions.updateBidCreditOperation({
      operationId,
      status: 'COMPLETED',
      reservationId,
      previousReservationId: persisted.previousLeaderReservationId,
      updatedAt: placedAt,
    })
  }
  return reservationId
}

const setup = async (options: { durationHours?: 24 | 48; now?: Date } = {}) => {
  const cancellations = new InMemoryAuctionCancellationRepository()
  const auctions = new InMemoryAuctionRepository(cancellations)
  await publish(auctions, options.durationHours ?? 24)
  const wallet = new StubWallet()
  const inventory = new StubInventory()
  const fees = new StubPublicationFeePort()
  const clock = new StubClock(options.now ?? now)
  const useCase = new CancelAuctionAutomatically(auctions, cancellations, wallet, inventory, clock)
  const manual = new CancelAuction(auctions, cancellations, fees, inventory, clock)
  const reconciler = new AuctionCancellationReconciler(
    cancellations,
    new AuctionCancellationEffectsResolver(manual, useCase),
    clock,
    silentLogger,
    { batchSize: 10, leaseMs: 60_000, workerId: 'worker-1' },
  )
  return { auctions, cancellations, wallet, inventory, fees, clock, useCase, manual, reconciler }
}

describe('Auction.cancelAutomatically (HU-90, CA-05)', () => {
  const rehydrate = (status: AuctionStatus): Auction =>
    Auction.rehydrate({
      id: auctionId,
      sellerId,
      productId,
      durationHours: 24,
      publicationFeeCredits: 1,
      minimumBidCredits: 10,
      buyNowCredits: null,
      status,
      publishedAt,
      closesAt: new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000),
      finishedAt: null,
      closingResult: null,
      cancelledAt: status === AuctionStatus.Cancelled ? now : null,
    })

  it('cancela una subasta ACTIVE sin mirar pujas ni la ventana de 6 horas', () => {
    const auction = rehydrate(AuctionStatus.Active)
    // A un milisegundo del cierre: la manual lo rechazaria por la ventana.
    const lastInstant = new Date(auction.closesAt.getTime() - 1)

    expect(auction.cancelAutomatically({ now: lastInstant })).toEqual(lastInstant)
    expect(auction.status).toBe(AuctionStatus.Cancelled)
    expect(auction.cancelledAt).toEqual(lastInstant)
    expect(auction.closingResult).toBeNull()
  })

  it.each([AuctionStatus.Cancelled, AuctionStatus.SoldByBuyNow])(
    'rechaza una subasta %s: una CANCELLED nunca se vuelve a cancelar ni vuelve a ACTIVE',
    (status) => {
      const auction = rehydrate(status)
      try {
        auction.cancelAutomatically({ now })
        throw new Error('debio rechazar')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AuctionRuleViolation)
        expect((error as AuctionRuleViolation).code).toBe(AuctionRuleCode.AuctionNotActive)
      }
      expect(auction.status).toBe(status)
    },
  )

  it('la cancelacion manual conserva sus reglas propias (pujas y ventana)', () => {
    const auction = rehydrate(AuctionStatus.Active)
    expect(() => auction.cancel({ now, bidCount: 1 })).toThrow(AuctionRuleViolation)
    expect(() =>
      auction.cancel({ now: new Date(auction.closesAt.getTime() - 1), bidCount: 0 }),
    ).toThrow(AuctionRuleViolation)
    expect(auction.status).toBe(AuctionStatus.Active)
  })
})

describe('auction.cancelled.v1 con origen (HU-90, CA-05)', () => {
  it('una cancelacion automatica publica origin TERMS_VIOLATION y la sancion que la disparo', () => {
    const event = createAuctionCancelledEventV1({
      auctionId,
      sellerId,
      productId,
      cancelledAt: now,
      origin: AuctionCancellationOrigin.TermsViolation,
      triggerReferenceId: sanctionId,
    })

    expect(event.eventId).toBe(`auction:${auctionId}:cancelled`)
    expect(event.data).toEqual({
      auctionId,
      sellerId,
      productId,
      cancelledAt: now.toISOString(),
      origin: 'TERMS_VIOLATION',
      triggerReferenceId: sanctionId,
    })
  })

  it('una cancelacion manual publica origin MANUAL sin referencia', () => {
    const event = createAuctionCancelledEventV1({
      auctionId,
      sellerId,
      productId,
      cancelledAt: now,
      origin: AuctionCancellationOrigin.Manual,
      triggerReferenceId: null,
    })

    expect(event.data.origin).toBe('MANUAL')
    expect(event.data.triggerReferenceId).toBeNull()
  })
})

describe('CancelAuctionAutomatically (HU-90, CA-05)', () => {
  it('sin pujas: ACTIVE -> CANCELLED, libera inventario y no toca Wallet', async () => {
    const { auctions, useCase, wallet, inventory } = await setup()

    const result = await useCase.execute({ auctionId, sanctionId })

    expect(result.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
    await expect(auctions.findById(auctionId)).resolves.toMatchObject({
      status: AuctionStatus.Cancelled,
      cancelledAt: now,
    })
    expect(wallet.releaseCalls).toEqual([])
    expect(inventory.releaseCalls).toEqual([
      {
        operationId: `auction:${auctionId}:cancellation:inventory-release`,
        commitmentId: `commitment:${auctionId}`,
        auctionId,
        ownerId: sellerId,
        productId,
        reason: 'AUCTION_CANCELLED',
      },
    ])
    expect(result.cancellation).toMatchObject({
      operationId: automaticCancellationOperationId(sanctionId, auctionId),
      origin: 'TERMS_VIOLATION',
      triggerReferenceId: sanctionId,
      refundAmountCredits: 0,
      walletRefundOperationId: null,
      walletRefundStatus: AuctionCancellationEffectStatus.NotRequired,
      inventoryReleaseStatus: AuctionCancellationEffectStatus.Confirmed,
      reservationReleases: [],
    })
  })

  it('usa la idempotencia determinista automatic-cancellation:<sanctionId>:<auctionId>', () => {
    expect(automaticCancellationOperationId('s-9', 'a-7')).toBe('automatic-cancellation:s-9:a-7')
  })

  it('con una puja: cancela, libera la reserva del lider y el inventario, sin ganador', async () => {
    const { auctions, useCase, wallet, inventory } = await setup()
    await placeBid(auctions, 1)

    const result = await useCase.execute({ auctionId, sanctionId })

    expect(result.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
    expect(wallet.releaseCalls).toEqual([
      {
        holdId: 'hold-1',
        operationId: `auction:${auctionId}:cancellation:reservation:hold-1:release`,
        reason: 'AUCTION_CANCELLED',
      },
    ])
    expect(wallet.captureCalls).toEqual([])
    expect(inventory.releaseCalls).toHaveLength(1)
    expect(result.cancellation?.reservationReleases).toEqual([
      expect.objectContaining({
        reservationId: 'hold-1',
        status: AuctionCancellationEffectStatus.Confirmed,
        lastError: null,
      }),
    ])
    const aggregate = await auctions.findAuctionAggregate(auctionId)
    expect(aggregate?.status).toBe(AuctionStatus.Cancelled)
    expect(aggregate?.closingResult).toBeNull()
  })

  it('con varias pujas ya superadas: solo sigue retenida (y se libera) la del lider', async () => {
    const { auctions, useCase, wallet } = await setup()
    await placeBid(auctions, 1)
    await placeBid(auctions, 2)
    await placeBid(auctions, 3)

    await useCase.execute({ auctionId, sanctionId })

    expect(wallet.releaseCalls.map((call) => call.holdId)).toEqual(['hold-3'])
  })

  it('con varias pujas y un release de lider superado sin confirmar: ningun postor queda retenido', async () => {
    const { auctions, useCase, wallet } = await setup()
    await placeBid(auctions, 1)
    // El release de hold-1 fallo al superarlo: la operacion queda BID_PERSISTED.
    await placeBid(auctions, 2, { completed: false })
    await placeBid(auctions, 3, { completed: false })

    const result = await useCase.execute({ auctionId, sanctionId })

    expect(wallet.releaseCalls.map((call) => call.holdId)).toEqual(['hold-1', 'hold-2', 'hold-3'])
    expect(
      result.cancellation?.reservationReleases.every(
        (release) => release.status === AuctionCancellationEffectStatus.Confirmed,
      ),
    ).toBe(true)
  })

  it('se permite dentro de las ultimas 6 horas y con pujas', async () => {
    // 24h de duracion, a 1 minuto del cierre.
    const lastMinute = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000 - 60_000)
    const { auctions, useCase } = await setup({ now: lastMinute })
    await placeBid(auctions, 1)

    const result = await useCase.execute({ auctionId, sanctionId })

    expect(result.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
    await expect(auctions.findById(auctionId)).resolves.toMatchObject({
      status: AuctionStatus.Cancelled,
      cancelledAt: lastMinute,
    })
  })

  it('exactamente en endsAt, si sigue ACTIVE, la cancelacion gana y settlement ya no la finaliza', async () => {
    const endsAt = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000)
    const { auctions, useCase } = await setup({ now: endsAt })

    const result = await useCase.execute({ auctionId, sanctionId })

    expect(result.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
    const aggregate = await auctions.findAuctionAggregate(auctionId)
    if (aggregate === null) throw new Error('La subasta no existe.')
    // El CAS de `finishAuction` exige ACTIVE: una CANCELLED no se finaliza.
    const closing = Auction.rehydrate({
      ...aggregate.snapshot(),
      status: AuctionStatus.Active,
      cancelledAt: null,
      finishedAt: null,
      closingResult: null,
    }).finish({ finishedAt: endsAt, leadingBid: null })
    expect(() =>
      auctions.finishAuction({ auctionId, finishedAt: endsAt, closingResult: closing }),
    ).toThrow('La subasta ya fue finalizada.')
  })

  it('no valida propietario: es una operacion de sistema sin sellerId en el comando', async () => {
    const { useCase, cancellations } = await setup()

    await useCase.execute({ auctionId, sanctionId })

    // El vendedor se lee de la propia subasta, no de quien invoca.
    await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({ sellerId })
  })

  it('rechaza una subasta inexistente', async () => {
    const { useCase } = await setup()

    await expect(useCase.execute({ auctionId: 'missing', sanctionId })).rejects.toBeInstanceOf(
      AuctionCancellationNotFoundError,
    )
  })

  describe('idempotencia', () => {
    it('la misma sancion repetida no duplica transicion ni efectos', async () => {
      const { auctions, useCase, wallet, inventory, cancellations } = await setup()
      await placeBid(auctions, 1)

      const first = await useCase.execute({ auctionId, sanctionId })
      const second = await useCase.execute({ auctionId, sanctionId })

      expect(first.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
      expect(second.outcome).toBe(AutomaticCancellationOutcome.AlreadyCancelled)
      expect(wallet.releaseCalls).toHaveLength(1)
      expect(inventory.releaseCalls).toHaveLength(1)
      expect(second.cancellation?.cancelledAt).toEqual(first.cancellation?.cancelledAt)
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        operationId: automaticCancellationOperationId(sanctionId, auctionId),
      })
    })

    it('otro ciclo del scheduler, mas tarde, tampoco repite efectos', async () => {
      const { auctions, useCase, wallet, inventory, clock } = await setup()
      await placeBid(auctions, 1)
      await useCase.execute({ auctionId, sanctionId })

      clock.current = new Date(now.getTime() + 30_000)
      const later = await useCase.execute({ auctionId, sanctionId })

      expect(later.outcome).toBe(AutomaticCancellationOutcome.AlreadyCancelled)
      expect(later.cancellation?.cancelledAt).toEqual(now)
      expect(wallet.releaseCalls).toHaveLength(1)
      expect(inventory.releaseCalls).toHaveLength(1)
    })

    it('otra sancion sobre la misma subasta no genera una segunda cancelacion', async () => {
      const { useCase, inventory, cancellations } = await setup()
      await useCase.execute({ auctionId, sanctionId })

      const other = await useCase.execute({ auctionId, sanctionId: 'sanction-2' })

      expect(other.outcome).toBe(AutomaticCancellationOutcome.AlreadyCancelled)
      expect(inventory.releaseCalls).toHaveLength(1)
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        triggerReferenceId: sanctionId,
      })
    })

    it('una subasta ya cancelada manualmente no se toca ni repite efectos', async () => {
      const { useCase, manual, wallet, inventory, fees, cancellations } = await setup({
        durationHours: 48,
      })
      await manual.execute({ operationId: 'manual-op', auctionId, sellerId })
      const refundsBefore = fees.refundCalls.length
      const releasesBefore = inventory.releaseCalls.length

      const result = await useCase.execute({ auctionId, sanctionId })

      expect(result).toEqual({
        outcome: AutomaticCancellationOutcome.NotActive,
        cancellation: null,
      })
      expect(wallet.releaseCalls).toEqual([])
      expect(fees.refundCalls).toHaveLength(refundsBefore)
      expect(inventory.releaseCalls).toHaveLength(releasesBefore)
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        origin: 'MANUAL',
        triggerReferenceId: null,
      })
    })

    it('una subasta ya finalizada no se cancela', async () => {
      const { auctions, useCase, inventory, cancellations } = await setup()
      const aggregate = await auctions.findAuctionAggregate(auctionId)
      if (aggregate === null) throw new Error('La subasta no existe.')
      const finishedAt = new Date(aggregate.closesAt)
      await auctions.finishAuction({
        auctionId,
        finishedAt,
        closingResult: aggregate.finish({ finishedAt, leadingBid: null }),
      })

      const result = await useCase.execute({ auctionId, sanctionId })

      expect(result).toEqual({
        outcome: AutomaticCancellationOutcome.NotActive,
        cancellation: null,
      })
      expect(inventory.releaseCalls).toEqual([])
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toBeNull()
    })

    it('si otra transicion gana bajo el lock, no cancela ni lanza', async () => {
      const { auctions, cancellations, wallet, inventory, clock } = await setup()
      // Simula perder la carrera entre la lectura y el CAS.
      jest
        .spyOn(auctions, 'cancelAuctionAutomatically')
        .mockRejectedValue(
          new AuctionRuleViolation(AuctionRuleCode.AuctionNotActive, 'ya no esta activa'),
        )
      const useCase = new CancelAuctionAutomatically(
        auctions,
        cancellations,
        wallet,
        inventory,
        clock,
      )

      await expect(useCase.execute({ auctionId, sanctionId })).resolves.toEqual({
        outcome: AutomaticCancellationOutcome.NotActive,
        cancellation: null,
      })
      expect(inventory.releaseCalls).toEqual([])
    })

    it('propaga un error de persistencia que no es una carrera', async () => {
      const { auctions, cancellations, wallet, inventory, clock } = await setup()
      jest.spyOn(auctions, 'cancelAuctionAutomatically').mockRejectedValue(new Error('db caida'))
      const useCase = new CancelAuctionAutomatically(
        auctions,
        cancellations,
        wallet,
        inventory,
        clock,
      )

      await expect(useCase.execute({ auctionId, sanctionId })).rejects.toThrow('db caida')
    })
  })

  describe('regla economica: la comision de publicacion no se reembolsa', () => {
    it.each([
      [24, 1],
      [48, 3],
    ] as const)(
      'duracion %ih (comision %i): refund NO llamado, sin 0.5 ni 1.5',
      async (durationHours, publicationFeeCredits) => {
        const { auctions, useCase, fees, reconciler } = await setup({ durationHours })
        await expect(auctions.findById(auctionId)).resolves.toMatchObject({ publicationFeeCredits })

        const result = await useCase.execute({ auctionId, sanctionId })
        await reconciler.runBatch()

        expect(fees.refundCalls).toEqual([])
        expect(result.cancellation?.refundAmountCredits).toBe(0)
        expect(result.cancellation?.walletRefundOperationId).toBeNull()
        expect(result.cancellation?.walletRefundStatus).toBe(
          AuctionCancellationEffectStatus.NotRequired,
        )
      },
    )
  })

  describe('release de reservas en Wallet', () => {
    it('un fallo transitorio deja el release en RETRYABLE y sigue con inventario', async () => {
      const { auctions, useCase, wallet, inventory } = await setup()
      await placeBid(auctions, 1)
      wallet.outcomes.set('hold-1', 'RETRYABLE')

      const result = await useCase.execute({ auctionId, sanctionId })

      expect(result.outcome).toBe(AutomaticCancellationOutcome.Cancelled)
      expect(result.cancellation?.reservationReleases).toEqual([
        expect.objectContaining({
          reservationId: 'hold-1',
          status: AuctionCancellationEffectStatus.Retryable,
          lastError: 'El release Wallet requiere reintento: RETRYABLE.',
        }),
      ])
      expect(inventory.releaseCalls).toHaveLength(1)
      expect(result.cancellation?.inventoryReleaseStatus).toBe(
        AuctionCancellationEffectStatus.Confirmed,
      )
    })

    it('una respuesta invalida de Wallet tambien es reintentable', async () => {
      const { auctions, useCase, wallet } = await setup()
      await placeBid(auctions, 1)
      wallet.outcomes.set('hold-1', 'INVALID_RESPONSE')

      const result = await useCase.execute({ auctionId, sanctionId })

      expect(result.cancellation?.reservationReleases[0]?.status).toBe(
        AuctionCancellationEffectStatus.Retryable,
      )
    })

    it('el reconciler reintenta con el MISMO operationId hasta confirmar', async () => {
      const { auctions, useCase, wallet, reconciler, cancellations } = await setup()
      await placeBid(auctions, 1)
      wallet.outcomes.set('hold-1', 'RETRYABLE')
      await useCase.execute({ auctionId, sanctionId })

      const stillFailing = await reconciler.runBatch()
      expect(stillFailing).toMatchObject({ claimed: 1, retryable: 1, confirmed: 0 })

      wallet.outcomes.delete('hold-1')
      const recovered = await reconciler.runBatch()

      expect(recovered).toMatchObject({ claimed: 1, confirmed: 1, retryable: 0, terminal: 0 })
      expect(new Set(wallet.releaseCalls.map((call) => call.operationId))).toEqual(
        new Set([`auction:${auctionId}:cancellation:reservation:hold-1:release`]),
      )
      expect(wallet.releaseCalls).toHaveLength(3)
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        reservationReleases: [
          expect.objectContaining({ status: AuctionCancellationEffectStatus.Confirmed }),
        ],
      })
    })

    it('un release ya confirmado no se vuelve a pedir (sin doble release)', async () => {
      const { auctions, useCase, wallet, reconciler } = await setup()
      await placeBid(auctions, 1)
      await useCase.execute({ auctionId, sanctionId })

      const batch = await reconciler.runBatch()
      await useCase.execute({ auctionId, sanctionId })

      expect(batch.claimed).toBe(0)
      expect(wallet.releaseCalls).toHaveLength(1)
    })

    it('solo reintenta la reserva pendiente, no las ya confirmadas', async () => {
      const { auctions, useCase, wallet, reconciler } = await setup()
      await placeBid(auctions, 1)
      await placeBid(auctions, 2, { completed: false })
      wallet.outcomes.set('hold-2', 'RETRYABLE')
      await useCase.execute({ auctionId, sanctionId })
      wallet.outcomes.delete('hold-2')

      await reconciler.runBatch()

      expect(wallet.releaseCalls.map((call) => call.holdId)).toEqual(['hold-1', 'hold-2', 'hold-2'])
    })

    it.each([
      ['RELEASED', true],
      ['RELEASED', false],
      ['EXPIRED', false],
    ] as const)(
      'un 200 con holdStatus %s y applied=%s cuenta como liberado (CONFIRMED)',
      async (holdStatus, applied) => {
        const { auctions, useCase, wallet } = await setup()
        await placeBid(auctions, 1)
        wallet.successResults.set('hold-1', { holdStatus, applied })

        const result = await useCase.execute({ auctionId, sanctionId })

        expect(result.cancellation?.reservationReleases).toEqual([
          expect.objectContaining({
            status: AuctionCancellationEffectStatus.Confirmed,
            lastError: null,
          }),
        ])
      },
    )

    it(
      'un hold ya CAPTURED (422 AUCTION_HOLD_ALREADY_CAPTURED) es TERMINAL_ERROR, no se da por ' +
        'liberado y el reconciler no lo reintenta',
      async () => {
        // El cliente de Wallet colapsa cualquier 422 de este endpoint en el
        // mismo outcome TERMINAL_RULE_ERROR, y el contrato real de release
        // solo devuelve 422 cuando el hold esta CAPTURED (cualquier otro
        // estado ya no-ACTIVE responde 200 RELEASED/EXPIRED). Por eso este
        // caso cubre a la vez "CAPTURED" y "cualquier otro 422": ninguno se
        // infiere como exito por el mensaje ni se confirma.
        const { auctions, useCase, wallet, reconciler } = await setup()
        await placeBid(auctions, 1)
        wallet.outcomes.set('hold-1', 'TERMINAL_RULE_ERROR')

        const result = await useCase.execute({ auctionId, sanctionId })
        const batch = await reconciler.runBatch()

        expect(result.cancellation?.reservationReleases).toEqual([
          expect.objectContaining({
            status: AuctionCancellationEffectStatus.TerminalError,
            lastError: 'El release Wallet fallo terminalmente: TERMINAL_RULE_ERROR.',
          }),
        ])
        expect(batch.claimed).toBe(0)
        expect(wallet.releaseCalls).toHaveLength(1)
      },
    )

    it.each(['TERMINAL_NOT_FOUND', 'TERMINAL_CONFLICT'] as const)(
      '%s es terminal: queda registrado y el reconciler no lo reintenta',
      async (outcome) => {
        const { auctions, useCase, wallet, reconciler } = await setup()
        await placeBid(auctions, 1)
        wallet.outcomes.set('hold-1', outcome)

        const result = await useCase.execute({ auctionId, sanctionId })
        const batch = await reconciler.runBatch()

        expect(result.cancellation?.reservationReleases).toEqual([
          expect.objectContaining({
            status: AuctionCancellationEffectStatus.TerminalError,
            lastError: `El release Wallet fallo terminalmente: ${outcome}.`,
          }),
        ])
        expect(batch.claimed).toBe(0)
        expect(wallet.releaseCalls).toHaveLength(1)
      },
    )

    it('el reconciler clasifica como terminal una automatica con un release terminal', async () => {
      const { auctions, useCase, wallet, inventory, reconciler } = await setup()
      await placeBid(auctions, 1)
      wallet.outcomes.set('hold-1', 'TERMINAL_NOT_FOUND')
      inventory.behavior = 'unavailable'
      await useCase.execute({ auctionId, sanctionId })
      inventory.behavior = 'success'

      const batch = await reconciler.runBatch()

      expect(batch).toMatchObject({ claimed: 1, terminal: 1, confirmed: 0 })
    })
  })

  describe('release de inventario', () => {
    it('un fallo transitorio queda RETRYABLE y el reconciler lo completa con el mismo operationId', async () => {
      const { useCase, inventory, reconciler, cancellations } = await setup()
      inventory.behavior = 'unavailable'

      const result = await useCase.execute({ auctionId, sanctionId })
      expect(result.cancellation?.inventoryReleaseStatus).toBe(
        AuctionCancellationEffectStatus.Retryable,
      )

      inventory.behavior = 'success'
      const batch = await reconciler.runBatch()

      expect(batch).toMatchObject({ claimed: 1, confirmed: 1 })
      expect(new Set(inventory.releaseCalls.map((call) => call.operationId))).toEqual(
        new Set([`auction:${auctionId}:cancellation:inventory-release`]),
      )
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        inventoryReleaseStatus: AuctionCancellationEffectStatus.Confirmed,
        inventoryReleaseLastError: null,
      })
    })

    it('un commitment que Inventory no reconoce es terminal', async () => {
      const { useCase, inventory, reconciler } = await setup()
      inventory.behavior = 'not-found'

      const result = await useCase.execute({ auctionId, sanctionId })
      const batch = await reconciler.runBatch()

      expect(result.cancellation?.inventoryReleaseStatus).toBe(
        AuctionCancellationEffectStatus.TerminalError,
      )
      expect(batch.claimed).toBe(0)
    })

    it('un fallo no clasificado se propaga, con la subasta ya CANCELLED y reconciliable', async () => {
      const { auctions, useCase, inventory, cancellations } = await setup()
      inventory.behavior = 'other'

      await expect(useCase.execute({ auctionId, sanctionId })).rejects.toThrow(
        'fallo inesperado de Inventory',
      )
      await expect(auctions.findById(auctionId)).resolves.toMatchObject({
        status: AuctionStatus.Cancelled,
      })
      await expect(cancellations.getByAuctionId(auctionId)).resolves.toMatchObject({
        inventoryReleaseStatus: AuctionCancellationEffectStatus.Pending,
      })
    })
  })

  describe('settlement', () => {
    it('una cancelacion automatica con pujas no captura la reserva ni elige ganador', async () => {
      const { auctions, useCase, wallet, inventory, clock } = await setup()
      await placeBid(auctions, 1)
      await placeBid(auctions, 2)
      await useCase.execute({ auctionId, sanctionId })

      const settlements = new InMemoryAuctionSettlementRepository()
      const pendingClaims = new InMemoryAuctionPendingClaimRepository()
      const settle = new SettleAuction(
        auctions,
        settlements,
        clock,
        wallet,
        new ClassifyAuctionLoserCredits(new InMemoryBidCreditOperationReader()),
        new PrepareAuctionLoserReleaseTasks(settlements),
        inventory,
        new InMemoryAuctionInventorySettlementIntentRepository(),
        pendingClaims,
      )
      clock.current = new Date(publishedAt.getTime() + 48 * 60 * 60 * 1000)

      await expect(settle.execute({ auctionId })).rejects.toThrow('El cierre durable no existe.')

      expect(wallet.captureCalls).toEqual([])
      await expect(settlements.getByAuctionId(auctionId)).resolves.toBeNull()
      const aggregate = await auctions.findAuctionAggregate(auctionId)
      expect(aggregate?.status).toBe(AuctionStatus.Cancelled)
      expect(aggregate?.closingResult).toBeNull()
    })
  })
})
