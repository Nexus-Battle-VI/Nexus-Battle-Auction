import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger'

import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { GetAuctionDetail } from '../../../application/use-cases/GetAuctionDetail'
import { PublishAuction } from '../../../application/use-cases/PublishAuction'
import { RegisterBid } from '../../../application/use-cases/RegisterBid'
import { CurrentIdentity, Roles } from './auth/decorators'
import {
  AuctionDetailResponseDto,
  AuctionResponseDto,
  BidResponseDto,
  PublishAuctionRequestDto,
  RegisterBidRequestDto,
  assertIdempotencyKey,
} from './auction.dto'
import { toAuctionHttpException } from './auction-error.mapper'

@ApiTags('Auctions')
@ApiBearerAuth()
@Controller('v1/auctions')
export class AuctionController {
  constructor(
    private readonly publishAuction: PublishAuction,
    private readonly registerBid: RegisterBid,
    private readonly getAuctionDetail: GetAuctionDetail,
  ) {}

  /**
   * HU-63.6.
   *
   * Proporciona a la Web la informacion necesaria
   * para presentar una subasta sin duplicar reglas
   * de negocio en el cliente.
   */
  @Get(':auctionId')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Consultar detalle y oferta lider de una subasta',
  })
  @ApiParam({
    name: 'auctionId',
    required: true,
    description: 'Identificador de la subasta.',
    example: 'auction-123',
  })
  @ApiOkResponse({
    type: AuctionDetailResponseDto,
    description: 'Detalle actual de la subasta.',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'La identidad no posee el rol requerido.',
  })
  @ApiNotFoundResponse({
    description: 'La subasta solicitada no existe.',
  })
  async detail(
    @Param('auctionId')
    auctionId: string,
  ): Promise<AuctionDetailResponseDto> {
    const detail = await this.getAuctionDetail.execute(auctionId)

    if (detail === null) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'AUCTION_NOT_FOUND',
        message: 'La subasta solicitada no existe.',
      })
    }

    return {
      ...detail.auction,
      currentBid: detail.currentBid,
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Publicar un producto del jugador en subasta',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Identificador unico de hasta 128 caracteres para reintentos seguros.',
  })
  @ApiCreatedResponse({
    type: AuctionResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Solicitud o Idempotency-Key invalida.',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'Rol insuficiente o vendedor sancionado.',
  })
  @ApiConflictResponse({
    description: 'Limite activo o conflicto de idempotencia.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Producto o precios no elegibles.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Dependencia requerida no disponible.',
  })
  async publish(
    @CurrentIdentity()
    identity: VerifiedIdentity,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    request: PublishAuctionRequestDto,
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

  @Post(':auctionId/bids')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Registrar una puja en una subasta activa',
  })
  @ApiParam({
    name: 'auctionId',
    required: true,
    description: 'Identificador de la subasta.',
    example: 'auction-123',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Identificador unico de hasta 128 caracteres para reintentos seguros.',
  })
  @ApiCreatedResponse({
    type: BidResponseDto,
    description: 'Puja registrada correctamente.',
  })
  @ApiBadRequestResponse({
    description: 'Solicitud, identificadores, monto o Idempotency-Key invalidos.',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'Rol insuficiente o el jugador intenta pujar en su propia subasta.',
  })
  @ApiConflictResponse({
    description: 'Cooldown, limite de pujas, concurrencia o conflicto de idempotencia.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Subasta no disponible, monto insuficiente, incremento invalido o creditos insuficientes.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Dependencia requerida no disponible o compensacion de creditos fallida.',
  })
  async bid(
    @CurrentIdentity()
    identity: VerifiedIdentity,

    @Param('auctionId')
    auctionId: string,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    request: RegisterBidRequestDto,
  ): Promise<BidResponseDto> {
    try {
      const operationId = assertIdempotencyKey(idempotencyKey)

      return await this.registerBid.execute({
        operationId,

        auctionId,

        bidderId: identity.subject,

        amountCredits: request.amountCredits,
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
