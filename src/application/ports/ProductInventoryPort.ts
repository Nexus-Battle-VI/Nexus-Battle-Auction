export interface InventoryProductEligibility {
  readonly ownedByPlayer: boolean
  readonly inUse: boolean
}

export interface CommitInventoryProductCommand {
  readonly operationId: string
  readonly ownerId: string
  readonly productId: string
  readonly expiresAt: Date
}

export interface InventoryProductCommitment {
  readonly commitmentId: string
}

export interface ProductInventoryPort {
  inspect(ownerId: string, productId: string): Promise<InventoryProductEligibility>
  commit(command: CommitInventoryProductCommand): Promise<InventoryProductCommitment>
  release(operationId: string, commitmentId: string): Promise<void>
}

export const PRODUCT_INVENTORY = Symbol('ProductInventoryPort')
