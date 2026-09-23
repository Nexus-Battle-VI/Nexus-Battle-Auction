import type { AuctionSettledEventV1 } from '../../domain/events/AuctionSettledEventV1'

export interface AuctionSettlementEventPublisherPort {
  publish(event: AuctionSettledEventV1): Promise<void>
}

export const AUCTION_SETTLEMENT_EVENT_PUBLISHER = Symbol('AuctionSettlementEventPublisherPort')
