import { DomainError } from './DomainError'

export enum AuctionRuleCode {
  InvalidIdentifier = 'INVALID_IDENTIFIER',
  InvalidDuration = 'INVALID_DURATION',
  InvalidCredits = 'INVALID_CREDITS',
  InvalidBuyNowPrice = 'INVALID_BUY_NOW_PRICE',
  UnsupportedCurrency = 'UNSUPPORTED_CURRENCY',
  ProductNotOwned = 'PRODUCT_NOT_OWNED',
  ProductInUse = 'PRODUCT_IN_USE',
  ProductNotTradable = 'PRODUCT_NOT_TRADABLE',
  SellerSanctioned = 'SELLER_SANCTIONED',
  ActiveAuctionLimitReached = 'ACTIVE_AUCTION_LIMIT_REACHED',
  InvalidPublicationDate = 'INVALID_PUBLICATION_DATE',
  InvalidFinalizationDate = 'INVALID_FINALIZATION_DATE',
  AuctionNotExpired = 'AUCTION_NOT_EXPIRED',
  AuctionAlreadyFinished = 'AUCTION_ALREADY_FINISHED',
  LeadingBidDoesNotBelongToAuction = 'LEADING_BID_DOES_NOT_BELONG_TO_AUCTION',
  InvalidMoney = 'INVALID_MONEY',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidOfficialMark = 'INVALID_OFFICIAL_MARK',
}

export class AuctionRuleViolation extends DomainError {
  constructor(
    readonly code: AuctionRuleCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuctionRuleViolation'
  }
}
