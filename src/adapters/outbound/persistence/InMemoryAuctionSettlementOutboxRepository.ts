import type { AuctionSettlementOutboxRepositoryPort } from '../../../application/ports/AuctionSettlementOutboxRepositoryPort'

/** Solo permite que el arranque local sin Postgres conserve el dispatcher desactivado. */
export class InMemoryAuctionSettlementOutboxRepository implements AuctionSettlementOutboxRepositoryPort {
  findPending(): Promise<readonly []> {
    return Promise.resolve([])
  }

  markPublished(): Promise<void> {
    return Promise.resolve()
  }
}
