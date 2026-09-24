export type PublicationInventoryStatus = 'PENDING' | 'COMMITTED' | 'RELEASED'
export type PublicationStatus = 'PENDING' | 'COMPLETED' | 'FAILED_TERMINAL'

export interface AuctionPublicationIntentSnapshot {
  readonly operationId: string
  readonly auctionId: string
  readonly sellerId: string
  readonly productId: string
  readonly closesAt: Date
  readonly inventoryCommitmentId: string | null
  readonly inventoryStatus: PublicationInventoryStatus
  readonly publicationStatus: PublicationStatus
  readonly lastError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateAuctionPublicationIntentInput {
  readonly operationId: string
  readonly auctionId: string
  readonly sellerId: string
  readonly productId: string
  readonly closesAt: Date
  readonly createdAt: Date
}

export interface AuctionPublicationIntentRepositoryPort {
  getOrCreate(input: CreateAuctionPublicationIntentInput): Promise<AuctionPublicationIntentSnapshot>
  getByOperationId(operationId: string): Promise<AuctionPublicationIntentSnapshot | null>
  persistInventoryCommitment(
    operationId: string,
    commitmentId: string,
    updatedAt: Date,
  ): Promise<AuctionPublicationIntentSnapshot>
  markPublicationCompleted(
    operationId: string,
    updatedAt: Date,
  ): Promise<AuctionPublicationIntentSnapshot>
  recordFailure(operationId: string, error: string, updatedAt: Date): Promise<void>
}

export const AUCTION_PUBLICATION_INTENT_REPOSITORY = Symbol(
  'AuctionPublicationIntentRepositoryPort',
)
