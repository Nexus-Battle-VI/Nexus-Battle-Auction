import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import { InMemoryEarlyClosureNotificationRepository } from '../../src/adapters/outbound/persistence/InMemoryEarlyClosureNotificationRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { AuctionAlreadyClosedError } from '../../src/application/errors/BuyNowTransactionError'
import { BuyNowRuleCode, BuyNowRuleViolation } from '../../src/domain/errors/BuyNowRuleViolation'
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
import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  ExecuteBuyNowUseCase,
  type ExecuteBuyNowCommand,
} from '../../src/application/use-cases/ExecuteBuyNowUseCase'
import { Auction } from '../../src/domain/entities/Auction'
import { BuyNowDomainService } from '../../src/domain/services/BuyNowDomainService'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * Concurrencia de compra inmediata HU-64 (Task #350): "10+ compras
 * simultaneas" contra PostgreSQL real, no un doble. Va en su propio archivo
 * -y su propio contenedor- porque es la unica prueba de la suite que necesita
 * doce conexiones reales del pool operando a la vez.
 */
class StatefulWallet implements WalletPort {
  readonly transfers = new Map<string, { transferId: string; reversed: boolean }>()
  private sequence = 0

  getAvailableCredits(): Promise<number> {
    return Promise.resolve(10_000)
  }

  transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer> {
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

/** Ninguno de los 12 compradores tiene una puja previa: nada que liberar ni notificar. */
class UnreachableBidCredits implements BidCreditsPort {
  getAvailableCredits(bidderId: string): Promise<BidCreditBalance> {
    void bidderId
    return Promise.reject(new Error('no deberia consultarse en esta prueba'))
  }

  reserve(command: ReserveBidCreditsCommand): Promise<BidCreditReservation> {
    void command
    return Promise.reject(new Error('no deberia reservarse en esta prueba'))
  }

  release(operationId: string, reservationId: string): Promise<void> {
    void operationId
    void reservationId
    return Promise.reject(new Error('no deberia liberarse en esta prueba'))
  }
}

class UnreachableNotification implements NotificationPort {
  notifyAuctionClosedEarly(
    command: NotifyAuctionClosedEarlyCommand,
  ): Promise<NotificationDispatch> {
    void command
    return Promise.reject(new Error('no deberia notificarse en esta prueba'))
  }
}

describe('HU-64 - concurrencia de compra inmediata contra PostgreSQL real', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    // El pool por defecto (5) se agotaria con 12 transacciones concurrentes,
    // cada una reteniendo su conexion mientras espera el bloqueo consultivo de
    // otra: no es la contencion que esta prueba quiere demostrar.
    db = createDatabase({
      connectionString: container.getConnectionUri(),
      maxConnections: 20,
    })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw new Error(`Fallo la migracion: ${describeError(outcome.error)}`)
    }
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('12 compras simultaneas por la misma subasta dejan exactamente una ganadora', async () => {
    const repository = new PostgresAuctionRepository(db)
    const wallet = new StatefulWallet()
    const clock = { now: () => new Date('2026-09-21T15:00:00.000Z') }
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
    const useCase = new ExecuteBuyNowUseCase(
      repository,
      wallet,
      domainService,
      transactions,
      earlyClosure,
      clock,
    )

    const auction = Auction.publish({
      auctionId: 'auction-concurrencia-12',
      sellerId: 'vendedor-1',
      productId: 'product-concurrencia-12',
      durationHours: 24,
      minimumBidCredits: 10,
      buyNowCredits: 2500,
      publishedAt: new Date('2026-09-20T12:00:00.000Z'),
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })

    await repository.publish({
      operationId: 'publish-auction-concurrencia-12',
      auction,
      inventoryCommitmentId: 'commitment-1',
      feeChargeId: 'fee-1',
    })

    const BUYER_COUNT = 12

    const attempts: ExecuteBuyNowCommand[] = Array.from({ length: BUYER_COUNT }, (_, index) => ({
      operationId: `operation-concurrente-${String(index)}`,
      buyerId: `comprador-${String(index)}`,
      auctionId: 'auction-concurrencia-12',
      confirmed: true,
    }))

    const outcomes = await Promise.allSettled(attempts.map((command) => useCase.execute(command)))

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(BUYER_COUNT - 1)

    /*
     * Los 11 perdedores caen en uno de dos puntos, segun cuando su propia
     * lectura de la subasta ocurrio respecto al cierre real -once conexiones
     * de red reales no llegan agrupadas como en una prueba en memoria-:
     *
     * - Quien leyo la subasta todavia ACTIVA entra a `closeByBuyNow` y pierde
     *   AHI la carrera: `AuctionAlreadyClosedError`. Solo estos llegaron a
     *   transferir creditos, y esos SI deben quedar revertidos.
     * - Quien la leyo DESPUES de que ya se vendio nunca llega a transferir
     *   nada: el propio dominio lo rechaza antes (`AuctionNotActive`).
     *
     * Ambos son resultados correctos y seguros -nadie mas que el ganador paga,
     * la subasta se vende una unica vez-, y una prueba de concurrencia real
     * contra Postgres, sin forzar el entrelazado, debe aceptar los dos.
     */
    const raceLosers = rejected.filter(({ reason }) => reason instanceof AuctionAlreadyClosedError)
    const domainRejections = rejected.filter(
      ({ reason }) =>
        reason instanceof BuyNowRuleViolation && reason.code === BuyNowRuleCode.AuctionNotActive,
    )

    expect(raceLosers.length + domainRejections.length).toBe(BUYER_COUNT - 1)

    await expect(repository.findById('auction-concurrencia-12')).resolves.toMatchObject({
      status: 'SOLD',
    })

    const rows = await db
      .selectFrom('auction_buy_now_operations')
      .selectAll()
      .where('auction_id', '=', 'auction-concurrencia-12')
      .execute()

    // La subasta se vendio exactamente una vez, sin importar cuantos lo
    // intentaron a la vez.
    expect(rows).toHaveLength(1)

    // Solo transfieren creditos quien paso la validacion de dominio: el
    // ganador y quienes perdieron LA CARRERA en `closeByBuyNow`. Todos estos
    // ultimos quedan revertidos; el ganador no.
    expect(wallet.transfers.size).toBe(1 + raceLosers.length)

    const reversed = [...wallet.transfers.values()].filter((transfer) => transfer.reversed)

    expect(reversed).toHaveLength(raceLosers.length)
  }, 60_000)
})
