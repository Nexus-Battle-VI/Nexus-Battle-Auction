import type { Kysely } from 'kysely'

import type { BidCreditOperationSnapshot } from '../../../application/ports/AuctionRepositoryPort'
import type { BidCreditOperationReaderPort } from '../../../application/ports/BidCreditOperationReaderPort'
import type { Database } from './schema'

export class PostgresBidCreditOperationReader implements BidCreditOperationReaderPort {
  constructor(private readonly db: Kysely<Database>) {}
  async listByAuctionId(auctionId: string): Promise<readonly BidCreditOperationSnapshot[]> {
    return (
      await this.db
        .selectFrom('auction_bid_credit_operations')
        .selectAll()
        .where('auction_id', '=', auctionId)
        .execute()
    ).map((row) => ({
      operationId: row.operation_id,
      bidId: row.bid_id,
      auctionId: row.auction_id,
      bidderId: row.bidder_id,
      amountCredits: row.amount_credits,
      status: row.status as BidCreditOperationSnapshot['status'],
      reservationId: row.reservation_id,
      previousReservationId: row.previous_reservation_id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }))
  }
}
