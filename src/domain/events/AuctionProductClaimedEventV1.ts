/**
 * HU-92.3: el reclamo se comunica solo tras la confirmacion de Inventory y
 * la transicion durable a CLAIMED.
 */
export interface AuctionProductClaimedEventV1 {
  readonly eventId: string
  readonly eventType: 'auction.product.claimed'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'auction'
  readonly correlationId: string
  readonly data: {
    readonly auctionId: string
    readonly winnerId: string
    readonly productId: string
    readonly claimedAt: string
  }
}
