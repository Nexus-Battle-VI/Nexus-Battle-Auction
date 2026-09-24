import { DomainError } from './DomainError'

export enum AutoBidRuleCode {
  InvalidIdentifier = 'INVALID_IDENTIFIER',
  InvalidAutoBidLimit = 'INVALID_AUTO_BID_LIMIT',
  InvalidConfigurationDate = 'INVALID_CONFIGURATION_DATE',
  AuctionNotActive = 'AUCTION_NOT_ACTIVE',
  SellerCannotConfigure = 'SELLER_CANNOT_CONFIGURE_AUTO_BID',
}

export class AutoBidRuleViolation extends DomainError {
  constructor(
    readonly code: AutoBidRuleCode,
    message: string,
  ) {
    super(message)
    this.name = 'AutoBidRuleViolation'
  }
}
