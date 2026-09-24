import {
  AUCTION_SETTLED_EVENT_MAX_BYTES,
  AuctionSettledEventPayloadTooLargeError,
  createAuctionSettledEventV1,
  serializeAuctionSettledEventV1,
} from '../../src/domain/events/AuctionSettledEventV1'

const settledAt = new Date('2026-10-01T12:00:00.000Z')

describe('AuctionSettledEventV1', () => {
  it('crea el envelope canonico WITH_WINNER y normaliza perdedores', () => {
    expect(
      createAuctionSettledEventV1({
        auctionId: 'auction-1',
        productId: 'product-1',
        sellerId: 'seller-1',
        resultType: 'WITH_WINNER',
        winnerId: 'winner-1',
        winningBidId: 'bid-1',
        finalAmountCredits: 70,
        loserBidderIds: ['loser-b', 'loser-a', 'loser-b'],
        settledAt,
      }),
    ).toEqual({
      eventId: 'auction:auction-1:settled',
      eventType: 'auction.settled',
      eventVersion: 1,
      aggregateId: 'auction-1',
      occurredAt: '2026-10-01T12:00:00.000Z',
      producer: 'auction',
      correlationId: 'auction:auction-1:settlement',
      data: {
        auctionId: 'auction-1',
        productId: 'product-1',
        sellerId: 'seller-1',
        resultType: 'WITH_WINNER',
        winnerId: 'winner-1',
        winningBidId: 'bid-1',
        finalAmountCredits: 70,
        loserBidderIds: ['loser-a', 'loser-b'],
        settledAt: '2026-10-01T12:00:00.000Z',
      },
    })
  })

  it('omite campos de ganador en WITHOUT_BIDS', () => {
    const event = createAuctionSettledEventV1({
      auctionId: 'empty',
      productId: 'product',
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt,
    })

    expect(event.data).toEqual({
      auctionId: 'empty',
      productId: 'product',
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt: '2026-10-01T12:00:00.000Z',
    })
  })

  it('rechaza que el ganador figure como perdedor', () => {
    expect(() =>
      createAuctionSettledEventV1({
        auctionId: 'auction',
        productId: 'product',
        sellerId: 'seller',
        resultType: 'WITH_WINNER',
        winnerId: 'winner',
        winningBidId: 'bid',
        finalAmountCredits: 1,
        loserBidderIds: ['winner'],
        settledAt,
      }),
    ).toThrow(/ganador/)
  })

  it('mide el cuerpo serializado en UTF-8 y falla sobre 64 KiB', () => {
    const event = createAuctionSettledEventV1({
      auctionId: 'auction',
      productId: 'product',
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt,
    })
    const oversized = {
      ...event,
      data: { ...event.data, productId: 'á'.repeat(AUCTION_SETTLED_EVENT_MAX_BYTES) },
    }

    expect(() => serializeAuctionSettledEventV1(oversized)).toThrow(
      AuctionSettledEventPayloadTooLargeError,
    )
  })

  it('acepta exactamente 64 KiB serializados', () => {
    const base = createAuctionSettledEventV1({
      auctionId: 'auction',
      productId: '',
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt,
    })
    const availableBytes =
      AUCTION_SETTLED_EVENT_MAX_BYTES - Buffer.byteLength(JSON.stringify(base), 'utf8')
    const boundary = createAuctionSettledEventV1({
      auctionId: 'auction',
      productId: 'x'.repeat(availableBytes),
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt,
    })

    expect(Buffer.byteLength(serializeAuctionSettledEventV1(boundary), 'utf8')).toBe(
      AUCTION_SETTLED_EVENT_MAX_BYTES,
    )
  })
})
