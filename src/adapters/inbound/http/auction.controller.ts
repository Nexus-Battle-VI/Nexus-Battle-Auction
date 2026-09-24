import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
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

import type { AuctionPendingClaimSnapshot } from '../../../application/ports/AuctionPendingClaimRepositoryPort'
import { CLOCK, type ClockPort } from '../../../application/ports/ClockPort'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { ClaimPendingProduct } from '../../../application/use-cases/ClaimPendingProduct'
import { ClaimPendingProductsBatch } from '../../../application/use-cases/ClaimPendingProductsBatch'
import { ConfigureAutoBid } from '../../../application/use-cases/ConfigureAutoBid'
import { GetAuctionDetail } from '../../../application/use-cases/GetAuctionDetail'
import { GetPendingClaims } from '../../../application/use-cases/GetPendingClaims'
import { PublishAuction } from '../../../application/use-cases/PublishAuction'
import { RegisterBid } from '../../../application/use-cases/RegisterBid'
import { CurrentIdentity, Roles } from './auth/decorators'
import {
  AuctionDetailResponseDto,
  AuctionResponseDto,
  AutoBidConfigResponseDto,
  BidResponseDto,
  ClaimPendingProductsBatchItemResponseDto,
  ClaimPendingProductsBatchRequestDto,
  ClaimPendingProductsBatchResponseDto,
  ConfigureAutoBidRequestDto,
  PendingClaimResponseDto,
  PublishAuctionRequestDto,
  RegisterBidRequestDto,
  assertIdempotencyKey,
} from './auction.dto'
import { toAuctionHttpException } from './auction-error.mapper'

const DAY_MS = 24 * 60 * 60 * 1000

@ApiTags('Auctions')
@ApiBearerAuth()
@Controller('v1/auctions')
export class AuctionController {
  constructor(
    private readonly publishAuction: PublishAuction,
    private readonly registerBid: RegisterBid,
    private readonly getAuctionDetail: GetAuctionDetail,
    private readonly configureAutoBid: ConfigureAutoBid,
    private readonly getPendingClaims: GetPendingClaims,
    private readonly claimPendingProduct: ClaimPendingProduct,
    private readonly claimPendingProductsBatch: ClaimPendingProductsBatch,
    @Inject(CLOCK)
    private readonly clock: ClockPort,
  ) {}

  /**
   * HU-69.2.
   *
   * Se registra antes de ":auctionId" solo por orden de lectura: al tener
   * dos segmentos ("me/pending-claims") nunca compite con la ruta de
   * detalle, que solo captura uno.
   */
  @Get('me/pending-claims')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Consultar los productos ganados pendientes de reclamo del titular autenticado',
  })
  @ApiOkResponse({
    type: PendingClaimResponseDto,
    isArray: true,
    description:
      'Productos ganados con reclamo aun abierto (CA-03: hasta el dia 7 desde settledAt).',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'La identidad no posee el rol requerido.',
  })
  async pendingClaims(
    @CurrentIdentity()
    identity: VerifiedIdentity,
  ): Promise<PendingClaimResponseDto[]> {
    const claims = await this.getPendingClaims.execute(identity.subject)
    const now = this.clock.now()

    return claims.map((claim) => this.toPendingClaimResponse(claim, now))
  }

  /**
   * HU-69.3.
   *
   * Idempotente ante reintentos: reclamar un producto ya CLAIMED devuelve
   * 200 con el estado actual en vez de fallar (ver ClaimPendingProduct).
   */
  @Post('me/pending-claims/:auctionId/claim')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Reclamar un producto ganado pendiente del titular autenticado',
  })
  @ApiParam({
    name: 'auctionId',
    required: true,
    description: 'Identificador de la subasta liquidada con ganador.',
    example: 'auction-123',
  })
  @ApiOkResponse({
    type: PendingClaimResponseDto,
    description: 'Reclamo confirmado (o ya confirmado previamente, de forma idempotente).',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'La identidad no posee el rol requerido o no es titular del reclamo.',
  })
  @ApiNotFoundResponse({
    description: 'No existe un producto pendiente de reclamo para esa subasta.',
  })
  @ApiConflictResponse({
    description: 'El reclamo cambio de estado de forma concurrente.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'El plazo de reclamo (CA-03) ya vencio.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Player-Inventory no disponible para confirmar la entrega.',
  })
  async claimPendingProductAction(
    @CurrentIdentity()
    identity: VerifiedIdentity,

    @Param('auctionId')
    auctionId: string,
  ): Promise<PendingClaimResponseDto> {
    try {
      const claim = await this.claimPendingProduct.execute({
        auctionId,
        winnerId: identity.subject,
      })

      return this.toPendingClaimResponse(claim, this.clock.now())
    } catch (error: unknown) {
      throw toAuctionHttpException(error)
    }
  }

  /**
   * HU-69.4.
   *
   * Nunca falla en bloque por un item individual: la respuesta siempre es
   * 200 con un resultado por auctionId (ver ClaimPendingProductsBatch). Solo
   * una solicitud invalida (sin autenticar, sin rol) da un error HTTP global.
   */
  @Post('me/pending-claims/claim-batch')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Reclamar en bloque los productos ganados pendientes del titular autenticado',
  })
  @ApiOkResponse({
    type: ClaimPendingProductsBatchResponseDto,
    description: 'Un resultado por auctionId solicitado (o por cada pendiente, con claimAll).',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'La identidad no posee el rol requerido.',
  })
  async claimPendingProductsBatchAction(
    @CurrentIdentity()
    identity: VerifiedIdentity,

    @Body()
    request: ClaimPendingProductsBatchRequestDto,
  ): Promise<ClaimPendingProductsBatchResponseDto> {
    const result = await this.claimPendingProductsBatch.execute(
      request.claimAll === true
        ? { winnerId: identity.subject, claimAll: true }
        : { winnerId: identity.subject, auctionIds: request.auctionIds ?? [] },
    )
    const now = this.clock.now()

    return {
      results: result.results.map((item): ClaimPendingProductsBatchItemResponseDto => ({
        auctionId: item.auctionId,
        status: item.status,
        claim: item.claim === null ? null : this.toPendingClaimResponse(item.claim, now),
        message: item.message,
      })),
    }
  }

  private toPendingClaimResponse(
    claim: AuctionPendingClaimSnapshot,
    now: Date,
  ): PendingClaimResponseDto {
    const remainingMs = claim.claimDeadline.getTime() - now.getTime()

    return {
      auctionId: claim.auctionId,
      productId: claim.productId,
      winningBidId: claim.winningBidId,
      finalAmountCredits: claim.finalAmountCredits,
      settledAt: claim.settledAt,
      claimDeadline: claim.claimDeadline,
      claimStatus: claim.claimStatus,
      remainingClaimDays: Math.max(0, Math.ceil(remainingMs / DAY_MS)),
      claimedAt: claim.claimedAt,
    }
  }

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

  @Post(':auctionId/auto-bid')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Configurar (o reconfigurar) una puja automatica en una subasta activa',
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
    type: AutoBidConfigResponseDto,
    description: 'Configuracion de puja automatica guardada correctamente.',
  })
  @ApiBadRequestResponse({
    description: 'Solicitud, limite maximo o Idempotency-Key invalidos.',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token ausente o invalido.',
  })
  @ApiForbiddenResponse({
    description: 'Rol insuficiente o el vendedor intenta configurar en su propia subasta.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Subasta no disponible o limite maximo invalido.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Dependencia requerida no disponible.',
  })
  async autoBid(
    @CurrentIdentity()
    identity: VerifiedIdentity,

    @Param('auctionId')
    auctionId: string,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    request: ConfigureAutoBidRequestDto,
  ): Promise<AutoBidConfigResponseDto> {
    try {
      assertIdempotencyKey(idempotencyKey)

      return await this.configureAutoBid.execute({
        auctionId,

        bidderId: identity.subject,

        maxAmountCredits: request.maxAmountCredits,
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
