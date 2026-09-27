import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
  type PublishOfficialAuctionInput,
} from '../../src/domain/entities/OfficialAuction'
import { AuctionRuleCode } from '../../src/domain/errors/AuctionRuleViolation'
import {
  AuctionPriceKind,
  createAuctionPublicationPricing,
} from '../../src/domain/value-objects/AuctionPublicationPricing'

const PUBLISHED_AT = new Date('2026-09-23T12:00:00.000Z')

const validInput = (): PublishOfficialAuctionInput => ({
  auctionId: 'official-auction-1',
  publisherId: 'upb-company-subject',
  publisherType: AuctionPublisherType.GameMaster,
  productId: 'exclusive-product-1',
  durationHours: 48,
  pricing: {
    kind: AuctionPriceKind.RealMoney,
    minimumBid: { amountMinor: 150_000, currency: 'COP' },
    buyNow: { amountMinor: 300_000, currency: 'COP' },
  },
  mark: OfficialAuctionMark.Official,
  publishedAt: PUBLISHED_AT,
})

const expectRule = (code: AuctionRuleCode, action: () => unknown): void => {
  expect(action).toThrow(expect.objectContaining({ code }))
}

describe('Dominio de publicacion oficial HU-66', () => {
  it.each([OfficialAuctionMark.Official, OfficialAuctionMark.Premium])(
    'publica %s en dinero real, sin comision y como GAME_MASTER',
    (mark) => {
      const snapshot = OfficialAuction.publish({ ...validInput(), mark }).snapshot()

      expect(snapshot).toEqual({
        id: 'official-auction-1',
        publisherId: 'upb-company-subject',
        publisherType: AuctionPublisherType.GameMaster,
        productId: 'exclusive-product-1',
        durationHours: 48,
        publicationFeeCredits: 0,
        currency: 'COP',
        minimumBidAmountMinor: 150_000,
        buyNowAmountMinor: 300_000,
        mark,
        status: 'ACTIVE',
        publishedAt: PUBLISHED_AT,
        closesAt: new Date('2026-09-25T12:00:00.000Z'),
      })
    },
  )

  it('admite omitir la compra inmediata', () => {
    expect(
      OfficialAuction.publish({
        ...validInput(),
        pricing: { ...validInput().pricing, buyNow: null },
      }).snapshot().buyNowAmountMinor,
    ).toBeNull()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza un importe monetario menor invalido: %s',
    (amountMinor) => {
      expectRule(AuctionRuleCode.InvalidMoney, () =>
        OfficialAuction.publish({
          ...validInput(),
          pricing: {
            ...validInput().pricing,
            minimumBid: { amountMinor, currency: 'COP' },
          },
        }),
      )
    },
  )

  it.each(['cop', 'CO', 'COP1', ''])('rechaza el codigo monetario invalido %s', (currency) => {
    expectRule(AuctionRuleCode.InvalidMoney, () =>
      OfficialAuction.publish({
        ...validInput(),
        pricing: {
          ...validInput().pricing,
          minimumBid: { amountMinor: 100, currency },
        },
      }),
    )
  })

  it('rechaza precios expresados en monedas diferentes', () => {
    expectRule(AuctionRuleCode.CurrencyMismatch, () =>
      OfficialAuction.publish({
        ...validInput(),
        pricing: {
          ...validInput().pricing,
          buyNow: { amountMinor: 300_000, currency: 'USD' },
        },
      }),
    )
  })

  it.each([149_999, 150_000])('rechaza compra inmediata no superior: %i', (amountMinor) => {
    expectRule(AuctionRuleCode.InvalidBuyNowPrice, () =>
      OfficialAuction.publish({
        ...validInput(),
        pricing: {
          ...validInput().pricing,
          buyNow: { amountMinor, currency: 'COP' },
        },
      }),
    )
  })

  it('rechaza una marca fuera del vocabulario', () => {
    expectRule(AuctionRuleCode.InvalidOfficialMark, () =>
      OfficialAuction.publish({
        ...validInput(),
        mark: 'FEATURED' as OfficialAuctionMark,
      }),
    )
  })

  it('acepta el maximo entero seguro sin perdida de precision', () => {
    const snapshot = OfficialAuction.publish({
      ...validInput(),
      pricing: {
        ...validInput().pricing,
        minimumBid: { amountMinor: Number.MAX_SAFE_INTEGER, currency: 'COP' },
        buyNow: null,
      },
    }).snapshot()

    expect(snapshot.minimumBidAmountMinor).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('impide que PLAYER use dinero real', () => {
    expectRule(AuctionRuleCode.UnsupportedCurrency, () =>
      createAuctionPublicationPricing(AuctionPublisherType.Player, validInput().pricing),
    )
  })

  it('impide que GAME_MASTER use creditos', () => {
    expectRule(AuctionRuleCode.UnsupportedCurrency, () =>
      createAuctionPublicationPricing(AuctionPublisherType.GameMaster, {
        kind: AuctionPriceKind.Credits,
        minimumBid: 10,
        buyNow: 20,
      }),
    )
  })

  it('impide que PLAYER construya una publicacion oficial', () => {
    expectRule(AuctionRuleCode.UnsupportedCurrency, () =>
      OfficialAuction.publish({
        ...validInput(),
        publisherType: AuctionPublisherType.Player,
      }),
    )
  })

  it('no expone referencias mutables de las fechas', () => {
    const auction = OfficialAuction.publish(validInput())
    const first = auction.snapshot()
    first.publishedAt.setUTCFullYear(2030)
    first.closesAt.setUTCFullYear(2030)

    expect(auction.snapshot().publishedAt).toEqual(PUBLISHED_AT)
    expect(auction.snapshot().closesAt).toEqual(new Date('2026-09-25T12:00:00.000Z'))
  })
})
