import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger'

import { PublishAuction } from '../../../application/use-cases/PublishAuction'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CurrentIdentity, Roles } from './auth/decorators'
import { AuctionResponseDto, PublishAuctionRequestDto, assertIdempotencyKey } from './auction.dto'
import { toAuctionHttpException } from './auction-error.mapper'

@ApiTags('Auctions')
@ApiBearerAuth()
@Controller('v1/auctions')
export class AuctionController {
  constructor(private readonly publishAuction: PublishAuction) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Publicar un producto del jugador en subasta' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Identificador unico de hasta 128 caracteres para reintentos seguros.',
  })
  @ApiCreatedResponse({ type: AuctionResponseDto })
  @ApiBadRequestResponse({ description: 'Solicitud o Idempotency-Key invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'Rol insuficiente o vendedor sancionado.' })
  @ApiConflictResponse({ description: 'Limite activo o conflicto de idempotencia.' })
  @ApiUnprocessableEntityResponse({ description: 'Producto o precios no elegibles.' })
  @ApiServiceUnavailableResponse({ description: 'Dependencia requerida no disponible.' })
  async publish(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: PublishAuctionRequestDto,
  ): Promise<AuctionResponseDto> {
    try {
      const operationId = assertIdempotencyKey(idempotencyKey)
      return await this.publishAuction.execute({
        operationId,
        sellerId: identity.subject,
        productId: request.productId,
        durationHours: request.durationHours,
        minimumBidCredits: request.minimumBidCredits,
        buyNowCredits: request.buyNowCredits,
      })
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'INVALID_IDEMPOTENCY_KEY') {
        throw new BadRequestException({
          statusCode: 400,
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key es obligatorio y debe ser valido.',
        })
      }
      throw toAuctionHttpException(error)
    }
  }
}
