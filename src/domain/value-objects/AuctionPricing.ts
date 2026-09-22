import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'
import { Credits } from './Credits'

export enum AuctionCurrency {
  Credits = 'CREDITS',
  RealMoney = 'REAL_MONEY',
}

export interface AuctionPricingInput {
  currency: AuctionCurrency
  minimumBid: number
  buyNow?: number | null
}

export class AuctionPricing {
  private constructor(
    readonly minimumBid: Credits,
    readonly buyNow: Credits | null,
  ) {}

  static create(input: AuctionPricingInput): AuctionPricing {
    if (input.currency !== AuctionCurrency.Credits) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.UnsupportedCurrency,
        'Un jugador solo puede publicar subastas en creditos.',
      )
    }

    const minimumBid = Credits.positive(input.minimumBid, 'precio minimo')
    const buyNow =
      input.buyNow === undefined || input.buyNow === null
        ? null
        : Credits.positive(input.buyNow, 'precio de compra inmediata')

    if (buyNow !== null && !buyNow.isGreaterThan(minimumBid)) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidBuyNowPrice,
        'El precio de compra inmediata debe ser mayor que el precio minimo.',
      )
    }

    return new AuctionPricing(minimumBid, buyNow)
  }
}
