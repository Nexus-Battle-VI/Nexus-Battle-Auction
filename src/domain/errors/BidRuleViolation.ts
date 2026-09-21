import { DomainError } from './DomainError'

export enum BidRuleCode {
  InvalidIdentifier = 'INVALID_IDENTIFIER',
  InvalidBidAmount = 'INVALID_BID_AMOUNT',
  AuctionNotActive = 'AUCTION_NOT_ACTIVE',
  SellerCannotBid = 'SELLER_CANNOT_BID',
  BidTooLow = 'BID_TOO_LOW',
  MinimumIncrementNotMet = 'MINIMUM_INCREMENT_NOT_MET',
  BidCooldownActive = 'BID_COOLDOWN_ACTIVE',
  ActiveBidLimitReached = 'ACTIVE_BID_LIMIT_REACHED',
  InvalidBidDate = 'INVALID_BID_DATE',
}

export class BidRuleViolation extends DomainError {
  constructor(
    readonly code: BidRuleCode,
    message: string,
  ) {
    super(message)
    this.name = 'BidRuleViolation'
  }
}
