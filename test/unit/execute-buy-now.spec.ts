import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryEarlyClosureNotificationRepository } from '../../src/adapters/outbound/persistence/InMemoryEarlyClosureNotificationRepository'
import { InMemoryAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { AuctionNotFoundError } from '../../src/application/errors/BuyNowRequestError'
import {
  AuctionAlreadyClosedError,
  BuyNowIdempotencyConflictError,
} from '../../src/application/errors/BuyNowTransactionError'
import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import type {
  BidCreditBalance,
  BidCreditReservation,
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../src/application/ports/BidCreditsPort'
import type {
  NotificationDispatch,
  NotificationPort,
  NotifyAuctionClosedEarlyCommand,
} from '../../src/application/ports/NotificationPort'
import type {
  BuyNowCreditTransfer,
  BuyNowCreditTransferCommand,
  WalletPort,
} from '../../src/application/ports/WalletPort'
import { EarlyClosureNotificationService } from '../../src/application/services/EarlyClosureNotificationService'
import { TransactionProcessingService } from '../../src/application/services/TransactionProcessingService'
import { BuyNowPendingClaimRegistrationService } from '../../src/application/services/BuyNowPendingClaimRegistrationService'
import {
  ExecuteBuyNowUseCase,
  type ExecuteBuyNowCommand,
} from '../../src/application/use-cases/ExecuteBuyNowUseCase'
import { Auction } from '../../src/domain/entities/Auction'
import { BuyNowRuleCode, BuyNowRuleViolation } from '../../src/domain/errors/BuyNowRuleViolation'
import { BuyNowDomainService } from '../../src/domain/services/BuyNowDomainService'
import { FakeProductInventory } from '../support/fake-product-inventory'

/**
 * No hay pujas en ninguno de estos escenarios: `EarlyClosureNotificationService`
 * no tiene a nadie que liberar ni notificar, asi que estos dobles nunca se
 * invocan de verdad. Se dejan fail-closed por consistencia con produccion.
 */
class UnreachableBidCredits implements BidCreditsPort {
  getAvailableCredits(bidderId: string): Promise<BidCreditBalance> {
    void bidderId
    return Promise.reject(new Error('no deberia consultarse en estas pruebas'))
  }

  reserve(command: ReserveBidCreditsCommand): Promise<BidCreditReservation> {
    void command
    return Promise.reject(new Error('no deberia reservarse en estas pruebas'))
  }

  release(operationId: string, reservationId: string): Promise<void> {
    void operationId
    void reservationId
    return Promise.reject(new Error('no deberia liberarse en estas pruebas'))
  }
}

class UnreachableNotification implements NotificationPort {
  notifyAuctionClosedEarly(
    command: NotifyAuctionClosedEarlyCommand,
  ): Promise<NotificationDispatch> {
    void command
    return Promise.reject(new Error('no deberia notificarse en estas pruebas'))
  }
}

const PUBLISHED_AT = new Date('2026-09-20T12:00:00.000Z')
const NOW = new Date('2026-09-21T15:00:00.000Z')

class ConfigurableWallet implements WalletPort {
  balances = new Map<string, number>([
    ['buyer-1', 5000],
    ['buyer-2', 5000],
  ])
  private sequence = 0

  getAvailableCredits(buyerId: string): Promise<number> {
    return Promise.resolve(this.balances.get(buyerId) ?? 0)
  }

  transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer> {
    return Promise.resolve({
      transferId: `transfer-${String(++this.sequence)}-${command.operationId}`,
    })
  }

  reverseBuyNowCredits(): Promise<void> {
    return Promise.resolve()
  }
}

const seedActiveAuction = async (
  repository: AuctionRepositoryPort,
  overrides: {
    auctionId?: string
    sellerId?: string
    buyNowCredits?: number | null
  } = {},
): Promise<string> => {
  const auctionId = overrides.auctionId ?? 'auction-1'

  const auction = Auction.publish({
    auctionId,
    sellerId: overrides.sellerId ?? 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits: 10,
    buyNowCredits: overrides.buyNowCredits === undefined ? 2500 : overrides.buyNowCredits,
    publishedAt: PUBLISHED_AT,
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  })

  await repository.publish({
    operationId: `publish-${auctionId}`,
    auction,
    inventoryCommitmentId: 'commitment-1',
    feeChargeId: 'fee-1',
  })

  return auctionId
}

const fixture = () => {
  const repository = new InMemoryAuctionRepository()
  const wallet = new ConfigurableWallet()
  const clock = { now: () => new Date(NOW) }
  let sequence = 0
  const identifiers = { generate: () => `txn-${String(++sequence)}` }
  const domainService = new BuyNowDomainService()
  const transactions = new TransactionProcessingService(repository, wallet, clock, identifiers)
  const earlyClosure = new EarlyClosureNotificationService(
    repository,
    new InMemoryEarlyClosureNotificationRepository(),
    new UnreachableBidCredits(),
    new UnreachableNotification(),
    clock,
  )
  const inventory = new FakeProductInventory()
  const inventoryIntents = new InMemoryAuctionInventorySettlementIntentRepository()
  const pendingClaims = new InMemoryAuctionPendingClaimRepository()
  const pendingClaimRegistration = new BuyNowPendingClaimRegistrationService(
    repository,
    inventory,
    inventoryIntents,
    pendingClaims,
    clock,
  )
  const useCase = new ExecuteBuyNowUseCase(
    repository,
    wallet,
    domainService,
    transactions,
    earlyClosure,
    pendingClaimRegistration,
    clock,
  )

  return { repository, wallet, clock, inventory, pendingClaims, useCase }
}

const command = (
  auctionId: string,
  overrides: Partial<ExecuteBuyNowCommand> = {},
): ExecuteBuyNowCommand => ({
  operationId: 'operation-1',
  buyerId: 'buyer-1',
  auctionId,
  confirmed: true,
  ...overrides,
})

describe('ExecuteBuyNowUseCase HU-64.4', () => {
  it('CA-01: ejecuta la compra completa a partir del id de la subasta', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    const confirmation = await useCase.execute(command(auctionId))

    expect(confirmation).toMatchObject({
      auctionId,
      buyerId: 'buyer-1',
      sellerId: 'seller-1',
      debitedCredits: 2500,
      remainingCredits: 2500,
      replayed: false,
    })
  })

  it('CA-01: deja el producto pendiente de recoger del comprador', async () => {
    const { repository, pendingClaims, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    const confirmation = await useCase.execute(command(auctionId))

    await expect(pendingClaims.findByAuctionId(auctionId)).resolves.toMatchObject({
      auctionId,
      winnerId: 'buyer-1',
      productId: 'product-1',
      finalAmountCredits: 2500,
      claimStatus: 'PENDING',
    })

    await expect(pendingClaims.findPendingByWinnerId('buyer-1')).resolves.toEqual([
      expect.objectContaining({ auctionId, productId: 'product-1' }),
    ])

    void confirmation
  })

  it('reintenta el registro del pendiente de recoger cuando el primer intento fallo', async () => {
    const { repository, inventory, pendingClaims, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    inventory.markPendingClaim.mockImplementationOnce(() =>
      Promise.reject(new Error('Inventario no disponible, simulado en el test.')),
    )

    await useCase.execute(command(auctionId))
    await expect(pendingClaims.findByAuctionId(auctionId)).resolves.toBeNull()

    // Mismo operationId: entra por la rama de reintento/replay, que vuelve a
    // intentar el registro del pendiente de reclamo (idempotente).
    await useCase.execute(command(auctionId))

    await expect(pendingClaims.findByAuctionId(auctionId)).resolves.toMatchObject({
      auctionId,
      winnerId: 'buyer-1',
    })
  })

  it('rechaza un auctionId que no existe', async () => {
    const { useCase } = fixture()

    await expect(useCase.execute(command('no-existe'))).rejects.toBeInstanceOf(AuctionNotFoundError)
  })

  it('CA-03: rechaza una subasta sin precio de compra inmediata', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository, { buyNowCredits: null })

    await expect(useCase.execute(command(auctionId))).rejects.toMatchObject({
      code: BuyNowRuleCode.BuyNowPriceUnavailable,
    })
  })

  it('CA-04: rechaza la compra sin la casilla de confirmacion marcada', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await expect(useCase.execute(command(auctionId, { confirmed: false }))).rejects.toMatchObject({
      code: BuyNowRuleCode.ConfirmationRequired,
    })
  })

  it('CA-02: rechaza la compra con saldo insuficiente y no transfiere nada', async () => {
    const { repository, wallet, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    wallet.balances.set('buyer-1', 1000)

    await expect(useCase.execute(command(auctionId))).rejects.toMatchObject({
      code: BuyNowRuleCode.InsufficientCredits,
      details: { requiredCredits: 2500, availableCredits: 1000, missingCredits: 1500 },
    })

    await expect(repository.findById(auctionId)).resolves.toMatchObject({ status: 'ACTIVE' })
  })

  it('rechaza que el vendedor compre su propia subasta', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await expect(
      useCase.execute(command(auctionId, { buyerId: 'seller-1' })),
    ).rejects.toMatchObject({ code: BuyNowRuleCode.SellerCannotBuyOwnAuction })
  })

  it('rechaza con una NUEVA operacion una subasta que ya fue vendida', async () => {
    // Distinto de la carrera que cubre HU-64.3 contra Postgres real (dos
    // operaciones que llegan a la vez a `closeByBuyNow`): aqui la segunda
    // solicitud es SECUENCIAL, con su propio `operationId`, y no encuentra
    // ningun registro previo que reproducir. El propio dominio la rechaza -la
    // subasta ya no esta activa- antes de acercarse siquiera a Wallet.
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await useCase.execute(command(auctionId))

    await expect(
      useCase.execute(command(auctionId, { operationId: 'operation-2', buyerId: 'buyer-2' })),
    ).rejects.toMatchObject({ code: BuyNowRuleCode.AuctionNotActive })
  })

  it('dos compras concurrentes por la misma subasta dejan una sola ganadora', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    const outcomes = await Promise.allSettled([
      useCase.execute(command(auctionId, { operationId: 'operation-race-1', buyerId: 'buyer-1' })),
      useCase.execute(command(auctionId, { operationId: 'operation-race-2', buyerId: 'buyer-2' })),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)

    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )

    expect(rejected?.reason).toBeInstanceOf(AuctionAlreadyClosedError)
  })

  it('es idempotente ante un reintento con el mismo operationId', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    const first = await useCase.execute(command(auctionId))
    const second = await useCase.execute(command(auctionId))

    expect(second).toEqual({ ...first, replayed: true })
  })

  /**
   * Sin esta comparacion, `findBuyNowOperation` devolveria la confirmacion de
   * la PRIMERA compra sin importar que la segunda solicitud sea de otra
   * subasta -un cliente que reusa la Idempotency-Key por error, o un ataque
   * que intenta apropiarse de la confirmacion de otra operacion-.
   */
  it('rechaza reutilizar el operationId para otra subasta', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)
    const otraSubasta = await seedActiveAuction(repository, { auctionId: 'auction-otra' })

    await useCase.execute(command(auctionId))

    await expect(
      useCase.execute(command(otraSubasta, { operationId: 'operation-1' })),
    ).rejects.toBeInstanceOf(BuyNowIdempotencyConflictError)
  })

  it('rechaza reutilizar el operationId para otro comprador', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await useCase.execute(command(auctionId))

    await expect(
      useCase.execute(command(auctionId, { operationId: 'operation-1', buyerId: 'buyer-2' })),
    ).rejects.toBeInstanceOf(BuyNowIdempotencyConflictError)
  })

  it('propaga un fallo de validacion de entrada como BuyNowRuleViolation', async () => {
    const { repository, useCase } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await expect(useCase.execute(command(auctionId, { buyerId: ' ' }))).rejects.toBeInstanceOf(
      BuyNowRuleViolation,
    )
  })
})
