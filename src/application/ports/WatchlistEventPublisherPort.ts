export type WatchlistChangeType = 'LEADING_BID_CHANGED'

export interface AuctionWatchlistChangedEvent {
  readonly eventId: string
  readonly eventType: 'auction.watchlist.changed.v1'
  readonly auctionId: string
  readonly recipientPlayerIds: readonly string[]
  readonly changeType: WatchlistChangeType
  readonly occurredAt: Date
}

export interface AuctionClosingSoonEvent {
  readonly eventId: string
  readonly eventType: 'auction.closing-soon.v1'
  readonly auctionId: string
  readonly recipientPlayerIds: readonly string[]
  readonly closesAt: Date
  readonly occurredAt: Date
}

export type AuctionWatchlistEvent = AuctionWatchlistChangedEvent | AuctionClosingSoonEvent

/** Puerto del bus de eventos de HU-68; Application desconoce HTTP y Notifications. */
export interface WatchlistEventPublisherPort {
  publish(event: AuctionWatchlistEvent): Promise<void>
}

export const WATCHLIST_EVENT_PUBLISHER = Symbol('WatchlistEventPublisherPort')
