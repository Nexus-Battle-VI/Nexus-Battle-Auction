import type {
  AuctionInventorySettlementIntentRepositoryPort,
  AuctionInventorySettlementIntentSnapshot,
  CreateAuctionInventorySettlementIntentInput,
} from '../../../application/ports/AuctionInventorySettlementIntentRepositoryPort'

const clone = (
  intent: AuctionInventorySettlementIntentSnapshot,
): AuctionInventorySettlementIntentSnapshot => ({
  ...intent,
  createdAt: new Date(intent.createdAt),
  updatedAt: new Date(intent.updatedAt),
  confirmedAt: intent.confirmedAt === null ? null : new Date(intent.confirmedAt),
})

export class InMemoryAuctionInventorySettlementIntentRepository implements AuctionInventorySettlementIntentRepositoryPort {
  private readonly intents = new Map<string, AuctionInventorySettlementIntentSnapshot>()

  getByAuctionId(auctionId: string): Promise<AuctionInventorySettlementIntentSnapshot | null> {
    const intent = this.intents.get(auctionId)
    return Promise.resolve(intent === undefined ? null : clone(intent))
  }

  getOrCreate(
    input: CreateAuctionInventorySettlementIntentInput,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    const existing = this.intents.get(input.auctionId)
    if (existing !== undefined) {
      if (!sameIntent(existing, input)) {
        return Promise.reject(new Error(`Conflicto de intent Inventory ${input.auctionId}.`))
      }
      return Promise.resolve(clone(existing))
    }
    const intent: AuctionInventorySettlementIntentSnapshot = {
      auctionId: input.auctionId,
      operationId: input.operationId,
      action: input.action,
      commitmentId: input.commitmentId,
      sellerId: input.sellerId,
      productId: input.productId,
      winnerId: input.action === 'RELEASE' ? null : input.winnerId,
      status: 'PENDING',
      lastError: null,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      confirmedAt: null,
    }
    this.intents.set(input.auctionId, intent)
    return Promise.resolve(clone(intent))
  }

  markConfirmed(
    auctionId: string,
    confirmedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    const current = this.require(auctionId)
    if (current.status === 'CONFIRMED') return Promise.resolve(clone(current))
    if (!['PENDING', 'RETRYABLE'].includes(current.status)) {
      return Promise.reject(new Error('El intent Inventory no admite confirmacion.'))
    }
    return Promise.resolve(
      this.save({
        ...current,
        status: 'CONFIRMED',
        lastError: null,
        updatedAt: new Date(confirmedAt),
        confirmedAt: new Date(confirmedAt),
      }),
    )
  }

  markRetryable(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    const current = this.require(auctionId)
    if (!['PENDING', 'RETRYABLE'].includes(current.status)) {
      return Promise.reject(new Error('El intent Inventory no admite reintento.'))
    }
    return Promise.resolve(
      this.save({ ...current, status: 'RETRYABLE', lastError: error, updatedAt }),
    )
  }

  markTerminalError(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    const current = this.require(auctionId)
    if (current.status === 'TERMINAL_ERROR') return Promise.resolve(clone(current))
    if (!['PENDING', 'RETRYABLE'].includes(current.status)) {
      return Promise.reject(new Error('El intent Inventory no admite error terminal.'))
    }
    return Promise.resolve(
      this.save({ ...current, status: 'TERMINAL_ERROR', lastError: error, updatedAt }),
    )
  }

  private require(auctionId: string): AuctionInventorySettlementIntentSnapshot {
    const intent = this.intents.get(auctionId)
    if (intent === undefined) throw new Error(`El intent Inventory ${auctionId} no existe.`)
    return intent
  }

  private save(
    intent: AuctionInventorySettlementIntentSnapshot,
  ): AuctionInventorySettlementIntentSnapshot {
    this.intents.set(intent.auctionId, intent)
    return clone(intent)
  }
}

const sameIntent = (
  intent: AuctionInventorySettlementIntentSnapshot,
  input: CreateAuctionInventorySettlementIntentInput,
): boolean =>
  intent.operationId === input.operationId &&
  intent.action === input.action &&
  intent.commitmentId === input.commitmentId &&
  intent.sellerId === input.sellerId &&
  intent.productId === input.productId &&
  intent.winnerId === (input.action === 'RELEASE' ? null : input.winnerId)
