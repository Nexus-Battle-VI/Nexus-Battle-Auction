/**
 * HU-92.2: contrato de entrega de una publicación confirmada.
 * El dispatcher lo construye a partir del evento de publicación existente.
 */
export interface AuctionPublishedEventV1 {
  readonly eventId: string
  readonly eventType: 'auction.published'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'auction'
  readonly correlationId: string
  readonly data: {
    readonly auctionId: string
    readonly sellerId: string
    readonly productId: string
    readonly publishedAt: string
    readonly closesAt: string
  }
}
