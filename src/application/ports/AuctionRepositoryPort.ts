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

export interface RecordBidCreditFailureCommand {
  readonly operationId: string
  readonly bidId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly stage: string
  readonly reason: string
  readonly newReservationId: string | null
  readonly previousReservationId: string | null
  readonly newReservationReleased: boolean
  readonly previousReservationReleased: boolean
  readonly occurredAt: Date
}

export type BidCreditOperationStatus =
  | 'PENDING_RESERVATION'
  | 'RESERVED'
  | 'BID_PERSISTED'
  | 'COMPLETED'
  | 'COMPENSATION_PENDING'
  | 'COMPENSATED'

export interface CreateBidCreditOperationCommand {
  readonly operationId: string
  readonly bidId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly amountCredits: number
  readonly createdAt: Date
}

export interface UpdateBidCreditOperationCommand {
  readonly operationId: string
  readonly status: BidCreditOperationStatus
  readonly reservationId: string | null
  readonly previousReservationId: string | null
  readonly updatedAt: Date
}

export interface BidCreditOperationSnapshot {
  readonly operationId: string
  readonly bidId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly amountCredits: number
  readonly status: BidCreditOperationStatus
  readonly reservationId: string | null
  readonly previousReservationId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface PersistBidResult {
  readonly bid: BidSnapshot
  readonly previousLeader: BidSnapshot | null
  readonly previousLeaderReservationId?: string | null
}

export interface AuctionRepositoryPort {
  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult>

  recordFailure(command: RecordPublicationFailureCommand): Promise<void>

  recordBidCreditFailure(command: RecordBidCreditFailureCommand): Promise<void>

  createBidCreditOperation(command: CreateBidCreditOperationCommand): Promise<void>

  updateBidCreditOperation(command: UpdateBidCreditOperationCommand): Promise<void>

  findBidCreditOperation(operationId: string): Promise<BidCreditOperationSnapshot | null>

  findById(auctionId: string): Promise<AuctionSnapshot | null>

  countActiveBySeller(sellerId: string): Promise<number>

  persistBid(
    bid: Bid,
    creditReservationId?: string | null,
    operationId?: string | null,
  ): Promise<PersistBidResult>

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null>

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]>

  findLastBidByBidder(bidderId: string): Promise<BidSnapshot | null>

  countActiveBidsByBidder(bidderId: string): Promise<number>
}

export const AUCTION_REPOSITORY = Symbol('AuctionRepositoryPort')
