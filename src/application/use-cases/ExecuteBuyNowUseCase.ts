import type {
  BuyNowTransactionConfirmation,
  TransactionProcessingService,
} from '../services/TransactionProcessingService'
import type { EarlyClosureNotificationService } from '../services/EarlyClosureNotificationService'
import type { BuyNowPendingClaimRegistrationService } from '../services/BuyNowPendingClaimRegistrationService'
import type { BuyNowDomainService } from '../../domain/services/BuyNowDomainService'
import { AuctionNotFoundError } from '../errors/BuyNowRequestError'
import type { AuctionRepositoryPort, BuyNowOperationRecord } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { WalletPort } from '../ports/WalletPort'

export interface ExecuteBuyNowCommand {
  readonly operationId: string
  readonly buyerId: string
  readonly auctionId: string
  /** Casilla "Confirmo la compra inmediata" (CA-04). */
  readonly confirmed: boolean
}

/**
 * ExecuteBuyNowUseCase (HU-64.4).
 *
 * Orquesta lo que HU-64.2 y HU-64.3 ya resuelven por separado, y es lo unico
 * que el endpoint necesita conocer: busca la subasta y el saldo del
 * comprador, deja que `BuyNowDomainService` decida si la compra procede
 * (CA-02, CA-03, CA-04) y, solo si aprueba, entrega la aprobacion a
 * `TransactionProcessingService` para que la ejecute.
 *
 * Al completar la transaccion invoca `EarlyClosureNotificationService`
 * (HU-64.5): esa Task declara explicitamente esta dependencia -"necesita ser
 * invocado al completar la transaccion para liberar creditos"-, y es este
 * caso de uso, no `TransactionProcessingService`, quien conoce el momento
 * exacto en que la compra ya se completo de verdad.
 *
 * Por el mismo motivo invoca `BuyNowPendingClaimRegistrationService`
 * (CA-01): el producto comprado debe quedar "pendiente de recoger" del
 * comprador, igual que ya ocurre en el cierre por vencimiento (HU-65.3).
 */
export class ExecuteBuyNowUseCase {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly wallet: WalletPort,
    private readonly domainService: BuyNowDomainService,
    private readonly transactions: TransactionProcessingService,
    private readonly earlyClosure: EarlyClosureNotificationService,
    private readonly pendingClaimRegistration: BuyNowPendingClaimRegistrationService,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: ExecuteBuyNowCommand): Promise<BuyNowTransactionConfirmation> {
    // Un reintento con el mismo `operationId` puede llegar DESPUES de que la
    // subasta ya cerro -la propia respuesta anterior pudo perderse en la red-.
    // Si se evaluara el dominio contra el estado ACTUAL, "subasta activa"
    // rechazaria una compra que en realidad ya se completo. Por eso la
    // idempotencia se resuelve ANTES de tocar el dominio, con lo que ya quedo
    // persistido (HU-64.3), nunca reevaluando reglas de negocio.
    const existing = await this.repository.findBuyNowOperation(command.operationId)

    if (existing !== null) {
      const confirmation = ExecuteBuyNowUseCase.toReplayedConfirmation(existing)

      // Reintentar tambien reintenta avisar del cierre y registrar el
      // pendiente de recoger: si el primer intento no llego a completarlos
      // -el proceso murio justo despues de pagar-, este es el unico momento
      // en que algo los vuelve a disparar.
      await this.notifyEarlyClosure(confirmation)
      await this.registerPendingClaim(confirmation)

      return confirmation
    }

    const auction = await this.repository.findById(command.auctionId)

    if (auction === null) {
      throw new AuctionNotFoundError(command.auctionId)
    }

    const availableCredits = await this.wallet.getAvailableCredits(command.buyerId)

    const approval = this.domainService.evaluate({
      buyerId: command.buyerId,
      auction: {
        auctionId: auction.id,
        sellerId: auction.sellerId,
        productId: auction.productId,
        status: auction.status,
        buyNowCredits: auction.buyNowCredits,
      },
      confirmed: command.confirmed,
      buyerAvailableCredits: availableCredits,
      requestedAt: this.clock.now(),
    })

    const confirmation = await this.transactions.execute({
      operationId: command.operationId,
      approval,
    })

    await this.notifyEarlyClosure(confirmation)
    await this.registerPendingClaim(confirmation)

    return confirmation
  }

  /**
   * Best-effort: la compra YA se completo y el comprador YA pago. Un fallo al
   * liberar creditos o notificar a los demas participantes nunca debe
   * convertir esa compra, ya exitosa, en un error para quien la hizo -queda
   * registrado como `FAILED` y disponible para `retryFailed` (HU-64.5)-.
   */
  private async notifyEarlyClosure(confirmation: BuyNowTransactionConfirmation): Promise<void> {
    try {
      await this.earlyClosure.processClosure({
        auctionId: confirmation.auctionId,
        buyerId: confirmation.buyerId,
        transactionId: confirmation.transactionId,
        closedAt: confirmation.closedAt,
      })
    } catch {
      // Intencionalmente ignorado; ver el comentario de arriba.
    }
  }

  /**
   * Best-effort, igual que `notifyEarlyClosure`: la compra YA se completo y
   * el comprador YA pago. Un fallo al confirmar el inventario nunca debe
   * convertir esa compra en un error para quien la hizo -el intento queda
   * RETRYABLE/TERMINAL_ERROR y se reintenta solo en el proximo reintento con
   * el mismo `operationId` (ver el bloque `replayed` de arriba)-.
   */
  private async registerPendingClaim(confirmation: BuyNowTransactionConfirmation): Promise<void> {
    try {
      await this.pendingClaimRegistration.registerClaim({
        auctionId: confirmation.auctionId,
        sellerId: confirmation.sellerId,
        productId: confirmation.productId,
        winnerId: confirmation.buyerId,
        priceCredits: confirmation.debitedCredits,
        closedAt: confirmation.closedAt,
      })
    } catch {
      // Intencionalmente ignorado; ver el comentario de arriba.
    }
  }

  private static toReplayedConfirmation(
    existing: BuyNowOperationRecord,
  ): BuyNowTransactionConfirmation {
    return {
      transactionId: existing.transactionId,
      auctionId: existing.auction.id,
      buyerId: existing.buyerId,
      sellerId: existing.auction.sellerId,
      productId: existing.auction.productId,
      debitedCredits: existing.priceCredits,
      remainingCredits: existing.remainingCredits,
      closedAt: existing.auction.closesAt,
      replayed: true,
    }
  }
}
