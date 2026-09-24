import type { BidCreditOperationSnapshot } from './AuctionRepositoryPort'

export interface BidCreditOperationReaderPort {
  listByAuctionId(auctionId: string): Promise<readonly BidCreditOperationSnapshot[]>
}

export const BID_CREDIT_OPERATION_READER = Symbol('BidCreditOperationReaderPort')
