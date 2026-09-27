import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryEarlyClosureNotificationRepository } from '../../src/adapters/outbound/persistence/InMemoryEarlyClosureNotificationRepository'
import { InMemoryAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { InsufficientPublicationFundsError } from '../../src/application/errors/AuctionPersistenceError'
import { AuctionNotFoundError } from '../../src/application/errors/BuyNowRequestError'
import { AuctionAlreadyClosedError } from '../../src/application/errors/BuyNowTransactionError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
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
import { BuyNowRuleCode } from '../../src/domain/errors/BuyNowRuleViolation'
import { InsufficientCreditsViolation } from '../../src/domain/errors/BuyNowRuleViolation'
import { BuyNowDomainService } from '../../src/domain/services/BuyNowDomainService'
import { FakeProductInventory } from '../support/fake-product-inventory'

/** Ningun escenario de esta suite coloca pujas: nada que liberar ni notificar. */
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

/**
 * Aceptacion end-to-end de HU-64 (Task #350): a diferencia de
 * `test/unit/execute-buy-now.spec.ts`, aqui NADA del flujo de aplicacion se
 * sustituye por un doble de `ExecuteBuyNowUseCase` -solo Wallet, la unica
 * dependencia externa real, se dobla-, exactamente lo que un cliente HTTP
 * pondria en marcha con `POST /v1/auctions/{auctionId}/buy-now`.
 *
 * Los importes replican las tarjetas de Figma de HU-64 (Espada Legendaria
 * Nexus a 2.500 creditos, Escudo Antiguo a 3.000) para que la evidencia de
 * esta prueba se lea junto al diseño.
 */

const PUBLISHED_AT = new Date('2026-09-20T12:00:00.000Z')
const NOW = new Date('2026-09-21T15:00:00.000Z')

class StatefulWallet implements WalletPort {
  balances = new Map<string, number>()
  readonly transfers = new Map<string, { transferId: string; reversed: boolean }>()
  failNextTransfer: Error | null = null
  failNextBalanceLookup: Error | null = null
  private sequence = 0

  getAvailableCredits(buyerId: string): Promise<number> {
    if (this.failNextBalanceLookup !== null) {
      const error = this.failNextBalanceLookup
      this.failNextBalanceLookup = null
      return Promise.reject(error)
    }
    return Promise.resolve(this.balances.get(buyerId) ?? 0)
  }

  transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer> {
    if (this.failNextTransfer !== null) {
      const error = this.failNextTransfer
      this.failNextTransfer = null
      return Promise.reject(error)
    }

    const previous = this.transfers.get(command.operationId)
    if (previous !== undefined) {
      return Promise.resolve({ transferId: previous.transferId })
    }

    const transferId = `transfer-${String(++this.sequence)}`
    this.transfers.set(command.operationId, { transferId, reversed: false })
    return Promise.resolve({ transferId })
  }

  reverseBuyNowCredits(operationId: string, transferId: string): Promise<void> {
    const transfer = this.transfers.get(operationId)
    if (transfer?.transferId === transferId) {
      transfer.reversed = true
    }
    return Promise.resolve()
  }
}

const seedAuction = async (
  repository: AuctionRepositoryPort,
  input: {
    auctionId: string
    sellerId: string
    buyNowCredits: number | null
    minimumBidCredits?: number
  },
): Promise<void> => {
  const auction = Auction.publish({
    auctionId: input.auctionId,
    sellerId: input.sellerId,
    productId: `product-${input.auctionId}`,
    durationHours: 24,
    minimumBidCredits: input.minimumBidCredits ?? 10,
    buyNowCredits: input.buyNowCredits,
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
    operationId: `publish-${input.auctionId}`,
    auction,
    inventoryCommitmentId: `commitment-${input.auctionId}`,
    feeChargeId: `fee-${input.auctionId}`,
  })
}

const fixture = () => {
  const repository = new InMemoryAuctionRepository()
  const wallet = new StatefulWallet()
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
  const pendingClaims = new InMemoryAuctionPendingClaimRepository()
  const pendingClaimRegistration = new BuyNowPendingClaimRegistrationService(
    repository,
    inventory,
    new InMemoryAuctionInventorySettlementIntentRepository(),
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

  return { repository, wallet, pendingClaims, useCase }
}

const command = (
  auctionId: string,
  overrides: Partial<ExecuteBuyNowCommand> = {},
): ExecuteBuyNowCommand => ({
  operationId: `operation-${auctionId}`,
  buyerId: 'jugador-comprador',
  auctionId,
  confirmed: true,
  ...overrides,
})

describe('HU-64 - aceptacion de compra inmediata (Task #350)', () => {
  describe('CA-01: flujo principal - compra ejecutada y subasta cerrada', () => {
    it('debita al comprador, cierra la subasta y confirma la transaccion', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'espada-legendaria',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('jugador-comprador', 5000)

      const confirmation = await useCase.execute(command('espada-legendaria'))

      expect(confirmation).toMatchObject({
        auctionId: 'espada-legendaria',
        sellerId: 'vendedor-1',
        buyerId: 'jugador-comprador',
        debitedCredits: 2500,
        remainingCredits: 2500,
        replayed: false,
      })
      expect(confirmation.transactionId).toEqual(expect.stringMatching(/^txn-/))

      await expect(repository.findById('espada-legendaria')).resolves.toMatchObject({
        status: 'SOLD',
      })

      const transfer = wallet.transfers.get('operation-espada-legendaria')
      expect(transfer).toMatchObject({ reversed: false })
    })
  })

  describe('CA-02: recursos insuficientes - el sistema rechaza la compra', () => {
    it('rechaza con el detalle exacto de cuanto falta y no cierra la subasta', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'escudo-antiguo',
        sellerId: 'vendedor-1',
        buyNowCredits: 3000,
      })
      wallet.balances.set('jugador-comprador', 2500)

      await expect(useCase.execute(command('escudo-antiguo'))).rejects.toBeInstanceOf(
        InsufficientCreditsViolation,
      )

      await expect(useCase.execute(command('escudo-antiguo'))).rejects.toMatchObject({
        code: BuyNowRuleCode.InsufficientCredits,
        details: { requiredCredits: 3000, availableCredits: 2500, missingCredits: 500 },
      })

      await expect(repository.findById('escudo-antiguo')).resolves.toMatchObject({
        status: 'ACTIVE',
      })
      expect(wallet.transfers.size).toBe(0)
    })
  })

  describe('CA-03: sin precio de compra inmediata - la opcion no esta disponible', () => {
    it('rechaza la compra sin transferir creditos ni tocar la subasta', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'escudo-solo-subasta',
        sellerId: 'vendedor-1',
        buyNowCredits: null,
      })
      wallet.balances.set('jugador-comprador', 5000)

      await expect(useCase.execute(command('escudo-solo-subasta'))).rejects.toMatchObject({
        code: BuyNowRuleCode.BuyNowPriceUnavailable,
      })

      await expect(repository.findById('escudo-solo-subasta')).resolves.toMatchObject({
        status: 'ACTIVE',
      })
      expect(wallet.transfers.size).toBe(0)
    })
  })

  describe('CA-04: sin confirmacion - la transaccion no se ejecuta y la subasta sigue activa', () => {
    it('rechaza la compra cuando la casilla no llega marcada', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'espada-sin-confirmar',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('jugador-comprador', 5000)

      await expect(
        useCase.execute(command('espada-sin-confirmar', { confirmed: false })),
      ).rejects.toMatchObject({ code: BuyNowRuleCode.ConfirmationRequired })

      await expect(repository.findById('espada-sin-confirmar')).resolves.toMatchObject({
        status: 'ACTIVE',
      })
      expect(wallet.transfers.size).toBe(0)
    })
  })

  describe('Excepciones de red', () => {
    it('una falla de red al consultar el saldo no cierra la subasta ni transfiere nada', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'auction-red-saldo',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.failNextBalanceLookup = new ExternalDependencyUnavailableError('wallet')

      await expect(useCase.execute(command('auction-red-saldo'))).rejects.toBeInstanceOf(
        ExternalDependencyUnavailableError,
      )

      await expect(repository.findById('auction-red-saldo')).resolves.toMatchObject({
        status: 'ACTIVE',
      })
      expect(wallet.transfers.size).toBe(0)
    })

    it('una falla de red durante la transferencia se propaga sin dejar la subasta cerrada', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'auction-red-transferencia',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('jugador-comprador', 5000)
      wallet.failNextTransfer = new ExternalDependencyUnavailableError('wallet')

      await expect(useCase.execute(command('auction-red-transferencia'))).rejects.toBeInstanceOf(
        ExternalDependencyUnavailableError,
      )

      await expect(repository.findById('auction-red-transferencia')).resolves.toMatchObject({
        status: 'ACTIVE',
      })
    })
  })

  describe('Excepciones de base de datos y rollback', () => {
    it('si el cierre falla tras transferir, revierte la transferencia y audita el fallo', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'auction-fallo-cierre',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('jugador-comprador', 5000)

      const originalCloseByBuyNow = repository.closeByBuyNow.bind(repository)
      let calls = 0
      repository.closeByBuyNow = (closeCommand) => {
        calls += 1
        if (calls === 1) {
          return Promise.reject(new Error('conexion a la base de datos perdida'))
        }
        return originalCloseByBuyNow(closeCommand)
      }

      await expect(useCase.execute(command('auction-fallo-cierre'))).rejects.toThrow(
        'conexion a la base de datos perdida',
      )

      const transfer = wallet.transfers.get('operation-auction-fallo-cierre')
      expect(transfer?.reversed).toBe(true)

      await expect(repository.findById('auction-fallo-cierre')).resolves.toMatchObject({
        status: 'ACTIVE',
      })

      const failures = (
        repository as unknown as {
          buyNowFailures: Map<string, { stage: string; reason: string; creditsReversed: boolean }>
        }
      ).buyNowFailures

      expect(failures.get('operation-auction-fallo-cierre')).toMatchObject({
        stage: 'CLOSING_AUCTION',
        reason: expect.stringContaining('conexion a la base de datos perdida'),
        creditsReversed: true,
      })
    })

    it('un auctionId inexistente se rechaza con 404 sin tocar Wallet', async () => {
      const { wallet, useCase } = fixture()

      await expect(useCase.execute(command('no-existe'))).rejects.toBeInstanceOf(
        AuctionNotFoundError,
      )
      expect(wallet.transfers.size).toBe(0)
    })
  })

  describe('Timeout y reintentos (idempotencia)', () => {
    it('un reintento con el mismo Idempotency-Key tras una respuesta perdida no vuelve a debitar', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'auction-timeout-reintento',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('jugador-comprador', 5000)

      const first = await useCase.execute(command('auction-timeout-reintento'))

      // El cliente reintenta porque la respuesta de la primera compra se perdio
      // en la red -no porque la compra fallara-, con el MISMO Idempotency-Key.
      const retry = await useCase.execute(command('auction-timeout-reintento'))

      expect(retry).toEqual({ ...first, replayed: true })
      expect(wallet.transfers.size).toBe(1)
    })

    it('un reintento con el mismo Idempotency-Key funciona incluso si otra compra cerro la subasta', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'auction-timeout-tras-cierre',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('jugador-comprador', 5000)
      wallet.balances.set('otro-comprador', 5000)

      const first = await useCase.execute(command('auction-timeout-tras-cierre'))

      // Alguien mas, con OTRA operacion, intenta comprar la subasta ya vendida:
      // el dominio la rechaza porque ya no esta activa (no es una carrera, es
      // secuencial).
      await expect(
        useCase.execute(
          command('auction-timeout-tras-cierre', {
            operationId: 'operation-otra-compra',
            buyerId: 'otro-comprador',
          }),
        ),
      ).rejects.toMatchObject({ code: BuyNowRuleCode.AuctionNotActive })

      // El reintento del comprador ORIGINAL, con su MISMO Idempotency-Key,
      // sigue reproduciendo su propia confirmacion.
      const retry = await useCase.execute(command('auction-timeout-tras-cierre'))

      expect(retry).toEqual({ ...first, replayed: true })
    })
  })

  describe('Concurrencia (vease tambien test/db para 10+ compras reales)', () => {
    it('dos compras concurrentes por la misma subasta dejan una sola ganadora y revierte a la otra', async () => {
      const { repository, wallet, useCase } = fixture()
      await seedAuction(repository, {
        auctionId: 'auction-carrera',
        sellerId: 'vendedor-1',
        buyNowCredits: 2500,
      })
      wallet.balances.set('comprador-a', 5000)
      wallet.balances.set('comprador-b', 5000)

      const outcomes = await Promise.allSettled([
        useCase.execute(
          command('auction-carrera', { operationId: 'operation-a', buyerId: 'comprador-a' }),
        ),
        useCase.execute(
          command('auction-carrera', { operationId: 'operation-b', buyerId: 'comprador-b' }),
        ),
      ])

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      )

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(AuctionAlreadyClosedError)

      const transfers = [...wallet.transfers.entries()]
      const reversedCount = transfers.filter(([, value]) => value.reversed).length

      expect(transfers).toHaveLength(2)
      expect(reversedCount).toBe(1)
    })
  })

  describe('Regresion: no confunde errores de otras dependencias', () => {
    it('un InsufficientPublicationFundsError de otro flujo no se confunde con CA-02', () => {
      // Documenta el limite del alcance: HU-64 tiene su PROPIO error de saldo
      // insuficiente (InsufficientCreditsViolation), distinto del que usa
      // HU-62 para la cuota de publicacion.
      const error = new InsufficientPublicationFundsError()
      expect(error).not.toBeInstanceOf(InsufficientCreditsViolation)
    })
  })
})
