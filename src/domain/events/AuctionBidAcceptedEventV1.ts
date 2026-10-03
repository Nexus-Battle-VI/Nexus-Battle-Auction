/**
 * HU-92.2: puja confirmada tras completar la operación de créditos.
 * Permite generar el aviso al vendedor y la confirmación al postor.
 */
export interface AuctionBidAcceptedEventV1 {
  readonly eventId: string
  readonly eventType: 'auction.bid.accepted'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'auction'
  readonly correlationId: string
  readonly data: {
    readonly operationId: string
    readonly auctionId: string
    readonly productId: string
    readonly sellerId: string
    readonly bidderId: string
    readonly bidId: string
    readonly amountCredits: number
    readonly acceptedAt: string
  }
}
