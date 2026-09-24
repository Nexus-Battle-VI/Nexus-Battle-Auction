import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger'
import { FollowAuction } from '../../../application/use-cases/FollowAuction'
import { UnfollowAuction } from '../../../application/use-cases/UnfollowAuction'
import { ListFollowedAuctions } from '../../../application/use-cases/ListFollowedAuctions'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { WatchlistDto, FollowedAuctionsDto } from '../../../application/dto/WatchlistDto'
import { CurrentIdentity, Roles, AuthenticationRequired } from './auth/decorators'
import {
  FollowAuctionRequestDto,
  WatchlistParamsDto,
  WatchlistResponseDto,
  FollowedAuctionsResponseDto,
  assertEmptyWatchlistInput,
} from './watchlist.dto'
import { toWatchlistHttpException } from './watchlist-error.mapper'

/** Adaptador self-service; todos los casos reciben exclusivamente el subject verificado. */
@ApiTags('Auction Watchlist')
@ApiBearerAuth()
@AuthenticationRequired()
@Roles(Role.Player)
@ApiBadRequestResponse({ description: 'INVALID_REQUEST: solicitud fuera de contrato.' })
@ApiUnauthorizedResponse({ description: 'Token ausente/invalido o autenticacion deshabilitada.' })
@ApiForbiddenResponse({ description: 'Se requiere rol PLAYER.' })
@ApiServiceUnavailableResponse({
  description: 'WATCHLIST_UNAVAILABLE: persistencia no disponible.',
})
@Controller('v1/auctions/watchlist')
export class WatchlistController {
  constructor(
    private readonly follow: FollowAuction,
    private readonly unfollow: UnfollowAuction,
    private readonly list: ListFollowedAuctions,
  ) {}

  /** Crea la relacion propia; DTO global rechaza playerId y cualquier campo adicional. */
  @Post()
  @HttpCode(201)
  @ApiOperation({ operationId: 'followAuctionV1', summary: 'Seguir una subasta activa' })
  @ApiCreatedResponse({ type: WatchlistResponseDto })
  @ApiNotFoundResponse({ description: 'AUCTION_NOT_FOUND' })
  @ApiConflictResponse({ description: 'WATCHLIST_ALREADY_EXISTS' })
  @ApiUnprocessableEntityResponse({ description: 'AUCTION_NOT_FOLLOWABLE' })
  async create(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Body() body: FollowAuctionRequestDto,
    @Query() query: Record<string, unknown>,
  ): Promise<WatchlistDto> {
    try {
      assertEmptyWatchlistInput(query)
      return await this.follow.execute(identity.subject, body.auctionId)
    } catch (error: unknown) {
      throw toWatchlistHttpException(error)
    }
  }

  /** Lista unicamente el propietario del token, sin aceptar selectores de otro jugador. */
  @Get()
  @ApiOperation({
    operationId: 'listFollowedAuctionsV1',
    summary: 'Consultar mis subastas seguidas',
  })
  @ApiOkResponse({ type: FollowedAuctionsResponseDto })
  async findAll(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Query() query: Record<string, unknown>,
  ): Promise<FollowedAuctionsDto> {
    try {
      assertEmptyWatchlistInput(query)
      return await this.list.execute(identity.subject)
    } catch (error: unknown) {
      throw toWatchlistHttpException(error)
    }
  }

  /** Retirada idempotente que no revela ni modifica seguimientos ajenos. */
  @Delete(':auctionId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'unfollowAuctionV1', summary: 'Dejar de seguir una subasta' })
  @ApiNoContentResponse({ description: 'Seguimiento propio ausente tras la operacion.' })
  async remove(
    @CurrentIdentity() identity: VerifiedIdentity,
    @Param() params: WatchlistParamsDto,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<void> {
    try {
      assertEmptyWatchlistInput(query)
      assertEmptyWatchlistInput(body)
      await this.unfollow.execute(identity.subject, params.auctionId)
    } catch (error: unknown) {
      throw toWatchlistHttpException(error)
    }
  }
}
