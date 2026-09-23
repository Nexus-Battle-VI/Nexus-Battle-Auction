import type { BidCreditOperationSnapshot } from './AuctionRepositoryPort'

export interface BidCreditOperationReaderPort {
  listByAuctionId(auctionId: string): Promise<readonly BidCreditOperationSnapshot[]>
}
