import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../errors/ExternalDependencyError'
import type {
  AuctionInventorySettlementIntentRepositoryPort,
  AuctionInventorySettlementIntentSnapshot,
} from '../ports/AuctionInventorySettlementIntentRepositoryPort'
import type { AuctionPendingClaimRepositoryPort } from '../ports/AuctionPendingClaimRepositoryPort'
import { inventoryPendingClaimOperationId } from '../ports/ProductInventoryPort'
import type { ProductInventoryPort } from '../ports/ProductInventoryPort'

export interface RegisterBuyNowPendingClaimCommand {
  readonly auctionId: string
  readonly sellerId: string
  readonly productId: string
  readonly winnerId: string
  readonly priceCredits: number
  readonly closedAt: Date
}

/**
 * BuyNowPendingClaimRegistrationService (HU-64.3, CA-01).
 *
 * Registra el producto comprado con "Comprar ahora" como pendiente de
 * recoger del comprador, reutilizando el mismo mecanismo que `SettleAuction`
 * (HU-65.3) usa para el cierre por vencimiento: un intento de liquidacion de
 * inventario idempotente, confirmacion real contra Inventario y solo
 * entonces el registro de reclamo. Una compra inmediata no tiene puja
 * ganadora, asi que `winningBidId` usa un identificador sintetico derivado de
 * la propia subasta -unico y estable ante reintentos-.
 *
 * Se invoca desde `ExecuteBuyNowUseCase` DESPUES de que
 * `TransactionProcessingService` ya cerro la subasta y cobro los creditos: un
 * fallo aqui nunca debe deshacer una compra ya pagada. El intento de
 * inventario queda persistido como RETRYABLE o TERMINAL_ERROR y se reintenta
 * solo, de forma idempotente, en la proxima invocacion con el mismo
 * `auctionId`.
 */
export class BuyNowPendingClaimRegistrationService {
  constructor(
    private readonly auctions: AuctionRepositoryPort,
    private readonly inventory: ProductInventoryPort,
    private readonly inventoryIntents: AuctionInventorySettlementIntentRepositoryPort,
    private readonly pendingClaims: AuctionPendingClaimRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async registerClaim(command: RegisterBuyNowPendingClaimCommand): Promise<void> {
    const commitmentId = await this.auctions.findInventoryCommitmentId(command.auctionId)

    if (commitmentId === null) {
      throw new Error(`La subasta ${command.auctionId} no tiene un inventoryCommitmentId durable.`)
    }

    const intent = await this.inventoryIntents.getOrCreate({
      auctionId: command.auctionId,
      operationId: inventoryPendingClaimOperationId(command.auctionId),
      action: 'PENDING_CLAIM',
      commitmentId,
      sellerId: command.sellerId,
      productId: command.productId,
      winnerId: command.winnerId,
      createdAt: this.clock.now(),
    })

    const resolved = await this.resolveInventoryIntent(intent)

    if (resolved.status !== 'CONFIRMED') {
      return
    }

    await this.pendingClaims.createIfAbsent({
      auctionId: command.auctionId,
      winnerId: command.winnerId,
      productId: command.productId,
      winningBidId: `buy-now:${command.auctionId}`,
      finalAmountCredits: command.priceCredits,
      settledAt: command.closedAt,
      createdAt: command.closedAt,
    })
  }

  private async resolveInventoryIntent(
    intent: AuctionInventorySettlementIntentSnapshot,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    if (intent.status === 'CONFIRMED' || intent.status === 'TERMINAL_ERROR') {
      return intent
    }

    if (intent.winnerId === null) {
      throw new Error('El intent PENDING_CLAIM no tiene winnerId.')
    }

    try {
      await this.inventory.markPendingClaim({
        operationId: intent.operationId,
        commitmentId: intent.commitmentId,
        auctionId: intent.auctionId,
        sellerId: intent.sellerId,
        winnerId: intent.winnerId,
        productId: intent.productId,
      })

      return await this.inventoryIntents.markConfirmed(intent.auctionId, this.clock.now())
    } catch (error) {
      if (error instanceof ExternalDependencyUnavailableError) {
        return this.inventoryIntents.markRetryable(
          intent.auctionId,
          error.message,
          this.clock.now(),
        )
      }

      if (
        error instanceof ExternalContractError ||
        error instanceof ExternalResourceNotFoundError
      ) {
        return this.inventoryIntents.markTerminalError(
          intent.auctionId,
          error.message,
          this.clock.now(),
        )
      }

      throw error
    }
  }
}
