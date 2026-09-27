import { DomainError } from './DomainError'

export enum BuyNowRuleCode {
  InvalidIdentifier = 'INVALID_IDENTIFIER',
  InvalidPurchaseDate = 'INVALID_PURCHASE_DATE',
  InvalidCreditBalance = 'INVALID_CREDIT_BALANCE',
  AuctionNotActive = 'AUCTION_NOT_ACTIVE',
  SellerCannotBuyOwnAuction = 'SELLER_CANNOT_BUY_OWN_AUCTION',
  BuyNowPriceUnavailable = 'BUY_NOW_PRICE_UNAVAILABLE',
  InvalidBuyNowPrice = 'INVALID_BUY_NOW_PRICE',
  ConfirmationRequired = 'CONFIRMATION_REQUIRED',
  InsufficientCredits = 'INSUFFICIENT_CREDITS',
}

/**
 * Detalle de un rechazo por saldo insuficiente (CA-02). Permite a la interfaz
 * mostrar cuantos creditos faltan sin recalcularlos.
 */
export interface InsufficientCreditsDetails {
  requiredCredits: number
  availableCredits: number
  missingCredits: number
}

export class BuyNowRuleViolation extends DomainError {
  constructor(
    readonly code: BuyNowRuleCode,
    message: string,
  ) {
    super(message)
    this.name = 'BuyNowRuleViolation'
  }
}

export class InsufficientCreditsViolation extends BuyNowRuleViolation {
  constructor(readonly details: InsufficientCreditsDetails) {
    super(
      BuyNowRuleCode.InsufficientCredits,
      'El comprador no tiene creditos suficientes para la compra inmediata.',
    )
    this.name = 'InsufficientCreditsViolation'
  }
}
