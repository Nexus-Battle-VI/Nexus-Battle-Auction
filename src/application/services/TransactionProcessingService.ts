import type { AuctionSnapshot } from '../../domain/entities/Auction'
import type { BuyNowApproval } from '../../domain/services/BuyNowDomainService'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdentifierGeneratorPort } from '../ports/IdentifierGeneratorPort'
import type { WalletPort } from '../ports/WalletPort'

export interface ProcessBuyNowTransactionCommand {
  readonly operationId: string
  readonly approval: BuyNowApproval
}

export interface BuyNowTransactionConfirmation {
  readonly transactionId: string
  readonly auctionId: string
  readonly buyerId: string
  readonly sellerId: string
  readonly productId: string
  readonly debitedCredits: number
  readonly remainingCredits: number
  readonly closedAt: Date
  readonly replayed: boolean
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/**
 * TransactionProcessingService (HU-64.3).
 *
 * Ejecuta la parte irreversible de la compra inmediata una vez que
 * `BuyNowDomainService` ya la aprobo (HU-64.2): transfiere los creditos en
 * Wallet y cierra la subasta. Garantiza todo-o-nada: si el cierre falla
 * despues de transferir los creditos -incluida una subasta que otra compra ya
 * cerro primero-, revierte la transferencia antes de propagar el error, y dejar
 * datos inconsistentes nunca es una opcion silenciosa.
 *
 * Fuera de alcance, explicitamente: notificar a otros participantes y liberar
 * los creditos reservados de sus pujas perdedoras (HU-64.5); esas subastas se
 * enteran del cierre por el evento que `closeByBuyNow` deja en el outbox.
 */
export class TransactionProcessingService {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly wallet: WalletPort,
    private readonly clock: ClockPort,
    private readonly identifiers: IdentifierGeneratorPort,
  ) {}

  async execute(command: ProcessBuyNowTransactionCommand): Promise<BuyNowTransactionConfirmation> {
    const { approval } = command
    const closedAt = this.clock.now()
    const transactionId = this.identifiers.generate()

    let transferId: string | null = null
    let stage = 'TRANSFERRING_CREDITS'

    try {
      transferId = (
        await this.wallet.transferBuyNowCredits({
          operationId: command.operationId,
          buyerId: approval.buyerId,
          sellerId: approval.sellerId,
          amount: approval.priceCredits,
        })
      ).transferId

      stage = 'CLOSING_AUCTION'

      const closed = await this.repository.closeByBuyNow({
        operationId: command.operationId,
        transactionId,
        auctionId: approval.auctionId,
        buyerId: approval.buyerId,
        transferId,
        priceCredits: approval.priceCredits,
        remainingCredits: approval.remainingCredits,
        closedAt,
      })

      return TransactionProcessingService.toConfirmation(approval, closed)
    } catch (error: unknown) {
      const creditsReversed = await TransactionProcessingService.reverse(this.wallet, {
        operationId: command.operationId,
        transferId,
      })

      await this.repository.recordBuyNowFailure({
        operationId: command.operationId,
        auctionId: approval.auctionId,
        buyerId: approval.buyerId,
        stage,
        reason: reasonOf(error),
        transferId,
        creditsReversed,
        occurredAt: closedAt,
      })

      throw error
    }
  }

  private static toConfirmation(
    approval: BuyNowApproval,
    closed: { auction: AuctionSnapshot; transactionId: string; replayed: boolean },
  ): BuyNowTransactionConfirmation {
    return {
      transactionId: closed.transactionId,
      auctionId: closed.auction.id,
      buyerId: approval.buyerId,
      sellerId: approval.sellerId,
      productId: closed.auction.productId,
      debitedCredits: approval.priceCredits,
      remainingCredits: approval.remainingCredits,
      closedAt: closed.auction.closesAt,
      replayed: closed.replayed,
    }
  }

  private static async reverse(
    wallet: WalletPort,
    input: { operationId: string; transferId: string | null },
  ): Promise<boolean> {
    if (input.transferId === null) {
      return true
    }

    try {
      await wallet.reverseBuyNowCredits(input.operationId, input.transferId)

      return true
    } catch {
      return false
    }
  }
}
