import type { AuctionBidAcceptedEventV1 } from '../../domain/events/AuctionBidAcceptedEventV1'
import type { AuctionBuyNowCompletedEventV1 } from '../../domain/events/AuctionBuyNowCompletedEventV1'
import type { AuctionProductClaimedEventV1 } from '../../domain/events/AuctionProductClaimedEventV1'
import type { AuctionPublishedEventV1 } from '../../domain/events/AuctionPublishedEventV1'

export type AuctionConfirmationEvent =
  | AuctionPublishedEventV1
  | AuctionBidAcceptedEventV1
  | AuctionBuyNowCompletedEventV1
  | AuctionProductClaimedEventV1

export interface AuctionConfirmationOutboxRepositoryPort {
  findPending(input: { readonly limit: number }): Promise<readonly AuctionConfirmationEvent[]>

  markPublished(input: { readonly eventId: string; readonly publishedAt: Date }): Promise<void>
}

export const AUCTION_CONFIRMATION_OUTBOX_REPOSITORY = Symbol(
  'AuctionConfirmationOutboxRepositoryPort',
)
