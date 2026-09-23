import type {
  AuctionPendingClaimSnapshot,
  AuctionPendingClaimStatus,
} from '../../domain/entities/AuctionPendingClaim'

export type { AuctionPendingClaimSnapshot, AuctionPendingClaimStatus }

export interface CreateAuctionPendingClaimInput {
  readonly auctionId: string
  readonly winnerId: string
  readonly productId: string
  readonly winningBidId: string
  readonly finalAmountCredits: number
  readonly settledAt: Date
  readonly createdAt: Date
}
export interface AuctionPendingClaimRepositoryPort {
  createIfAbsent(input: CreateAuctionPendingClaimInput): Promise<AuctionPendingClaimSnapshot>
  findByAuctionId(auctionId: string): Promise<AuctionPendingClaimSnapshot | null>
  findPendingByWinnerId(winnerId: string): Promise<readonly AuctionPendingClaimSnapshot[]>
}
export const AUCTION_PENDING_CLAIM_REPOSITORY = Symbol('AuctionPendingClaimRepositoryPort')
