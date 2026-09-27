import { AuctionStatus } from '../../src/domain/entities/Auction'
import { BuyNowAuction } from '../../src/domain/entities/BuyNowAuction'
import {
  BuyNowRuleCode,
  BuyNowRuleViolation,
  InsufficientCreditsViolation,
} from '../../src/domain/errors/BuyNowRuleViolation'
import {
  BuyNowDomainService,
  type BuyNowRequest,
} from '../../src/domain/services/BuyNowDomainService'
import {
  requireBuyNowPrice,
  requireConfirmation,
  requireSufficientBalance,
} from '../../src/domain/validators/BuyNowValidators'
import { BuyerId, CreditBalance } from '../../src/domain/value-objects/BuyNowValues'
import { Credits } from '../../src/domain/value-objects/Credits'

const requestedAt = new Date('2026-09-21T15:00:00.000Z')

function validRequest(overrides: Partial<BuyNowRequest> = {}): BuyNowRequest {
  return {
    buyerId: 'buyer-1',
    auction: {
      auctionId: 'auction-62-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      status: AuctionStatus.Active,
      buyNowCredits: 2500,
    },
    confirmed: true,
    buyerAvailableCredits: 5000,
    requestedAt,
    ...overrides,
  }
}

function auctionWith(overrides: Partial<BuyNowRequest['auction']> = {}): BuyNowAuction {
  return BuyNowAuction.from({ ...validRequest().auction, ...overrides })
}

function expectRule(code: BuyNowRuleCode, action: () => unknown): BuyNowRuleViolation {
  try {
    action()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BuyNowRuleViolation)
    expect((error as BuyNowRuleViolation).code).toBe(code)

    return error as BuyNowRuleViolation
  }

  throw new Error(`Se esperaba la regla ${code}.`)
}

describe('Entidad BuyNowAuction HU-64', () => {
  it('expone el precio y la disponibilidad de una subasta activa con precio', () => {
    const auction = auctionWith()

    expect(auction.isActive).toBe(true)
    expect(auction.isBuyNowAvailable).toBe(true)
    expect(auction.snapshot()).toEqual({
      auctionId: 'auction-62-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      status: 'ACTIVE',
      buyNowCredits: 2500,
      buyNowAvailable: true,
    })
  })

  it('no ofrece compra inmediata sin precio configurado', () => {
    const auction = auctionWith({ buyNowCredits: null })

    expect(auction.isBuyNowAvailable).toBe(false)
    expect(auction.snapshot().buyNowAvailable).toBe(false)
  })

  it('no ofrece compra inmediata si la subasta no esta activa', () => {
    const auction = auctionWith({ status: 'CLOSED' })

    expect(auction.isActive).toBe(false)
    expect(auction.isBuyNowAvailable).toBe(false)
  })

  it('normaliza los identificadores', () => {
    const auction = auctionWith({ auctionId: '  auction-62-1  ' })

    expect(auction.id.value).toBe('auction-62-1')
  })
})

describe('Validador de precio HU-64 (CA-03)', () => {
  it('devuelve el precio configurado como creditos', () => {
    expect(requireBuyNowPrice(auctionWith()).value).toBe(2500)
  })

  it('rechaza una subasta sin precio de compra inmediata', () => {
    expectRule(BuyNowRuleCode.BuyNowPriceUnavailable, () =>
      requireBuyNowPrice(auctionWith({ buyNowCredits: null })),
    )
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza el precio invalido %p',
    (price) => {
      expectRule(BuyNowRuleCode.InvalidBuyNowPrice, () =>
        requireBuyNowPrice(auctionWith({ buyNowCredits: price })),
      )
    },
  )
})

describe('Validador de confirmacion HU-64 (CA-04)', () => {
  it('acepta la confirmacion marcada', () => {
    expect(() => {
      requireConfirmation(true)
    }).not.toThrow()
  })

  it.each([false, undefined, null, 'true', 1])('rechaza la confirmacion %p', (value) => {
    expectRule(BuyNowRuleCode.ConfirmationRequired, () => {
      requireConfirmation(value as unknown as boolean)
    })
  })
})

describe('Validador de saldo HU-64 (CA-02)', () => {
  const price = Credits.positive(2500)

  it('devuelve el saldo restante tras la compra', () => {
    expect(requireSufficientBalance(price, CreditBalance.of(5000))).toBe(2500)
  })

  it('acepta un saldo exactamente igual al precio', () => {
    expect(requireSufficientBalance(price, CreditBalance.of(2500))).toBe(0)
  })

  it('rechaza un saldo insuficiente e informa cuanto falta', () => {
    const error = expectRule(BuyNowRuleCode.InsufficientCredits, () =>
      requireSufficientBalance(Credits.positive(3000), CreditBalance.of(2500)),
    )

    expect(error).toBeInstanceOf(InsufficientCreditsViolation)
    expect((error as InsufficientCreditsViolation).details).toEqual({
      requiredCredits: 3000,
      availableCredits: 2500,
      missingCredits: 500,
    })
  })

  it('rechaza el saldo cero', () => {
    const error = expectRule(BuyNowRuleCode.InsufficientCredits, () =>
      requireSufficientBalance(price, CreditBalance.of(0)),
    )

    expect((error as InsufficientCreditsViolation).details.missingCredits).toBe(2500)
  })
})

describe('Valores de compra inmediata HU-64', () => {
  it.each(['', '   ', '-buyer', 'buyer-', 'a'.repeat(129), 'buyer 1'])(
    'rechaza el buyerId %p',
    (value) => {
      expectRule(BuyNowRuleCode.InvalidIdentifier, () => BuyerId.create(value))
    },
  )

  it('normaliza y compara buyerId', () => {
    const buyer = BuyerId.create('  buyer-1 ')

    expect(buyer.value).toBe('buyer-1')
    expect(buyer.toString()).toBe('buyer-1')
    expect(buyer.equals(BuyerId.create('buyer-1'))).toBe(true)
    expect(buyer.equals(BuyerId.create('buyer-2'))).toBe(false)
  })

  it('acepta el saldo cero y rechaza saldos invalidos', () => {
    expect(CreditBalance.of(0).value).toBe(0)

    for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expectRule(BuyNowRuleCode.InvalidCreditBalance, () => CreditBalance.of(value))
    }
  })
})

describe('Servicio BuyNowDomainService HU-64', () => {
  const service = new BuyNowDomainService()

  it('aprueba una compra valida con los importes para la transaccion', () => {
    const approval = service.evaluate(validRequest())

    expect(approval).toEqual({
      auctionId: 'auction-62-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      buyerId: 'buyer-1',
      priceCredits: 2500,
      availableCredits: 5000,
      remainingCredits: 2500,
      requestedAt,
    })
  })

  it('no comparte la fecha de la solicitud con la aprobacion', () => {
    const request = validRequest()
    const approval = service.evaluate(request)

    expect(approval.requestedAt).not.toBe(request.requestedAt)
  })

  it('CA-03: rechaza una subasta sin precio de compra inmediata', () => {
    const request = validRequest()

    expectRule(BuyNowRuleCode.BuyNowPriceUnavailable, () =>
      service.evaluate({ ...request, auction: { ...request.auction, buyNowCredits: null } }),
    )
  })

  it('CA-04: rechaza la compra sin confirmacion', () => {
    expectRule(BuyNowRuleCode.ConfirmationRequired, () =>
      service.evaluate(validRequest({ confirmed: false })),
    )
  })

  it('CA-02: rechaza la compra con saldo insuficiente', () => {
    const error = expectRule(BuyNowRuleCode.InsufficientCredits, () =>
      service.evaluate(validRequest({ buyerAvailableCredits: 1000 })),
    )

    expect((error as InsufficientCreditsViolation).details.missingCredits).toBe(1500)
  })

  it('rechaza una subasta que ya no esta activa', () => {
    const request = validRequest()

    expectRule(BuyNowRuleCode.AuctionNotActive, () =>
      service.evaluate({ ...request, auction: { ...request.auction, status: 'CLOSED' } }),
    )
  })

  it('rechaza que el vendedor ejecute la compra inmediata de su propia subasta', () => {
    const request = validRequest()

    expectRule(BuyNowRuleCode.SellerCannotBuyOwnAuction, () =>
      service.evaluate({ ...request, buyerId: request.auction.sellerId }),
    )
  })

  it('rechaza una fecha de solicitud invalida', () => {
    expectRule(BuyNowRuleCode.InvalidPurchaseDate, () =>
      service.evaluate(validRequest({ requestedAt: new Date('no-es-fecha') })),
    )
  })

  it('rechaza un comprador o un saldo invalidos', () => {
    expectRule(BuyNowRuleCode.InvalidIdentifier, () =>
      service.evaluate(validRequest({ buyerId: ' ' })),
    )
    expectRule(BuyNowRuleCode.InvalidCreditBalance, () =>
      service.evaluate(validRequest({ buyerAvailableCredits: -5 })),
    )
  })

  describe('orden de las validaciones', () => {
    const failing = (): BuyNowRequest => {
      const request = validRequest({ confirmed: false, buyerAvailableCredits: 0 })

      return {
        ...request,
        auction: { ...request.auction, status: 'CLOSED', buyNowCredits: null },
      }
    }

    it('con todo mal, informa primero que la subasta no esta activa', () => {
      expectRule(BuyNowRuleCode.AuctionNotActive, () => service.evaluate(failing()))
    })

    it('activa pero comprada por el propio vendedor, informa eso antes que el precio', () => {
      const request = failing()

      expectRule(BuyNowRuleCode.SellerCannotBuyOwnAuction, () =>
        service.evaluate({
          ...request,
          buyerId: request.auction.sellerId,
          auction: { ...request.auction, status: 'ACTIVE' },
        }),
      )
    })

    it('activa pero sin precio, informa el precio antes que la confirmacion y el saldo', () => {
      const request = failing()

      expectRule(BuyNowRuleCode.BuyNowPriceUnavailable, () =>
        service.evaluate({ ...request, auction: { ...request.auction, status: 'ACTIVE' } }),
      )
    })

    it('con precio pero sin confirmar ni saldo, informa la confirmacion antes que el saldo', () => {
      const request = failing()

      expectRule(BuyNowRuleCode.ConfirmationRequired, () =>
        service.evaluate({
          ...request,
          auction: { ...request.auction, status: 'ACTIVE', buyNowCredits: 2500 },
        }),
      )
    })

    it('confirmada pero sin saldo, informa el saldo insuficiente', () => {
      const request = failing()

      expectRule(BuyNowRuleCode.InsufficientCredits, () =>
        service.evaluate({
          ...request,
          confirmed: true,
          auction: { ...request.auction, status: 'ACTIVE', buyNowCredits: 2500 },
        }),
      )
    })
  })
})
