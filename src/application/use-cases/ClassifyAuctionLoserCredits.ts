import type { BidCreditOperationSnapshot } from '../ports/AuctionRepositoryPort'
import type { BidCreditOperationReaderPort } from '../ports/BidCreditOperationReaderPort'
import type { BidSnapshot } from '../../domain/entities/Bid'

export type BidCreditReleaseClassification =
  'ALREADY_RELEASED' | 'ACTIVE_HOLD' | 'COMPENSATION_PENDING' | 'COMPENSATED' | 'INCONSISTENT'

export interface LoserCreditReleaseAction {
  readonly auctionId: string
  readonly bidId: string
  readonly holdId: string | null
  readonly classification: BidCreditReleaseClassification
  readonly releaseOperationId: string | null
  readonly reason: 'AUCTION_SETTLEMENT_LOST' | null
}

const classify = (
  bid: BidSnapshot,
  operations: readonly BidCreditOperationSnapshot[],
): LoserCreditReleaseAction => {
  const holdId = bid.creditReservationId ?? null
  const operation = operations.find(
    (candidate) => candidate.previousReservationId === holdId || candidate.reservationId === holdId,
  )
  if (operation?.status === 'COMPLETED' && operation.previousReservationId === holdId) {
    return {
      auctionId: bid.auctionId,
      bidId: bid.id,
      holdId,
      classification: 'ALREADY_RELEASED',
      releaseOperationId: null,
      reason: null,
    }
  }
  if (operation?.status === 'COMPENSATED') {
    return {
      auctionId: bid.auctionId,
      bidId: bid.id,
      holdId,
      classification: 'COMPENSATED',
      releaseOperationId: null,
      reason: null,
    }
  }
  if (operation?.status === 'COMPENSATION_PENDING') {
    return holdId === null
      ? {
          auctionId: bid.auctionId,
          bidId: bid.id,
          holdId: null,
          classification: 'INCONSISTENT',
          releaseOperationId: null,
          reason: null,
        }
      : {
          auctionId: bid.auctionId,
          bidId: bid.id,
          holdId,
          classification: 'COMPENSATION_PENDING',
          releaseOperationId: operation.operationId,
          reason: 'AUCTION_SETTLEMENT_LOST',
        }
  }
  if (holdId !== null) {
    return {
      auctionId: bid.auctionId,
      bidId: bid.id,
      holdId,
      classification: 'ACTIVE_HOLD',
      releaseOperationId: `auction:${bid.auctionId}:bid:${bid.id}:release`,
      reason: 'AUCTION_SETTLEMENT_LOST',
    }
  }
  return {
    auctionId: bid.auctionId,
    bidId: bid.id,
    holdId: null,
    classification: 'INCONSISTENT',
    releaseOperationId: null,
    reason: null,
  }
}

export class ClassifyAuctionLoserCredits {
  constructor(private readonly reader: BidCreditOperationReaderPort) {}

  async execute(
    auctionId: string,
    bids: readonly BidSnapshot[],
    winningBidId: string | null,
  ): Promise<readonly LoserCreditReleaseAction[]> {
    const operations = await this.reader.listByAuctionId(auctionId)
    return bids.filter((bid) => bid.id !== winningBidId).map((bid) => classify(bid, operations))
  }
}
