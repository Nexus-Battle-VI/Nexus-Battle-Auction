export const AUCTION_SETTLED_EVENT_TYPE = 'auction.settled' as const
export const AUCTION_SETTLED_EVENT_VERSION = 1 as const
export const AUCTION_SETTLED_EVENT_PRODUCER = 'auction' as const
export const AUCTION_SETTLED_EVENT_MAX_BYTES = 65_536

export type AuctionSettledEventDataV1 =
  | {
      readonly auctionId: string
      readonly productId: string
      readonly sellerId: string
      readonly resultType: 'WITHOUT_BIDS'
      readonly settledAt: string
    }
  | {
      readonly auctionId: string
      readonly productId: string
      readonly sellerId: string
      readonly resultType: 'WITH_WINNER'
      readonly winnerId: string
      readonly winningBidId: string
      readonly finalAmountCredits: number
      readonly loserBidderIds: readonly string[]
      readonly settledAt: string
    }

export interface AuctionSettledEventV1 {
  readonly eventId: string
  readonly eventType: typeof AUCTION_SETTLED_EVENT_TYPE
  readonly eventVersion: typeof AUCTION_SETTLED_EVENT_VERSION
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: typeof AUCTION_SETTLED_EVENT_PRODUCER
  readonly correlationId: string
  readonly data: AuctionSettledEventDataV1
}

export class AuctionSettledEventPayloadTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `El evento auction.settled.v1 ocupa ${String(bytes)} bytes y supera el limite contractual de ${String(AUCTION_SETTLED_EVENT_MAX_BYTES)} bytes.`,
    )
    this.name = 'AuctionSettledEventPayloadTooLargeError'
  }
}

export const auctionSettledEventId = (auctionId: string): string => `auction:${auctionId}:settled`

export const auctionSettlementCorrelationId = (auctionId: string): string =>
  `auction:${auctionId}:settlement`

export const serializeAuctionSettledEventV1 = (event: AuctionSettledEventV1): string => {
  const body = JSON.stringify(event)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > AUCTION_SETTLED_EVENT_MAX_BYTES) {
    throw new AuctionSettledEventPayloadTooLargeError(bytes)
  }
  return body
}

export const createAuctionSettledEventV1 = (
  input:
    | {
        readonly auctionId: string
        readonly productId: string
        readonly sellerId: string
        readonly resultType: 'WITHOUT_BIDS'
        readonly settledAt: Date
      }
    | {
        readonly auctionId: string
        readonly productId: string
        readonly sellerId: string
        readonly resultType: 'WITH_WINNER'
        readonly winnerId: string
        readonly winningBidId: string
        readonly finalAmountCredits: number
        readonly loserBidderIds: readonly string[]
        readonly settledAt: Date
      },
): AuctionSettledEventV1 => {
  if (input.resultType === 'WITH_WINNER' && input.loserBidderIds.includes(input.winnerId)) {
    throw new Error('El ganador no puede figurar entre los postores perdedores.')
  }
  const settledAt = input.settledAt.toISOString()
  const data: AuctionSettledEventDataV1 =
    input.resultType === 'WITHOUT_BIDS'
      ? {
          auctionId: input.auctionId,
          productId: input.productId,
          sellerId: input.sellerId,
          resultType: 'WITHOUT_BIDS',
          settledAt,
        }
      : {
          auctionId: input.auctionId,
          productId: input.productId,
          sellerId: input.sellerId,
          resultType: 'WITH_WINNER',
          winnerId: input.winnerId,
          winningBidId: input.winningBidId,
          finalAmountCredits: input.finalAmountCredits,
          loserBidderIds: [...new Set(input.loserBidderIds)].sort((left, right) =>
            left.localeCompare(right),
          ),
          settledAt,
        }
  const event: AuctionSettledEventV1 = {
    eventId: auctionSettledEventId(input.auctionId),
    eventType: AUCTION_SETTLED_EVENT_TYPE,
    eventVersion: AUCTION_SETTLED_EVENT_VERSION,
    aggregateId: input.auctionId,
    occurredAt: settledAt,
    producer: AUCTION_SETTLED_EVENT_PRODUCER,
    correlationId: auctionSettlementCorrelationId(input.auctionId),
    data,
  }
  serializeAuctionSettledEventV1(event)
  return event
}
