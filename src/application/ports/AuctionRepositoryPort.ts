import type { Auction, AuctionSnapshot } from '../../domain/entities/Auction'
import type { Bid, BidSnapshot } from '../../domain/entities/Bid'

export interface PersistAuctionPublicationCommand {
  readonly operationId: string
  readonly auction: Auction
  readonly inventoryCommitmentId: string
  readonly feeChargeId: string
}

export interface PersistAuctionPublicationResult {
  readonly auction: AuctionSnapshot
  readonly replayed: boolean
}

export interface RecordPublicationFailureCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly sellerId: string
  readonly stage: string
  readonly reason: string
  readonly feeChargeId: string | null
  readonly inventoryCommitmentId: string | null
  readonly feeRefunded: boolean
  readonly inventoryReleased: boolean
  readonly occurredAt: Date
}

export interface PersistBidResult {
  readonly bid: BidSnapshot
  readonly previousLeader: BidSnapshot | null
}

export interface AuctionRepositoryPort {
  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult>

  recordFailure(command: RecordPublicationFailureCommand): Promise<void>

  findById(auctionId: string): Promise<AuctionSnapshot | null>

  countActiveBySeller(sellerId: string): Promise<number>

  persistBid(bid: Bid): Promise<PersistBidResult>

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null>

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]>

  findLastBidByBidder(bidderId: string): Promise<BidSnapshot | null>

  countActiveBidsByBidder(bidderId: string): Promise<number>
}

export const AUCTION_REPOSITORY = Symbol('AuctionRepositoryPort')
