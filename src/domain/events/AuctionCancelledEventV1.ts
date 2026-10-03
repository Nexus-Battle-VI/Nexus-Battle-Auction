export const AUCTION_CANCELLED_EVENT_TYPE = 'auction.cancelled' as const
export const AUCTION_CANCELLED_EVENT_VERSION = 1 as const
export const AUCTION_CANCELLED_EVENT_PRODUCER = 'auction' as const
export const AUCTION_CANCELLED_EVENT_MAX_BYTES = 65_536

/**
 * HU-90. Solo cancelacion MANUAL en este incremento: no hay `reason`/`cause`
 * en el payload porque todavia no existe una causa automatica aprobada
 * (CA-05, fuera de alcance). Anadir ese campo cuando exista es aditivo.
 */
export interface AuctionCancelledEventDataV1 {
  readonly auctionId: string
  readonly sellerId: string
  readonly productId: string
  readonly cancelledAt: string
}

export interface AuctionCancelledEventV1 {
  readonly eventId: string
  readonly eventType: typeof AUCTION_CANCELLED_EVENT_TYPE
  readonly eventVersion: typeof AUCTION_CANCELLED_EVENT_VERSION
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: typeof AUCTION_CANCELLED_EVENT_PRODUCER
  readonly correlationId: string
  readonly data: AuctionCancelledEventDataV1
}

export class AuctionCancelledEventPayloadTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `El evento auction.cancelled.v1 ocupa ${String(bytes)} bytes y supera el limite contractual de ${String(AUCTION_CANCELLED_EVENT_MAX_BYTES)} bytes.`,
    )
    this.name = 'AuctionCancelledEventPayloadTooLargeError'
  }
}

export const auctionCancelledEventId = (auctionId: string): string =>
  `auction:${auctionId}:cancelled`

export const auctionCancellationCorrelationId = (auctionId: string): string =>
  `auction:${auctionId}:cancellation`

export const serializeAuctionCancelledEventV1 = (event: AuctionCancelledEventV1): string => {
  const body = JSON.stringify(event)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > AUCTION_CANCELLED_EVENT_MAX_BYTES) {
    throw new AuctionCancelledEventPayloadTooLargeError(bytes)
  }
  return body
}

export const createAuctionCancelledEventV1 = (input: {
  readonly auctionId: string
  readonly sellerId: string
  readonly productId: string
  readonly cancelledAt: Date
}): AuctionCancelledEventV1 => {
  const cancelledAt = input.cancelledAt.toISOString()
  const event: AuctionCancelledEventV1 = {
    eventId: auctionCancelledEventId(input.auctionId),
    eventType: AUCTION_CANCELLED_EVENT_TYPE,
    eventVersion: AUCTION_CANCELLED_EVENT_VERSION,
    aggregateId: input.auctionId,
    occurredAt: cancelledAt,
    producer: AUCTION_CANCELLED_EVENT_PRODUCER,
    correlationId: auctionCancellationCorrelationId(input.auctionId),
    data: {
      auctionId: input.auctionId,
      sellerId: input.sellerId,
      productId: input.productId,
      cancelledAt,
    },
  }
  serializeAuctionCancelledEventV1(event)
  return event
}
