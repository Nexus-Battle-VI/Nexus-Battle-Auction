import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import {
  ActiveAuctionLimitExceededError,
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  InsufficientPublicationFundsError,
  PersistedAuctionNotFoundError,
  ProductNotEligibleForOfficialAuctionError,
} from '../../../application/errors/AuctionPersistenceError'
import {
  PendingClaimNotFoundError,
  PendingClaimOwnershipError,
} from '../../../application/errors/AuctionPendingClaimError'
import {
  BidCreditCompensationError,
  InsufficientBidCreditsError,
} from '../../../application/errors/BidCreditError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import {
  AuctionPendingClaimRuleCode,
  AuctionPendingClaimRuleViolation,
} from '../../../domain/errors/AuctionPendingClaimRuleViolation'
import { AuctionRuleCode, AuctionRuleViolation } from '../../../domain/errors/AuctionRuleViolation'
import { AutoBidRuleCode, AutoBidRuleViolation } from '../../../domain/errors/AutoBidRuleViolation'
import { BidRuleCode, BidRuleViolation } from '../../../domain/errors/BidRuleViolation'

const body = (statusCode: number, code: string, message: string) => ({
  statusCode,
  code,
  message,
})

export const toAuctionHttpException = (error: unknown): HttpException => {
  if (
    error instanceof ExternalDependencyUnavailableError ||
    error instanceof ExternalContractError
  ) {
    return new ServiceUnavailableException(body(503, 'DEPENDENCY_UNAVAILABLE', error.message))
  }

  if (error instanceof ExternalResourceNotFoundError) {
    return new UnprocessableEntityException(body(422, 'PRODUCT_NOT_ELIGIBLE', error.message))
  }

  if (error instanceof IdempotencyConflictError) {
    return new ConflictException(body(409, 'IDEMPOTENCY_CONFLICT', error.message))
  }

  if (error instanceof ActiveAuctionLimitExceededError) {
    return new ConflictException(
      body(409, AuctionRuleCode.ActiveAuctionLimitReached, error.message),
    )
  }

  if (error instanceof InsufficientPublicationFundsError) {
    return new UnprocessableEntityException(body(422, 'INSUFFICIENT_FUNDS', error.message))
  }

  if (error instanceof PersistedAuctionNotFoundError) {
    return new UnprocessableEntityException(body(422, 'AUCTION_NOT_FOUND', error.message))
  }

  if (error instanceof ProductNotEligibleForOfficialAuctionError) {
    return new UnprocessableEntityException(body(422, 'PRODUCT_NOT_ELIGIBLE', error.message))
  }

  if (error instanceof InsufficientBidCreditsError) {
    return new UnprocessableEntityException(body(422, 'INSUFFICIENT_BID_CREDITS', error.message))
  }

  if (error instanceof ConcurrentBidConflictError) {
    return new ConflictException(body(409, 'CONCURRENT_BID_CONFLICT', error.message))
  }

  if (error instanceof BidCreditCompensationError) {
    return new ServiceUnavailableException(
      body(503, 'BID_CREDIT_COMPENSATION_FAILED', error.message),
    )
  }

  if (error instanceof PendingClaimNotFoundError) {
    return new NotFoundException(body(404, 'PENDING_CLAIM_NOT_FOUND', error.message))
  }

  if (error instanceof PendingClaimOwnershipError) {
    return new ForbiddenException(body(403, 'PENDING_CLAIM_NOT_OWNED', error.message))
  }

  if (error instanceof AuctionPendingClaimRuleViolation) {
    if (error.code === AuctionPendingClaimRuleCode.AlreadyClaimed) {
      return new ConflictException(body(409, error.code, error.message))
    }

    return new UnprocessableEntityException(body(422, error.code, error.message))
  }

  if (error instanceof BidRuleViolation) {
    if (
      error.code === BidRuleCode.InvalidIdentifier ||
      error.code === BidRuleCode.InvalidBidAmount ||
      error.code === BidRuleCode.InvalidBidDate
    ) {
      return new BadRequestException(body(400, error.code, error.message))
    }

    if (
      error.code === BidRuleCode.BidCooldownActive ||
      error.code === BidRuleCode.ActiveBidLimitReached
    ) {
      return new ConflictException(body(409, error.code, error.message))
    }

    if (error.code === BidRuleCode.SellerCannotBid) {
      return new ForbiddenException(body(403, error.code, error.message))
    }

    return new UnprocessableEntityException(body(422, error.code, error.message))
  }

  if (error instanceof AutoBidRuleViolation) {
    if (
      error.code === AutoBidRuleCode.InvalidIdentifier ||
      error.code === AutoBidRuleCode.InvalidConfigurationDate
    ) {
      return new BadRequestException(body(400, error.code, error.message))
    }

    if (error.code === AutoBidRuleCode.SellerCannotConfigure) {
      return new ForbiddenException(body(403, error.code, error.message))
    }

    return new UnprocessableEntityException(body(422, error.code, error.message))
  }

  if (error instanceof AuctionRuleViolation) {
    if (error.code === AuctionRuleCode.SellerSanctioned) {
      return new ForbiddenException(body(403, error.code, error.message))
    }

    if (error.code === AuctionRuleCode.ActiveAuctionLimitReached) {
      return new ConflictException(body(409, error.code, error.message))
    }

    if (
      error.code === AuctionRuleCode.InvalidDuration ||
      error.code === AuctionRuleCode.InvalidIdentifier ||
      error.code === AuctionRuleCode.InvalidPublicationDate
    ) {
      return new BadRequestException(body(400, error.code, error.message))
    }

    return new UnprocessableEntityException(body(422, error.code, error.message))
  }

  return error instanceof HttpException ? error : new ServiceUnavailableException()
}
