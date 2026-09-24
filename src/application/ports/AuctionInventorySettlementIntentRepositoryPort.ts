export type AuctionInventorySettlementAction = 'RELEASE' | 'PENDING_CLAIM'
export type AuctionInventorySettlementIntentStatus =
  'PENDING' | 'CONFIRMED' | 'RETRYABLE' | 'TERMINAL_ERROR'

export interface AuctionInventorySettlementIntentSnapshot {
  readonly auctionId: string
  readonly operationId: string
  readonly action: AuctionInventorySettlementAction
  readonly commitmentId: string
  readonly sellerId: string
  readonly productId: string
  readonly winnerId: string | null
  readonly status: AuctionInventorySettlementIntentStatus
  readonly lastError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly confirmedAt: Date | null
}

export type CreateAuctionInventorySettlementIntentInput =
  | {
      readonly auctionId: string
      readonly operationId: string
      readonly action: 'RELEASE'
      readonly commitmentId: string
      readonly sellerId: string
      readonly productId: string
      readonly winnerId?: never
      readonly createdAt: Date
    }
  | {
      readonly auctionId: string
      readonly operationId: string
      readonly action: 'PENDING_CLAIM'
      readonly commitmentId: string
      readonly sellerId: string
      readonly productId: string
      readonly winnerId: string
      readonly createdAt: Date
    }

export interface AuctionInventorySettlementIntentRepositoryPort {
  getByAuctionId(auctionId: string): Promise<AuctionInventorySettlementIntentSnapshot | null>
  /** Candidatos PENDING_CLAIM retryables, ordenados de forma determinista. */
  findRetryablePendingClaims(
    limit: number,
  ): Promise<readonly AuctionInventorySettlementIntentSnapshot[]>
  getOrCreate(
    input: CreateAuctionInventorySettlementIntentInput,
  ): Promise<AuctionInventorySettlementIntentSnapshot>
  markConfirmed(
    auctionId: string,
    confirmedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot>
  markRetryable(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot>
  markTerminalError(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot>
}

export const AUCTION_INVENTORY_SETTLEMENT_INTENT_REPOSITORY = Symbol(
  'AuctionInventorySettlementIntentRepositoryPort',
)
