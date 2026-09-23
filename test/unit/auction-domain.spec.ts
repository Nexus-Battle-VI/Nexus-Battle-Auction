import {
  Auction,
  AuctionClosingOutcome,
  AuctionStatus,
  type RehydrateAuctionInput,
} from '../../src/domain/entities/Auction'
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

describe('Dominio de finalizacion de subasta HU-65', () => {
  const closesAt = new Date('2026-09-22T12:00:00.000Z')

  function activeAuction(): Auction {
    return Auction.publish(validInput())
  }

  function leader(
    overrides: Partial<{
      auctionId: string
      bidId: string
      bidderId: string
      amountCredits: number
    }> = {},
  ) {
    return {
      auctionId: 'auction-62-1',
      bidId: 'bid-63-2',
      bidderId: 'bidder-2',
      amountCredits: 35,
      ...overrides,
    }
  }

  it('rechaza finalizar 1 ms antes del vencimiento', () => {
    expectRule(AuctionRuleCode.AuctionNotExpired, () =>
      activeAuction().finish({
        finishedAt: new Date(closesAt.getTime() - 1),
        leadingBid: null,
      }),
    )
  })

  it.each([closesAt, new Date(closesAt.getTime() + 1)])(
    'permite finalizar desde el vencimiento: %s',
    (finishedAt) => {
      const result = activeAuction().finish({ finishedAt, leadingBid: null })

      expect(result.outcome).toBe(AuctionClosingOutcome.WithoutBids)
    },
  )

  it('finaliza con el ganador y el importe de la oferta lider autoritativa', () => {
    const result = activeAuction().finish({
      finishedAt: closesAt,
      leadingBid: leader(),
    })

    expect(result.snapshot()).toEqual({
      outcome: AuctionClosingOutcome.WithWinner,
      finishedAt: closesAt,
      winnerId: 'bidder-2',
      winningBidId: 'bid-63-2',
      finalAmountCredits: 35,
    })
  })

  it('usa exclusivamente la oferta lider vigente, aunque existan pujas anteriores mayores', () => {
    const result = activeAuction().finish({
      finishedAt: closesAt,
      leadingBid: leader({ bidId: 'bid-63-actual', bidderId: 'bidder-actual', amountCredits: 40 }),
    })

    expect(result.winningBidId?.value).toBe('bid-63-actual')
    expect(result.winnerId?.value).toBe('bidder-actual')
    expect(result.finalAmount?.value).toBe(40)
  })

  it('finaliza sin ganador cuando no hay oferta lider', () => {
    const result = activeAuction().finish({ finishedAt: closesAt, leadingBid: null })

    expect(result.snapshot()).toEqual({
      outcome: AuctionClosingOutcome.WithoutBids,
      finishedAt: closesAt,
      winnerId: null,
      winningBidId: null,
      finalAmountCredits: null,
    })
  })

  it('rechaza que una puja de otra subasta se convierta en ganadora', () => {
    expectRule(AuctionRuleCode.LeadingBidDoesNotBelongToAuction, () =>
      activeAuction().finish({
        finishedAt: closesAt,
        leadingBid: leader({ auctionId: 'another-auction' }),
      }),
    )
  })

  it('rechaza el segundo intento de finalizar', () => {
    const auction = activeAuction()
    auction.finish({ finishedAt: closesAt, leadingBid: null })

    expectRule(AuctionRuleCode.AuctionAlreadyFinished, () =>
      auction.finish({ finishedAt: new Date(closesAt.getTime() + 1), leadingBid: null }),
    )
  })

  it('representa la finalizacion en el snapshot posterior', () => {
    const auction = activeAuction()
    auction.finish({ finishedAt: closesAt, leadingBid: leader() })

    expect(auction.snapshot()).toMatchObject({
      status: AuctionStatus.Finished,
      completion: {
        outcome: AuctionClosingOutcome.WithWinner,
        finishedAt: closesAt,
        winnerId: 'bidder-2',
        winningBidId: 'bid-63-2',
        finalAmountCredits: 35,
      },
    })
  })

  it('rechaza una fecha externa de finalizacion invalida', () => {
    expectRule(AuctionRuleCode.InvalidFinalizationDate, () =>
      activeAuction().finish({ finishedAt: new Date(Number.NaN), leadingBid: null }),
    )
  })
})

describe('Rehidratacion durable de Auction HU-65', () => {
  const base = () => ({
    ...validInput(),
    id: 'auction-62-1',
    status: AuctionStatus.Active,
    closesAt: new Date('2026-09-22T12:00:00.000Z'),
    durationHours: 24 as const,
    publicationFeeCredits: 1,
    finishedAt: null,
    closingResult: null,
  })
  const winner = () => ({
    outcome: AuctionClosingOutcome.WithWinner,
    finishedAt: new Date('2026-09-22T12:00:00.000Z'),
    winnerId: 'winner',
    winningBidId: 'bid',
    finalAmountCredits: 35,
  })
  const finished = () => ({
    ...base(),
    status: AuctionStatus.Finished,
    finishedAt: winner().finishedAt,
    closingResult: winner(),
  })
  const expectInvalid = (input: unknown): void => {
    expect(() => Auction.rehydrate(input as RehydrateAuctionInput)).toThrow(AuctionRuleViolation)
  }
  it('rehidrata ACTIVE', () => {
    expect(Auction.rehydrate(base())).toMatchObject({
      status: AuctionStatus.Active,
      finishedAt: null,
      closingResult: null,
    })
  })
  it('rehidrata WITH_WINNER y conserva datos', () => {
    expect(Auction.rehydrate(finished()).closingResult).toEqual(winner())
  })
  it('rehidrata WITHOUT_BIDS', () => {
    expect(
      Auction.rehydrate({
        ...base(),
        status: AuctionStatus.Finished,
        finishedAt: new Date('2026-09-22T12:00:00.000Z'),
        closingResult: {
          outcome: AuctionClosingOutcome.WithoutBids,
          finishedAt: new Date('2026-09-22T12:00:00.000Z'),
          winnerId: null,
          winningBidId: null,
          finalAmountCredits: null,
        },
      }).closingResult?.outcome,
    ).toBe(AuctionClosingOutcome.WithoutBids)
  })
  it.each([
    { ...base(), finishedAt: new Date() },
    { ...base(), closingResult: winner() },
    { ...base(), status: AuctionStatus.Finished },
    { ...finished(), closingResult: { ...winner(), winningBidId: null } },
    { ...finished(), closingResult: { ...winner(), winnerId: null } },
    { ...finished(), closingResult: { ...winner(), finalAmountCredits: null } },
    { ...finished(), closingResult: { ...winner(), finalAmountCredits: 0 } },
    { ...finished(), closingResult: { ...winner(), finalAmountCredits: -1 } },
    {
      ...finished(),
      closingResult: {
        outcome: AuctionClosingOutcome.WithoutBids,
        finishedAt: new Date(),
        winnerId: 'x',
        winningBidId: null,
        finalAmountCredits: null,
      },
    },
    {
      ...finished(),
      closingResult: {
        outcome: AuctionClosingOutcome.WithoutBids,
        finishedAt: new Date(),
        winnerId: null,
        winningBidId: 'x',
        finalAmountCredits: null,
      },
    },
    {
      ...finished(),
      closingResult: {
        outcome: AuctionClosingOutcome.WithoutBids,
        finishedAt: new Date(),
        winnerId: null,
        winningBidId: null,
        finalAmountCredits: 1,
      },
    },
    { ...finished(), closingResult: { ...winner(), outcome: 'UNKNOWN' } },
  ])('rechaza snapshot invalido', expectInvalid)
  it('protege getters y doble cierre', () => {
    const auction = Auction.rehydrate(finished())
    const date = auction.finishedAt
    if (date === null) throw new Error('Expected finished date.')
    date.setUTCFullYear(2030)
    const result = auction.closingResult as unknown as { winnerId: string }
    result.winnerId = 'other'
    expect(auction.finishedAt).toEqual(winner().finishedAt)
    expect(auction.closingResult?.winnerId).toBe('winner')
    expectRule(AuctionRuleCode.AuctionAlreadyFinished, () =>
      auction.finish({ finishedAt: new Date('2026-09-23T12:00:00.000Z'), leadingBid: null }),
    )
  })
})
