import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'
import { Credits } from './Credits'
import { Money, type MoneyInput } from './Money'

export enum AuctionPublisherType {
  Player = 'PLAYER',
  GameMaster = 'GAME_MASTER',
}

export enum AuctionPriceKind {
  Credits = 'CREDITS',
  RealMoney = 'REAL_MONEY',
}

export interface CreditsPriceInput {
  readonly kind: AuctionPriceKind.Credits
  readonly minimumBid: number
  readonly buyNow?: number | null
}

export interface RealMoneyPriceInput {
  readonly kind: AuctionPriceKind.RealMoney
  readonly minimumBid: MoneyInput
  readonly buyNow?: MoneyInput | null
}

export type AuctionPublicationPriceInput = CreditsPriceInput | RealMoneyPriceInput

export interface CreditsPrice {
  readonly kind: AuctionPriceKind.Credits
  readonly minimumBid: Credits
  readonly buyNow: Credits | null
}

export interface RealMoneyPrice {
  readonly kind: AuctionPriceKind.RealMoney
  readonly minimumBid: Money
  readonly buyNow: Money | null
}

export type AuctionPublicationPrice = CreditsPrice | RealMoneyPrice

/** Conserva alineados el tipo de publicador y la unidad de precio permitida. */
export function createAuctionPublicationPricing(
  publisherType: AuctionPublisherType,
  input: AuctionPublicationPriceInput,
): AuctionPublicationPrice {
  if (
    (publisherType === AuctionPublisherType.Player && input.kind !== AuctionPriceKind.Credits) ||
    (publisherType === AuctionPublisherType.GameMaster && input.kind !== AuctionPriceKind.RealMoney)
  ) {
    throw new AuctionRuleViolation(
      AuctionRuleCode.UnsupportedCurrency,
      'PLAYER solo admite creditos y GAME_MASTER solo admite dinero real.',
    )
  }

  if (input.kind === AuctionPriceKind.Credits) {
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
    return { kind: input.kind, minimumBid, buyNow }
  }

  const minimumBid = Money.positive(input.minimumBid, 'precio minimo')
  const buyNow =
    input.buyNow === undefined || input.buyNow === null
      ? null
      : Money.positive(input.buyNow, 'precio de compra inmediata')

  if (buyNow !== null && !buyNow.isGreaterThan(minimumBid)) {
    throw new AuctionRuleViolation(
      AuctionRuleCode.InvalidBuyNowPrice,
      'El precio de compra inmediata debe ser mayor que el precio minimo.',
    )
  }
  return { kind: input.kind, minimumBid, buyNow }
}
