export interface InventoryProductEligibility {
  readonly ownedByPlayer: boolean
  readonly inUse: boolean
}

export interface CommitInventoryProductCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly ownerId: string
  readonly productId: string
  readonly expiresAt: Date
}

export interface ReleaseInventoryProductCommand {
  readonly operationId: string
  readonly commitmentId: string
  readonly auctionId: string
  readonly ownerId: string
  readonly productId: string
  readonly reason: 'AUCTION_WITHOUT_BIDS'
}

export interface MarkInventoryProductPendingClaimCommand {
  readonly operationId: string
  readonly commitmentId: string
  readonly auctionId: string
  readonly sellerId: string
  readonly winnerId: string
  readonly productId: string
}

export interface ConfirmInventoryProductClaimCommand {
  readonly operationId: string
  readonly commitmentId: string
  readonly auctionId: string
  readonly winnerId: string
  readonly productId: string
}

export interface InventoryProductCommitment {
  readonly operationId: string
  readonly commitmentId: string
  readonly status: 'ACTIVE'
  readonly applied: boolean
}

export interface ReleasedInventoryProductCommitment {
  readonly operationId: string
  readonly commitmentId: string
  readonly status: 'RELEASED'
  readonly applied: boolean
}

export interface PendingClaimInventoryProductCommitment {
  readonly operationId: string
  readonly commitmentId: string
  readonly status: 'PENDING_CLAIM'
  readonly winnerId: string
  readonly applied: boolean
}

export interface ClaimedInventoryProductCommitment {
  readonly operationId: string
  readonly commitmentId: string
  readonly status: 'CLAIMED'
  readonly winnerId: string
  readonly applied: boolean
}

export interface ProductInventoryPort {
  inspect(ownerId: string, productId: string): Promise<InventoryProductEligibility>
  commit(command: CommitInventoryProductCommand): Promise<InventoryProductCommitment>
  release(command: ReleaseInventoryProductCommand): Promise<ReleasedInventoryProductCommitment>
  markPendingClaim(
    command: MarkInventoryProductPendingClaimCommand,
  ): Promise<PendingClaimInventoryProductCommitment>
  /** HU-69.3: entrega definitiva del producto al ganador tras el reclamo. */
  confirmClaim(
    command: ConfirmInventoryProductClaimCommand,
  ): Promise<ClaimedInventoryProductCommitment>
}

export const inventoryCommitOperationId = (auctionId: string): string =>
  `auction:${auctionId}:inventory:commit`

export const inventoryReleaseOperationId = (auctionId: string): string =>
  `auction:${auctionId}:inventory:release`

export const inventoryPendingClaimOperationId = (auctionId: string): string =>
  `auction:${auctionId}:inventory:pending-claim`

export const inventoryClaimOperationId = (auctionId: string): string =>
  `auction:${auctionId}:inventory:claim`

export const PRODUCT_INVENTORY = Symbol('ProductInventoryPort')
