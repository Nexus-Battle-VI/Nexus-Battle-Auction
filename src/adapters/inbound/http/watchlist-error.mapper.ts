import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { PersistedAuctionNotFoundError } from '../../../application/errors/AuctionPersistenceError'
import { WatchlistAlreadyExistsError } from '../../../application/errors/WatchlistAlreadyExistsError'
import { DomainError } from '../../../domain/errors/DomainError'
import { AuctionNotFollowableError } from '../../../domain/services/watchlist-eligibility'

/** Traduce errores conocidos; nunca expone SQL, credenciales ni mensajes internos. */
export const toWatchlistHttpException = (error: unknown): HttpException => {
  if (error instanceof HttpException) return error
  if (error instanceof PersistedAuctionNotFoundError)
    return new NotFoundException({
      statusCode: 404,
      code: 'AUCTION_NOT_FOUND',
      message: 'La subasta no existe.',
    })
  if (error instanceof WatchlistAlreadyExistsError)
    return new ConflictException({
      statusCode: 409,
      code: 'WATCHLIST_ALREADY_EXISTS',
      message: 'Ya sigues esta subasta.',
    })
  if (error instanceof AuctionNotFollowableError)
    return new UnprocessableEntityException({
      statusCode: 422,
      code: error.code,
      message: error.message,
    })
  if (error instanceof DomainError)
    return new BadRequestException({
      statusCode: 400,
      code: 'INVALID_REQUEST',
      message: 'Los datos de seguimiento no son validos.',
    })
  return new ServiceUnavailableException({
    statusCode: 503,
    code: 'WATCHLIST_UNAVAILABLE',
    message: 'No se pudo procesar el seguimiento. Intenta nuevamente.',
  })
}
