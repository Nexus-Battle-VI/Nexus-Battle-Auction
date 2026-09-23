export type AuctionPendingClaimStatus = 'PENDING' | 'CLAIMED'
export interface AuctionPendingClaimSnapshot {
  readonly auctionId: string
  readonly winnerId: string
  readonly productId: string
  readonly winningBidId: string
  readonly finalAmountCredits: number
  readonly settledAt: Date
  readonly claimStatus: AuctionPendingClaimStatus
  readonly claimedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}
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
