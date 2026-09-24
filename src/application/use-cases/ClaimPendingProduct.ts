import {
  AuctionPendingClaim,
  AuctionPendingClaimStatus,
} from '../../domain/entities/AuctionPendingClaim'
import {
  PendingClaimNotFoundError,
  PendingClaimOwnershipError,
} from '../errors/AuctionPendingClaimError'
import type {
  AuctionPendingClaimRepositoryPort,
  AuctionPendingClaimSnapshot,
} from '../ports/AuctionPendingClaimRepositoryPort'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import { inventoryClaimOperationId } from '../ports/ProductInventoryPort'
import type { ProductInventoryPort } from '../ports/ProductInventoryPort'

export interface ClaimPendingProductInput {
  readonly auctionId: string
  readonly winnerId: string
}

/**
 * Caso de uso funcional para HU-69.3.
 *
 * Solo transiciona a CLAIMED despues de que Player-Inventory confirma la
 * entrega: si Inventory falla, el reclamo permanece PENDING y un reintento
 * repite la misma llamada con el mismo operationId (ADR-019). No mueve
 * creditos: eso ya ocurrio durante la liquidacion (HU-65).
 *
 * Un reclamo repetido sobre un pending-claim ya CLAIMED es idempotente: se
 * devuelve el estado actual sin volver a invocar Inventory, en vez de fallar.
 */
export class ClaimPendingProduct {
  constructor(
    private readonly pendingClaims: AuctionPendingClaimRepositoryPort,
    private readonly auctions: AuctionRepositoryPort,
    private readonly inventory: ProductInventoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: ClaimPendingProductInput): Promise<AuctionPendingClaimSnapshot> {
    const claim = await this.pendingClaims.findByAuctionId(input.auctionId)
    if (claim === null) throw new PendingClaimNotFoundError(input.auctionId)
    if (claim.winnerId !== input.winnerId) throw new PendingClaimOwnershipError(input.auctionId)
    if (claim.claimStatus === AuctionPendingClaimStatus.Claimed) return claim

    const now = this.clock.now()
    // Valida estado PENDING y plazo vigente (dia 7 inclusive) con la misma
    // regla que HU-69.1/69.2. No persiste nada: solo lanza
    // AuctionPendingClaimRuleViolation si el reclamo ya no es valido.
    AuctionPendingClaim.restore(claim).claim(now)

    const commitmentId = await this.requireInventoryCommitmentId(input.auctionId)
    await this.inventory.confirmClaim({
      operationId: inventoryClaimOperationId(input.auctionId),
      commitmentId,
      auctionId: input.auctionId,
      winnerId: input.winnerId,
      productId: claim.productId,
    })

    return this.pendingClaims.markClaimed(input.auctionId, now)
  }

  private async requireInventoryCommitmentId(auctionId: string): Promise<string> {
    const commitmentId = await this.auctions.findInventoryCommitmentId(auctionId)
    if (commitmentId === null)
      throw new Error(`La subasta ${auctionId} no tiene un inventoryCommitmentId durable.`)
    return commitmentId
  }
}
