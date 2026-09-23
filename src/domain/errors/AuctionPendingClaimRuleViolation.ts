import { DomainError } from './DomainError'

export enum AuctionPendingClaimRuleCode {
  InvalidIdentifier = 'INVALID_IDENTIFIER',
  InvalidAmount = 'INVALID_AMOUNT',
  InvalidSettledAt = 'INVALID_SETTLED_AT',
  InvalidCreatedAt = 'INVALID_CREATED_AT',
  InvalidUpdatedAt = 'INVALID_UPDATED_AT',
  InvalidClaimedAt = 'INVALID_CLAIMED_AT',
  InvalidTransitionDate = 'INVALID_TRANSITION_DATE',
  InvalidStatus = 'INVALID_STATUS',
  ClaimDeadlineExpired = 'CLAIM_DEADLINE_EXPIRED',
  ClaimPeriodStillOpen = 'CLAIM_PERIOD_STILL_OPEN',
  AlreadyClaimed = 'ALREADY_CLAIMED',
  AlreadyExpired = 'ALREADY_EXPIRED',
}

export class AuctionPendingClaimRuleViolation extends DomainError {
  constructor(
    readonly code: AuctionPendingClaimRuleCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuctionPendingClaimRuleViolation'
  }
}
