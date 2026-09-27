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

import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { PublishOfficialAuction } from '../../../application/use-cases/PublishOfficialAuction'
import { CurrentIdentity, Roles } from './auth/decorators'
import { assertIdempotencyKey } from './auction.dto'
import { toAuctionHttpException } from './auction-error.mapper'
import {
  OfficialAuctionResponseDto,
  PublishOfficialAuctionRequestDto,
} from './official-auction.dto'

/**
 * Ruta exclusiva del Maestro de Juego (HU-66.5), separada de `POST /v1/auctions`
 * a proposito: mezclarlas arriesgaria que un cambio en la ruta de PLAYER
 * abriera, sin darse cuenta, una via de escalamiento hacia dinero real.
 */
@ApiTags('Official auctions')
@ApiBearerAuth()
@Controller('v1/official-auctions')
export class OfficialAuctionController {
  constructor(private readonly publishOfficialAuction: PublishOfficialAuction) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.GameMaster)
  @ApiOperation({
    summary: 'Publicar una subasta oficial de UPB-COMPANY en dinero real',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Identificador unico de hasta 128 caracteres para reintentos seguros.',
  })
  @ApiCreatedResponse({ type: OfficialAuctionResponseDto })
  @ApiBadRequestResponse({ description: 'Solicitud o Idempotency-Key invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({
    description: 'La identidad no es GAME_MASTER con el subject configurado.',
  })
  @ApiConflictResponse({ description: 'Conflicto de idempotencia.' })
  @ApiUnprocessableEntityResponse({
    description: 'El producto no es exclusivo, no esta publicable o los precios son invalidos.',
  })
  @ApiServiceUnavailableResponse({ description: 'Catalog no disponible o contrato invalido.' })
  async publish(
    @CurrentIdentity()
    identity: VerifiedIdentity,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    request: PublishOfficialAuctionRequestDto,
  ): Promise<OfficialAuctionResponseDto> {
    try {
      const operationId = assertIdempotencyKey(idempotencyKey)

      return await this.publishOfficialAuction.execute({
        operationId,

        publisherId: identity.subject,

        productId: request.productId,

        durationHours: request.durationHours,

        currency: request.currency,

        minimumBidAmountMinor: request.minimumBidAmountMinor,

        buyNowAmountMinor: request.buyNowAmountMinor,
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
