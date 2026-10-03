import type { AuctionConfirmationEvent } from './AuctionConfirmationOutboxRepositoryPort'

export interface AuctionConfirmationEventPublisherPort {
  publish(event: AuctionConfirmationEvent): Promise<void>
}

export const AUCTION_CONFIRMATION_EVENT_PUBLISHER = Symbol('AuctionConfirmationEventPublisherPort')
