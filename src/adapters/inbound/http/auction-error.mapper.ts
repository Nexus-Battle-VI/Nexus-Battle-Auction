import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import {
  ActiveAuctionLimitExceededError,
  IdempotencyConflictError,
} from '../../../application/errors/AuctionPersistenceError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import { AuctionRuleCode, AuctionRuleViolation } from '../../../domain/errors/AuctionRuleViolation'

const body = (statusCode: number, code: string, message: string) => ({ statusCode, code, message })

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
