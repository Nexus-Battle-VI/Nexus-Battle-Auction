import { AuctionStatus } from '../../src/domain/entities/Auction'
import {
  Bid,
  BID_COOLDOWN_SECONDS,
  MAX_ACTIVE_BIDS_PER_BIDDER,
} from '../../src/domain/entities/Bid'
import { BidRuleCode, BidRuleViolation } from '../../src/domain/errors/BidRuleViolation'

const placedAt = new Date('2026-09-21T12:00:10.000Z')

function validInput() {
  return {
    bidId: 'bid-63-1',
    auctionId: 'auction-62-1',
    bidderId: 'bidder-1',
    amountCredits: 20,
    placedAt,
    eligibility: {
      auctionStatus: AuctionStatus.Active,
      sellerId: 'seller-1',
      currentBidCredits: 10,
      minimumIncrementCredits: 5,
      lastBidAtByBidder: null,
      activeBidCount: 0,
    },
  }
}

function expectRule(code: BidRuleCode, action: () => unknown): void {
  try {
    action()
    throw new Error(`Se esperaba la regla ${code}.`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BidRuleViolation)
    expect((error as BidRuleViolation).code).toBe(code)
  }
}

describe('Dominio de registro de puja HU-63', () => {
  it('registra una puja valida', () => {
    const bid = Bid.register(validInput())

    expect(bid.snapshot()).toEqual({
      id: 'bid-63-1',
      auctionId: 'auction-62-1',
      bidderId: 'bidder-1',
      amountCredits: 20,
      placedAt,
    })
  })

  it('acepta una puja cuando no existe oferta anterior', () => {
    const bid = Bid.register({
      ...validInput(),
      amountCredits: 10,
      eligibility: {
        ...validInput().eligibility,
        currentBidCredits: null,
      },
    })

    expect(bid.amount.value).toBe(10)
  })

  it('rechaza una subasta no activa', () => {
  expectRule(BidRuleCode.AuctionNotActive, () =>
    Bid.register({
      ...validInput(),
      eligibility: {
        ...validInput().eligibility,
        auctionStatus: 'CLOSED',
      },
    }),
  )
})

  it('rechaza puja del vendedor de la subasta', () => {
    expectRule(BidRuleCode.SellerCannotBid, () =>
      Bid.register({
        ...validInput(),
        bidderId: 'seller-1',
      }),
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza monto de puja invalido %s',
    (amountCredits) => {
      expectRule(BidRuleCode.InvalidBidAmount, () =>
        Bid.register({
          ...validInput(),
          amountCredits,
        }),
      )
    },
  )

  it('rechaza una puja igual a la oferta actual', () => {
    expectRule(BidRuleCode.BidTooLow, () =>
      Bid.register({
        ...validInput(),
        amountCredits: 10,
      }),
    )
  })

  it('rechaza una puja menor a la oferta actual', () => {
    expectRule(BidRuleCode.BidTooLow, () =>
      Bid.register({
        ...validInput(),
        amountCredits: 9,
      }),
    )
  })

  it('rechaza una puja que supera la actual pero no cumple el incremento minimo', () => {
    expectRule(BidRuleCode.MinimumIncrementNotMet, () =>
      Bid.register({
        ...validInput(),
        amountCredits: 14,
      }),
    )
  })

  it('acepta exactamente el incremento minimo configurado', () => {
    const bid = Bid.register({
      ...validInput(),
      amountCredits: 15,
    })

    expect(bid.amount.value).toBe(15)
  })

  it('rechaza una segunda puja antes de 5 segundos', () => {
    expectRule(BidRuleCode.BidCooldownActive, () =>
      Bid.register({
        ...validInput(),
        eligibility: {
          ...validInput().eligibility,
          lastBidAtByBidder: new Date(
            placedAt.getTime() - (BID_COOLDOWN_SECONDS * 1000 - 1),
          ),
        },
      }),
    )
  })

  it('acepta una segunda puja exactamente a los 5 segundos', () => {
    const bid = Bid.register({
      ...validInput(),
      eligibility: {
        ...validInput().eligibility,
        lastBidAtByBidder: new Date(
          placedAt.getTime() - BID_COOLDOWN_SECONDS * 1000,
        ),
      },
    })

    expect(bid.bidderId.value).toBe('bidder-1')
  })

  it('rechaza una fecha de ultima puja posterior a la nueva puja', () => {
    expectRule(BidRuleCode.BidCooldownActive, () =>
      Bid.register({
        ...validInput(),
        eligibility: {
          ...validInput().eligibility,
          lastBidAtByBidder: new Date(placedAt.getTime() + 1000),
        },
      }),
    )
  })

  it('acepta la frontera de 49 pujas activas', () => {
    const bid = Bid.register({
      ...validInput(),
      eligibility: {
        ...validInput().eligibility,
        activeBidCount: MAX_ACTIVE_BIDS_PER_BIDDER - 1,
      },
    })

    expect(bid.bidderId.value).toBe('bidder-1')
  })

  it('rechaza exactamente 50 pujas activas', () => {
    expectRule(BidRuleCode.ActiveBidLimitReached, () =>
      Bid.register({
        ...validInput(),
        eligibility: {
          ...validInput().eligibility,
          activeBidCount: MAX_ACTIVE_BIDS_PER_BIDDER,
        },
      }),
    )
  })

  it.each([-1, 1.5])(
    'rechaza conteo invalido de pujas activas %s',
    (activeBidCount) => {
      expectRule(BidRuleCode.ActiveBidLimitReached, () =>
        Bid.register({
          ...validInput(),
          eligibility: {
            ...validInput().eligibility,
            activeBidCount,
          },
        }),
      )
    },
  )

  it('rechaza fecha de puja invalida', () => {
    expectRule(BidRuleCode.InvalidBidDate, () =>
      Bid.register({
        ...validInput(),
        placedAt: new Date(Number.NaN),
      }),
    )
  })

  it('rechaza fecha invalida de ultima puja', () => {
    expectRule(BidRuleCode.InvalidBidDate, () =>
      Bid.register({
        ...validInput(),
        eligibility: {
          ...validInput().eligibility,
          lastBidAtByBidder: new Date(Number.NaN),
        },
      }),
    )
  })

  it('rechaza identificadores invalidos', () => {
    expectRule(BidRuleCode.InvalidIdentifier, () =>
      Bid.register({
        ...validInput(),
        bidId: ' ',
      }),
    )
  })

  it('no expone referencia mutable de la fecha interna', () => {
    const bid = Bid.register(validInput())

    const first = bid.snapshot()
    first.placedAt.setUTCFullYear(2030)

    const second = bid.snapshot()
    expect(second.placedAt).toEqual(placedAt)
  })
})