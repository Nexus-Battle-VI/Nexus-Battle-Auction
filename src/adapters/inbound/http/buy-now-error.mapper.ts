import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import { AuctionNotFoundError } from '../../../application/errors/BuyNowRequestError'
import {
  AuctionAlreadyClosedError,
  BuyNowIdempotencyConflictError,
} from '../../../application/errors/BuyNowTransactionError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import {
  BuyNowRuleCode,
  BuyNowRuleViolation,
  InsufficientCreditsViolation,
} from '../../../domain/errors/BuyNowRuleViolation'

const body = (statusCode: number, code: string, message: string, extra?: object) => ({
  statusCode,
  code,
  message,
  ...extra,
})

const BAD_REQUEST_CODES: ReadonlySet<BuyNowRuleCode> = new Set([
  BuyNowRuleCode.InvalidIdentifier,
  BuyNowRuleCode.InvalidPurchaseDate,
])

const CONFLICT_CODES: ReadonlySet<BuyNowRuleCode> = new Set([BuyNowRuleCode.AuctionNotActive])

const FORBIDDEN_CODES: ReadonlySet<BuyNowRuleCode> = new Set([
  BuyNowRuleCode.SellerCannotBuyOwnAuction,
])

export const toBuyNowHttpException = (error: unknown): HttpException => {
  if (error instanceof AuctionNotFoundError) {
    return new NotFoundException(body(404, 'AUCTION_NOT_FOUND', error.message))
  }
  if (
    error instanceof AuctionAlreadyClosedError ||
    error instanceof BuyNowIdempotencyConflictError
  ) {
    return new ConflictException(body(409, 'BUY_NOW_CONFLICT', error.message))
  }
  if (
    error instanceof ExternalDependencyUnavailableError ||
    error instanceof ExternalContractError
  ) {
    return new ServiceUnavailableException(body(503, 'DEPENDENCY_UNAVAILABLE', error.message))
  }
  if (error instanceof InsufficientCreditsViolation) {
    return new UnprocessableEntityException(
      body(422, error.code, error.message, { details: error.details }),
    )
  }
  if (error instanceof BuyNowRuleViolation) {
    if (FORBIDDEN_CODES.has(error.code)) {
      return new ForbiddenException(body(403, error.code, error.message))
    }
    if (CONFLICT_CODES.has(error.code)) {
      return new ConflictException(body(409, error.code, error.message))
    }
    if (BAD_REQUEST_CODES.has(error.code)) {
      return new BadRequestException(body(400, error.code, error.message))
    }
    return new UnprocessableEntityException(body(422, error.code, error.message))
  }
  return error instanceof HttpException ? error : new ServiceUnavailableException()
}
