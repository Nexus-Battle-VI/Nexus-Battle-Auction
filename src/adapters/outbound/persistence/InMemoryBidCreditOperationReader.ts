import type { BidCreditOperationSnapshot } from '../../../application/ports/AuctionRepositoryPort'
import type { BidCreditOperationReaderPort } from '../../../application/ports/BidCreditOperationReaderPort'

export class InMemoryBidCreditOperationReader implements BidCreditOperationReaderPort {
  constructor(private readonly operations: readonly BidCreditOperationSnapshot[] = []) {}
  listByAuctionId(auctionId: string): Promise<readonly BidCreditOperationSnapshot[]> {
    return Promise.resolve(
      this.operations
        .filter((operation) => operation.auctionId === auctionId)
        .map((operation) => ({
          ...operation,
          createdAt: new Date(operation.createdAt),
          updatedAt: new Date(operation.updatedAt),
        })),
    )
  }
}
