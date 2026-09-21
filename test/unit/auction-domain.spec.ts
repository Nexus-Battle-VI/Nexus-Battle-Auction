import { Auction, AuctionStatus } from '../../src/domain/entities/Auction'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import { AuctionCurrency } from '../../src/domain/value-objects/AuctionPricing'

const publishedAt = new Date('2026-09-21T12:00:00.000Z')

function validInput() {
  return {
    auctionId: 'auction-62-1',
    sellerId: 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits: 10,
    buyNowCredits: 20,
    publishedAt,
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  }
}

function expectRule(code: AuctionRuleCode, action: () => unknown): void {
  try {
    action()
    throw new Error(`Se esperaba la regla ${code}.`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuctionRuleViolation)
    expect((error as AuctionRuleViolation).code).toBe(code)
  }
}

describe('Dominio de publicacion de subasta HU-62', () => {
  it.each([
    [24, 1, '2026-09-22T12:00:00.000Z'],
    [48, 3, '2026-09-23T12:00:00.000Z'],
  ])('publica por %i horas con comision de %i credito(s)', (durationHours, fee, closesAt) => {
    const auction = Auction.publish({ ...validInput(), durationHours })

    expect(auction.snapshot()).toEqual({
      id: 'auction-62-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      durationHours,
      publicationFeeCredits: fee,
      minimumBidCredits: 10,
      buyNowCredits: 20,
      status: AuctionStatus.Active,
      publishedAt,
      closesAt: new Date(closesAt),
    })
  })

  it('admite omitir el precio de compra inmediata', () => {
    const snapshot = Auction.publish({ ...validInput(), buyNowCredits: null }).snapshot()

    expect(snapshot.buyNowCredits).toBeNull()
  })

  it.each([0, 23, 25, 72])('rechaza la duracion no admitida %i', (durationHours) => {
    expectRule(AuctionRuleCode.InvalidDuration, () =>
      Auction.publish({ ...validInput(), durationHours }),
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza el precio minimo invalido %s',
    (minimumBidCredits) => {
      expectRule(AuctionRuleCode.InvalidCredits, () =>
        Auction.publish({ ...validInput(), minimumBidCredits }),
      )
    },
  )

  it.each([9, 10])(
    'rechaza compra inmediata %i que no supera el precio minimo',
    (buyNowCredits) => {
      expectRule(AuctionRuleCode.InvalidBuyNowPrice, () =>
        Auction.publish({ ...validInput(), buyNowCredits }),
      )
    },
  )

  it('rechaza publicaciones de jugador en moneda real', () => {
    expectRule(AuctionRuleCode.UnsupportedCurrency, () =>
      Auction.publish({ ...validInput(), currency: AuctionCurrency.RealMoney }),
    )
  })

  it.each([
    ['producto ajeno', { productOwnedBySeller: false }, AuctionRuleCode.ProductNotOwned],
    ['producto en uso', { productInUse: true }, AuctionRuleCode.ProductInUse],
    ['producto no comercializable', { productTradable: false }, AuctionRuleCode.ProductNotTradable],
    ['vendedor sancionado', { sellerHasActiveSanctions: true }, AuctionRuleCode.SellerSanctioned],
    [
      'diez subastas activas',
      { activeAuctionCount: 10 },
      AuctionRuleCode.ActiveAuctionLimitReached,
    ],
  ] as const)('rechaza %s', (_case, eligibilityChange, code) => {
    expectRule(code, () =>
      Auction.publish({
        ...validInput(),
        eligibility: { ...validInput().eligibility, ...eligibilityChange },
      }),
    )
  })

  it('acepta la frontera de nueve subastas activas', () => {
    const auction = Auction.publish({
      ...validInput(),
      eligibility: { ...validInput().eligibility, activeAuctionCount: 9 },
    })

    expect(auction.status).toBe(AuctionStatus.Active)
  })

  it.each([-1, 1.5])('rechaza un conteo de subastas activas invalido: %s', (count) => {
    expectRule(AuctionRuleCode.ActiveAuctionLimitReached, () =>
      Auction.publish({
        ...validInput(),
        eligibility: { ...validInput().eligibility, activeAuctionCount: count },
      }),
    )
  })

  it('rechaza fechas invalidas', () => {
    expectRule(AuctionRuleCode.InvalidPublicationDate, () =>
      Auction.publish({ ...validInput(), publishedAt: new Date(Number.NaN) }),
    )
  })

  it('rechaza identificadores vacios o con formato invalido', () => {
    expectRule(AuctionRuleCode.InvalidIdentifier, () =>
      Auction.publish({ ...validInput(), auctionId: ' ' }),
    )
  })

  it('no expone referencias mutables de las fechas internas', () => {
    const auction = Auction.publish(validInput())
    const first = auction.snapshot()
    first.publishedAt.setUTCFullYear(2030)
    first.closesAt.setUTCFullYear(2030)

    const second = auction.snapshot()
    expect(second.publishedAt).toEqual(publishedAt)
    expect(second.closesAt).toEqual(new Date('2026-09-22T12:00:00.000Z'))
  })
})
