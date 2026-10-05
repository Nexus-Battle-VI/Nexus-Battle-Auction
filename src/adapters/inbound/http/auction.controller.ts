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
  Query,
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
  ApiQuery,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger'

import type { AuctionPendingClaimSnapshot } from '../../../application/ports/AuctionPendingClaimRepositoryPort'
import { CLOCK, type ClockPort } from '../../../application/ports/ClockPort'
import { CancelAuction } from '../../../application/use-cases/CancelAuction'
import { ExecuteBuyNowUseCase } from '../../../application/use-cases/ExecuteBuyNowUseCase'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { ClaimPendingProduct } from '../../../application/use-cases/ClaimPendingProduct'
import { ClaimPendingProductsBatch } from '../../../application/use-cases/ClaimPendingProductsBatch'
import { ConfigureAutoBid } from '../../../application/use-cases/ConfigureAutoBid'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import { PriceSortRequiresCreditsError } from '../../../application/errors/MarketplaceQueryError'
import { GetAuctionBidHistory } from '../../../application/use-cases/GetAuctionBidHistory'
import { GetAuctionDetail } from '../../../application/use-cases/GetAuctionDetail'
import { GetAuctionSuggestions } from '../../../application/use-cases/GetAuctionSuggestions'
import { ListActiveAuctions } from '../../../application/use-cases/ListActiveAuctions'
import { GetPendingClaims } from '../../../application/use-cases/GetPendingClaims'
import { GetMyAuctionActivity } from '../../../application/use-cases/GetMyAuctionActivity'
import { GetMyAuctionTransactions } from '../../../application/use-cases/GetMyAuctionTransactions'
import { GetMyAuctionViewStatistics } from '../../../application/use-cases/GetMyAuctionViewStatistics'
import { PublishAuction } from '../../../application/use-cases/PublishAuction'
import { RegisterBid } from '../../../application/use-cases/RegisterBid'
import { CurrentIdentity, Roles } from './auth/decorators'
import {
  AuctionBidHistoryPageResponseDto,
  AuctionBidHistoryQueryDto,
  AuctionCancellationResponseDto,
  AuctionDetailResponseDto,
  ActiveAuctionPageResponseDto,
  AuctionResponseDto,
  AuctionSuggestionListResponseDto,
  AuctionSuggestionsQueryDto,
  AutoBidConfigResponseDto,
  BidResponseDto,
  ClaimPendingProductsBatchItemResponseDto,
  ClaimPendingProductsBatchRequestDto,
  ClaimPendingProductsBatchResponseDto,
  ConfigureAutoBidRequestDto,
  PendingClaimResponseDto,
  ListActiveAuctionsQueryDto,
  PersonalAuctionActivityQueryDto,
  PersonalAuctionPageResponseDto,
  PersonalBidPageResponseDto,
  PersonalTransactionPageResponseDto,
  AuctionViewStatisticsResponseDto,
  MARKETPLACE_PRICE_KINDS,
  MARKETPLACE_PUBLISHER_TYPES,
  MARKETPLACE_SORTS,
  PublishAuctionRequestDto,
  RegisterBidRequestDto,
  assertIdempotencyKey,
} from './auction.dto'
import { toAuctionHttpException } from './auction-error.mapper'
import { BuyNowRequestDto, BuyNowResponseDto } from './buy-now.dto'
import { toBuyNowHttpException } from './buy-now-error.mapper'

const DAY_MS = 24 * 60 * 60 * 1000

@ApiTags('Auctions')
@ApiBearerAuth()
@Controller('v1/auctions')
export class AuctionController {
  constructor(
    private readonly publishAuction: PublishAuction,
    private readonly registerBid: RegisterBid,
    private readonly getAuctionDetail: GetAuctionDetail,
    private readonly getAuctionBidHistory: GetAuctionBidHistory,
    private readonly listActiveAuctions: ListActiveAuctions,
    private readonly getAuctionSuggestions: GetAuctionSuggestions,
    private readonly configureAutoBid: ConfigureAutoBid,
    private readonly getPendingClaims: GetPendingClaims,
    private readonly claimPendingProduct: ClaimPendingProduct,
    private readonly claimPendingProductsBatch: ClaimPendingProductsBatch,
    @Inject(CLOCK)
    private readonly clock: ClockPort,
    private readonly executeBuyNow: ExecuteBuyNowUseCase,
    private readonly cancelAuction: CancelAuction,
    private readonly getMyAuctionActivity: GetMyAuctionActivity,
    private readonly getMyAuctionTransactions: GetMyAuctionTransactions,
    private readonly getMyAuctionViewStatistics: GetMyAuctionViewStatistics,
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

  /** HU-89 / TASK 89.1: publicaciones del titular del token. */
  @Get('me/owned')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Consultar mis subastas' })
  @ApiOkResponse({ type: PersonalAuctionPageResponseDto })
  @ApiBadRequestResponse({ description: 'Paginacion invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no posee el rol requerido.' })
  async ownedAuctions(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Query() query: PersonalAuctionActivityQueryDto,
  ): Promise<PersonalAuctionPageResponseDto> {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 16
    const result = await this.getMyAuctionActivity.listOwned({
      playerId: identity.subject,
      page,
      pageSize,
    })
    return { ...result, items: [...result.items], page, pageSize }
  }

  /** HU-89 / TASK 89.1: una fila por subasta en la que participo el titular. */
  @Get('me/bids')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Consultar mis participaciones en pujas' })
  @ApiOkResponse({ type: PersonalBidPageResponseDto })
  @ApiBadRequestResponse({ description: 'Paginacion invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no posee el rol requerido.' })
  async myBids(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Query() query: PersonalAuctionActivityQueryDto,
  ): Promise<PersonalBidPageResponseDto> {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 16
    const result = await this.getMyAuctionActivity.listBids({
      playerId: identity.subject,
      page,
      pageSize,
    })
    return { ...result, items: [...result.items], page, pageSize }
  }

  /** HU-89 / TASK 89.2: operaciones locales autoritativas del titular. */
  @Get('me/transactions')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Consultar mi historial de transacciones de subasta' })
  @ApiOkResponse({ type: PersonalTransactionPageResponseDto })
  @ApiBadRequestResponse({ description: 'Paginacion invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no posee el rol requerido.' })
  async myTransactions(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Query() query: PersonalAuctionActivityQueryDto,
  ): Promise<PersonalTransactionPageResponseDto> {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 16
    const result = await this.getMyAuctionTransactions.execute({
      playerId: identity.subject,
      page,
      pageSize,
    })
    return { ...result, items: [...result.items], page, pageSize }
  }

  /** HU-89 / TASK 89.3: ausencia explicita; nunca responde contadores inventados. */
  @Get('me/view-statistics')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Consultar disponibilidad de estadisticas reales de visualizacion' })
  @ApiOkResponse({ type: AuctionViewStatisticsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no posee el rol requerido.' })
  viewStatistics(): AuctionViewStatisticsResponseDto {
    return this.getMyAuctionViewStatistics.execute()
  }

  /** Marketplace de subastas activas y no vencidas. */
  @Get()
  @Roles(Role.Player, Role.GameMaster)
  @ApiOperation({ summary: 'Listar subastas activas disponibles' })
  @ApiQuery({ name: 'page', required: false, type: Number, minimum: 1, example: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
    example: 16,
  })
  @ApiQuery({ name: 'publisherType', required: false, enum: MARKETPLACE_PUBLISHER_TYPES })
  @ApiQuery({ name: 'priceKind', required: false, enum: MARKETPLACE_PRICE_KINDS })
  @ApiQuery({ name: 'hasBuyNow', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'sort', required: false, enum: MARKETPLACE_SORTS })
  @ApiQuery({ name: 'search', required: false, type: String, minLength: 1, maxLength: 80 })
  @ApiOkResponse({ type: ActiveAuctionPageResponseDto })
  @ApiBadRequestResponse({
    description:
      'Parametros de paginacion, filtro u orden invalidos; PRICE_SORT_REQUIRES_CREDITS si se ordena por precio sin priceKind=CREDITS.',
  })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no posee el rol requerido.' })
  async listActive(
    @Query() query: ListActiveAuctionsQueryDto,
  ): Promise<ActiveAuctionPageResponseDto> {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 16
    try {
      const result = await this.listActiveAuctions.execute({
        page,
        pageSize,
        filters: {
          publisherType: query.publisherType,
          priceKind: query.priceKind,
          hasBuyNow: query.hasBuyNow,
        },
        sort: query.sort,
        search: query.search,
      })
      return { ...result, page, pageSize, items: [...result.items] }
    } catch (error: unknown) {
      // Solo el orden por precio invalido (400) y Catalog caido durante una
      // busqueda (503) tienen traduccion; cualquier otro fallo se propaga igual
      // que antes de existir los filtros.
      throw error instanceof PriceSortRequiresCreditsError ||
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
        ? toAuctionHttpException(error)
        : error
    }
  }

  /**
   * HU-87.2.
   *
   * Declarada antes de ":auctionId" (igual que "me/pending-claims") para que
   * "suggestions" nunca se interprete como un id de subasta.
   */
  @Get('suggestions')
  @Roles(Role.Player, Role.GameMaster)
  @ApiOperation({ summary: 'Sugerencias de autocomplete para el marketplace' })
  @ApiQuery({ name: 'q', required: true, type: String, minLength: 3, maxLength: 80 })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 20,
    example: 8,
  })
  @ApiQuery({ name: 'publisherType', required: false, enum: MARKETPLACE_PUBLISHER_TYPES })
  @ApiQuery({ name: 'priceKind', required: false, enum: MARKETPLACE_PRICE_KINDS })
  @ApiQuery({ name: 'hasBuyNow', required: false, enum: ['true', 'false'] })
  @ApiOkResponse({ type: AuctionSuggestionListResponseDto })
  @ApiBadRequestResponse({
    description: 'q ausente, de menos de 3 o mas de 80 caracteres, o filtros invalidos.',
  })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no posee el rol requerido.' })
  @ApiServiceUnavailableResponse({ description: 'Catalog no disponible.' })
  async suggestions(
    @Query() query: AuctionSuggestionsQueryDto,
  ): Promise<AuctionSuggestionListResponseDto> {
    try {
      const result = await this.getAuctionSuggestions.execute({
        q: query.q,
        limit: query.limit ?? 8,
        filters: {
          publisherType: query.publisherType,
          priceKind: query.priceKind,
          hasBuyNow: query.hasBuyNow,
        },
      })
      return { items: [...result.items] }
    } catch (error: unknown) {
      // Igual que el listado: solo Catalog caido tiene traduccion (503); el
      // resto se propaga igual que antes de existir este endpoint.
      throw error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
        ? toAuctionHttpException(error)
        : error
    }
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
      bidCount: detail.bidCount,
      sellerDisplayName: detail.sellerDisplayName,
      sellerAvatarUrl: detail.sellerAvatarUrl,
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

  /**
   * HU-88.
   *
   * Historial publico y paginado de pujas. Nunca expone `bidderId`: no existe
   * todavia una regla de anonimizacion aprobada, asi que mientras tanto el
   * minimo dato necesario es el monto y el momento de cada puja.
   *
   * Mismo rol que el detalle (`Role.Player`): no se amplian permisos en este
   * incremento.
   */
  @Get(':auctionId/bids')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Consultar el historial publico y paginado de pujas de una subasta',
  })
  @ApiParam({
    name: 'auctionId',
    required: true,
    description: 'Identificador de la subasta.',
    example: 'auction-123',
  })
  @ApiOkResponse({
    type: AuctionBidHistoryPageResponseDto,
    description: 'Pagina del historial de pujas, ordenado por fecha ascendente.',
  })
  @ApiBadRequestResponse({
    description: 'page/pageSize invalidos o un parametro desconocido.',
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
  async bidHistory(
    @Param('auctionId')
    auctionId: string,

    @Query()
    query: AuctionBidHistoryQueryDto,
  ): Promise<AuctionBidHistoryPageResponseDto> {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20

    const result = await this.getAuctionBidHistory.execute({ auctionId, page, pageSize })

    if (result === null) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'AUCTION_NOT_FOUND',
        message: 'La subasta solicitada no existe.',
      })
    }

    return {
      items: result.items.map((item) => ({ ...item })),
      total: result.total,
      page,
      pageSize,
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

  @Post(':auctionId/buy-now')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Ejecutar la compra inmediata de una subasta activa' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Identificador unico de hasta 128 caracteres para reintentos seguros.',
  })
  @ApiOkResponse({ type: BuyNowResponseDto })
  @ApiBadRequestResponse({ description: 'Solicitud o Idempotency-Key invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({
    description: 'Rol insuficiente o el vendedor intento comprar su propia subasta.',
  })
  @ApiNotFoundResponse({ description: 'La subasta no existe.' })
  @ApiConflictResponse({
    description: 'La subasta ya no esta activa o la operacion ya se uso con otros datos.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin precio de compra inmediata (CA-03), sin confirmar (CA-04) o creditos insuficientes (CA-02).',
  })
  @ApiServiceUnavailableResponse({ description: 'Dependencia requerida no disponible.' })
  async buyNow(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Param('auctionId') auctionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: BuyNowRequestDto,
  ): Promise<BuyNowResponseDto> {
    try {
      const operationId = assertIdempotencyKey(idempotencyKey)
      return await this.executeBuyNow.execute({
        operationId,
        buyerId: identity.subject,
        auctionId,
        confirmed: request.confirmed,
      })
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'INVALID_IDEMPOTENCY_KEY') {
        throw new BadRequestException({
          statusCode: 400,
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key es obligatorio y debe ser valido.',
        })
      }
      throw toBuyNowHttpException(error)
    }
  }

  /**
   * HU-90, `7.7.10`. Cancelacion manual del vendedor propietario (ACTIVE,
   * sin pujas, mas de 6h para el cierre). La cancelacion automatica por
   * sancion (CA-05) no tiene endpoint: la ejecuta el sondeo interno.
   */
  @Post(':auctionId/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Cancelar manualmente una subasta activa propia' })
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
  @ApiOkResponse({ type: AuctionCancellationResponseDto })
  @ApiBadRequestResponse({ description: 'Idempotency-Key invalida.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({
    description: 'Rol insuficiente o la identidad no es el vendedor propietario.',
  })
  @ApiNotFoundResponse({ description: 'La subasta no existe.' })
  @ApiConflictResponse({
    description:
      'La subasta ya no esta activa (incluida una cancelacion ya confirmada), tiene pujas registradas, o la operacion ya se uso con otros datos.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Faltan 6 horas o menos para el cierre (7.7.10).',
  })
  @ApiServiceUnavailableResponse({ description: 'Dependencia requerida no disponible.' })
  async cancel(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Param('auctionId') auctionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AuctionCancellationResponseDto> {
    try {
      const operationId = assertIdempotencyKey(idempotencyKey)
      const result = await this.cancelAuction.execute({
        operationId,
        auctionId,
        sellerId: identity.subject,
      })
      return {
        auctionId: result.auction.id,
        status: result.auction.status,
        cancelledAt: result.cancellation.cancelledAt,
        refundAmountCredits: result.cancellation.refundAmountCredits,
        walletRefundStatus: result.cancellation.walletRefundStatus,
        inventoryReleaseStatus: result.cancellation.inventoryReleaseStatus,
        replayed: result.replayed,
      }
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
