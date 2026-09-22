import type {
  BuyNowTransactionConfirmation,
  TransactionProcessingService,
} from '../services/TransactionProcessingService'
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
 */
export class ExecuteBuyNowUseCase {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly wallet: WalletPort,
    private readonly domainService: BuyNowDomainService,
    private readonly transactions: TransactionProcessingService,
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
      return ExecuteBuyNowUseCase.toReplayedConfirmation(existing)
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

    return this.transactions.execute({ operationId: command.operationId, approval })
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
