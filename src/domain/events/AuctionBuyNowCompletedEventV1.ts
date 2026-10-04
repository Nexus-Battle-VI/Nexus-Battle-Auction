/**
 * HU-92.3: la compra inmediata solo se comunica despues de que Wallet
 * confirma la transferencia y Auction persiste el cierre en la misma unidad.
 */
export interface AuctionBuyNowCompletedEventV1 {
  readonly eventId: string
  readonly eventType: 'auction.buy-now.completed'
  readonly eventVersion: 1
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'auction'
  readonly correlationId: string
  readonly data: {
    readonly operationId: string
    readonly transactionId: string
    readonly transferId: string
    readonly auctionId: string
    readonly productId: string
    readonly sellerId: string
    readonly buyerId: string
    readonly amountCredits: number
    readonly completedAt: string
  }
}
