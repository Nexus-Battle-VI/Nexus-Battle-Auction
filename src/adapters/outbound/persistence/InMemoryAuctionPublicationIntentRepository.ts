import type {
  AuctionPublicationIntentRepositoryPort,
  AuctionPublicationIntentSnapshot,
  CreateAuctionPublicationIntentInput,
} from '../../../application/ports/AuctionPublicationIntentRepositoryPort'

const clone = (intent: AuctionPublicationIntentSnapshot): AuctionPublicationIntentSnapshot => ({
  ...intent,
  closesAt: new Date(intent.closesAt),
  createdAt: new Date(intent.createdAt),
  updatedAt: new Date(intent.updatedAt),
})

export class InMemoryAuctionPublicationIntentRepository implements AuctionPublicationIntentRepositoryPort {
  private readonly intents = new Map<string, AuctionPublicationIntentSnapshot>()

  async getOrCreate(
    input: CreateAuctionPublicationIntentInput,
  ): Promise<AuctionPublicationIntentSnapshot> {
    await Promise.resolve()
    const existing = this.intents.get(input.operationId)
    if (existing !== undefined) {
      if (existing.sellerId !== input.sellerId || existing.productId !== input.productId) {
        throw new Error(`Conflicto de intent para publicacion ${input.operationId}.`)
      }
      return clone(existing)
    }
    const intent: AuctionPublicationIntentSnapshot = {
      operationId: input.operationId,
      auctionId: input.auctionId,
      sellerId: input.sellerId,
      productId: input.productId,
      closesAt: new Date(input.closesAt),
      inventoryCommitmentId: null,
      inventoryStatus: 'PENDING',
      publicationStatus: 'PENDING',
      lastError: null,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    }
    this.intents.set(input.operationId, intent)
    return clone(intent)
  }

  async getByOperationId(operationId: string): Promise<AuctionPublicationIntentSnapshot | null> {
    await Promise.resolve()
    const intent = this.intents.get(operationId)
    return intent === undefined ? null : clone(intent)
  }

  async persistInventoryCommitment(
    operationId: string,
    commitmentId: string,
    updatedAt: Date,
  ): Promise<AuctionPublicationIntentSnapshot> {
    await Promise.resolve()
    const intent = this.require(operationId)
    if (intent.inventoryCommitmentId !== null && intent.inventoryCommitmentId !== commitmentId) {
      throw new Error(`Conflicto de commitment para publicacion ${operationId}.`)
    }
    const updated: AuctionPublicationIntentSnapshot = {
      ...intent,
      inventoryCommitmentId: commitmentId,
      inventoryStatus: 'COMMITTED',
      lastError: null,
      updatedAt: new Date(updatedAt),
    }
    this.intents.set(operationId, updated)
    return clone(updated)
  }

  async markPublicationCompleted(
    operationId: string,
    updatedAt: Date,
  ): Promise<AuctionPublicationIntentSnapshot> {
    await Promise.resolve()
    const intent = this.require(operationId)
    const updated = {
      ...intent,
      publicationStatus: 'COMPLETED' as const,
      lastError: null,
      updatedAt,
    }
    this.intents.set(operationId, updated)
    return clone(updated)
  }

  async recordFailure(operationId: string, error: string, updatedAt: Date): Promise<void> {
    await Promise.resolve()
    const intent = this.require(operationId)
    this.intents.set(operationId, { ...intent, lastError: error, updatedAt: new Date(updatedAt) })
  }

  private require(operationId: string): AuctionPublicationIntentSnapshot {
    const intent = this.intents.get(operationId)
    if (intent === undefined) throw new Error(`La intencion ${operationId} no existe.`)
    return intent
  }
}
