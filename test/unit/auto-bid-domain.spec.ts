import { AuctionStatus } from '../../src/domain/entities/Auction'
import { AutoBidConfig } from '../../src/domain/entities/AutoBidConfig'
import { AutoBidRuleCode, AutoBidRuleViolation } from '../../src/domain/errors/AutoBidRuleViolation'
import { AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import { BidRuleViolation } from '../../src/domain/errors/BidRuleViolation'

const configuredAt = new Date('2026-09-21T12:00:10.000Z')

function validInput() {
  return {
    auctionId: 'auction-67-1',
    bidderId: 'bidder-1',
    maxAmountCredits: 100,
    configuredAt,
    eligibility: {
      auctionStatus: AuctionStatus.Active,
      sellerId: 'seller-1',
    },
  }
}

function expectRule(code: AutoBidRuleCode, action: () => unknown): void {
  try {
    action()
    throw new Error(`Se esperaba la regla ${code}.`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AutoBidRuleViolation)
    expect((error as AutoBidRuleViolation).code).toBe(code)
  }
}

describe('Dominio de configuracion de puja automatica HU-67', () => {
  it('configura una puja automatica valida', () => {
    const config = AutoBidConfig.configure(validInput())

    expect(config.snapshot()).toEqual({
      auctionId: 'auction-67-1',
      bidderId: 'bidder-1',
      maxAmountCredits: 100,
      configuredAt,
      isActive: true,
    })
  })

  it('queda activa al configurarse', () => {
    const config = AutoBidConfig.configure(validInput())

    expect(config.isActive).toBe(true)
  })

  it('rechaza una subasta no activa', () => {
    expectRule(AutoBidRuleCode.AuctionNotActive, () =>
      AutoBidConfig.configure({
        ...validInput(),
        eligibility: {
          ...validInput().eligibility,
          auctionStatus: 'CLOSED',
        },
      }),
    )
  })

  it('rechaza que el vendedor configure una puja automatica en su propia subasta', () => {
    expectRule(AutoBidRuleCode.SellerCannotConfigure, () =>
      AutoBidConfig.configure({
        ...validInput(),
        bidderId: 'seller-1',
      }),
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza limite maximo invalido %s',
    (maxAmountCredits) => {
      expectRule(AutoBidRuleCode.InvalidAutoBidLimit, () =>
        AutoBidConfig.configure({
          ...validInput(),
          maxAmountCredits,
        }),
      )
    },
  )

  it('acepta el limite maximo minimo valido de 1 credito', () => {
    const config = AutoBidConfig.configure({
      ...validInput(),
      maxAmountCredits: 1,
    })

    expect(config.maxAmount.value).toBe(1)
  })

  it('rechaza fecha de configuracion invalida', () => {
    expectRule(AutoBidRuleCode.InvalidConfigurationDate, () =>
      AutoBidConfig.configure({
        ...validInput(),
        configuredAt: new Date(Number.NaN),
      }),
    )
  })

  it('rechaza un auctionId invalido', () => {
    expect(() =>
      AutoBidConfig.configure({
        ...validInput(),
        auctionId: ' ',
      }),
    ).toThrow(AuctionRuleViolation)
  })

  it('rechaza un bidderId invalido', () => {
    expect(() =>
      AutoBidConfig.configure({
        ...validInput(),
        bidderId: ' ',
      }),
    ).toThrow(BidRuleViolation)
  })

  it('no expone referencia mutable de la fecha interna', () => {
    const config = AutoBidConfig.configure(validInput())

    const first = config.snapshot()
    first.configuredAt.setUTCFullYear(2030)

    const second = config.snapshot()
    expect(second.configuredAt).toEqual(configuredAt)
  })

  describe('AutoBidLimit.canAfford', () => {
    it('alcanza para un monto igual al limite', () => {
      const config = AutoBidConfig.configure(validInput())

      expect(config.maxAmount.canAfford(100)).toBe(true)
    })

    it('alcanza para un monto menor al limite', () => {
      const config = AutoBidConfig.configure(validInput())

      expect(config.maxAmount.canAfford(99)).toBe(true)
    })

    it('no alcanza para un monto mayor al limite', () => {
      const config = AutoBidConfig.configure(validInput())

      expect(config.maxAmount.canAfford(101)).toBe(false)
    })
  })
})
