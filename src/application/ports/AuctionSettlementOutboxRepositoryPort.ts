import type { AuctionSettledEventV1 } from '../../domain/events/AuctionSettledEventV1'

export interface AuctionSettlementOutboxRepositoryPort {
  findPending(input: { readonly limit: number }): Promise<readonly AuctionSettledEventV1[]>
  markPublished(input: { readonly eventId: string; readonly publishedAt: Date }): Promise<void>
}

export const AUCTION_SETTLEMENT_OUTBOX_REPOSITORY = Symbol('AuctionSettlementOutboxRepositoryPort')
