import { BadRequestException, Controller, Get, Query } from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'

import { AuctionMetricsQueryError } from '../../../application/errors/AuctionMetricsError'
import {
  GetAuctionAveragePrices,
  type AveragePricesResponse,
} from '../../../application/use-cases/GetAuctionAveragePrices'
import {
  GetAuctionClosingTimeAndTrends,
  type ClosingTimeAndTrendsResponse,
} from '../../../application/use-cases/GetAuctionClosingTimeAndTrends'
import {
  GetAuctionProductRankings,
  type ProductRankingsResponse,
} from '../../../application/use-cases/GetAuctionProductRankings'
import {
  GetAuctionUsersAndCommissions,
  type UsersAndCommissionsResponse,
} from '../../../application/use-cases/GetAuctionUsersAndCommissions'
import {
  GetAuctionVolumeAndSuccess,
  type VolumeAndSuccessResponse,
} from '../../../application/use-cases/GetAuctionVolumeAndSuccess'
import { Role } from '../../../application/ports/TokenVerifierPort'
import { AuthenticationRequired, Roles } from './auth/decorators'
import {
  AuctionMetricsPeriodQueryDto,
  ClosingTimeAndTrendsQueryDto,
  ProductRankingsQueryDto,
  UsersAndCommissionsQueryDto,
} from './auction-metrics.dto'

const toMetricsHttpException = (error: unknown): Error => {
  if (error instanceof AuctionMetricsQueryError) {
    return new BadRequestException({ statusCode: 400, code: error.code, message: error.message })
  }
  return error instanceof Error ? error : new Error('Fallo desconocido de las metricas.')
}

/**
 * Metricas de Subasta (HU-91, contrato `hu-91.v1`).
 *
 * Controlador PROPIO bajo `v1/admin/auction-metrics`, no dentro de
 * `v1/auctions`: alli `GET :auctionId` capturaria cualquier segmento (R-12).
 *
 * CA-06: `@Roles(Role.Administrator)` (el `RolesGuard` ya admite al super
 * administrador por jerarquia) + `@AuthenticationRequired()`, que impide que el
 * modo local `AUTH_MODE=disabled` —donde la identidad anonima recibe TODOS los
 * roles— deje estas rutas abiertas. Los rechazos no incluyen datos agregados.
 */
@ApiTags('auction-metrics')
@ApiBearerAuth()
@AuthenticationRequired()
@Roles(Role.Administrator)
@Controller('v1/admin/auction-metrics')
export class AuctionMetricsController {
  constructor(
    private readonly getVolumeAndSuccess: GetAuctionVolumeAndSuccess,
    private readonly getClosingTimeAndTrends: GetAuctionClosingTimeAndTrends,
    private readonly getProductRankings: GetAuctionProductRankings,
    private readonly getAveragePrices: GetAuctionAveragePrices,
    private readonly getUsersAndCommissions: GetAuctionUsersAndCommissions,
  ) {}

  /** HU-91.2 / CA-01 (contrato §4.1). */
  @Get('volume-and-success')
  @ApiOperation({ summary: 'Volumen de subastas y tasa de exito' })
  @ApiOkResponse({ description: 'Volumen y tasa de exito del periodo (hu-91.v1 §4.1).' })
  @ApiBadRequestResponse({ description: 'INVALID_PERIOD o parametros fuera del contrato.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no es ADMINISTRATOR ni SUPER_ADMINISTRATOR.' })
  async volumeAndSuccess(
    @Query() query: AuctionMetricsPeriodQueryDto,
  ): Promise<VolumeAndSuccessResponse> {
    try {
      return await this.getVolumeAndSuccess.execute(query)
    } catch (error: unknown) {
      throw toMetricsHttpException(error)
    }
  }

  /** HU-91.3 / CA-02 (contrato §4.2). El nombre de producto es enriquecimiento de Catalog. */
  @Get('product-rankings')
  @ApiOperation({ summary: 'Productos mas subastados y mas vendidos' })
  @ApiOkResponse({
    description:
      'Rankings con enrichment COMPLETE, PARTIAL o UNAVAILABLE; Catalog caido no falla el endpoint (hu-91.v1 §4.2).',
  })
  @ApiBadRequestResponse({ description: 'INVALID_PERIOD o INVALID_PARAMETER (limit 1-50).' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no es ADMINISTRATOR ni SUPER_ADMINISTRATOR.' })
  async productRankings(@Query() query: ProductRankingsQueryDto): Promise<ProductRankingsResponse> {
    try {
      return await this.getProductRankings.execute(query)
    } catch (error: unknown) {
      throw toMetricsHttpException(error)
    }
  }

  /** HU-91.4 / CA-03 (contrato §4.3). Creditos y dinero real SIEMPRE en ramas distintas. */
  @Get('average-prices')
  @ApiOperation({ summary: 'Precios promedio por moneda' })
  @ApiOkResponse({
    description:
      'Precio final de venta en creditos y precio de lista por moneda en dinero real, sin mezclarlos (hu-91.v1 §4.3).',
  })
  @ApiBadRequestResponse({ description: 'INVALID_PERIOD o parametros fuera del contrato.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no es ADMINISTRATOR ni SUPER_ADMINISTRATOR.' })
  async averagePrices(
    @Query() query: AuctionMetricsPeriodQueryDto,
  ): Promise<AveragePricesResponse> {
    try {
      return await this.getAveragePrices.execute(query)
    } catch (error: unknown) {
      throw toMetricsHttpException(error)
    }
  }

  /**
   * HU-91.5 / CA-04 (contrato §4.4). `playerId` es el `sub` opaco, solo para ADMINISTRATOR
   * (decision D-2); la comision es solo la tarifa de publicacion, calculada desde Auction.
   */
  @Get('users-and-commissions')
  @ApiOperation({ summary: 'Usuarios activos y comisiones de publicacion' })
  @ApiOkResponse({
    description:
      'Usuarios activos (subastas distintas) y comision de publicacion bruta, reembolsada y neta (hu-91.v1 §4.4).',
  })
  @ApiBadRequestResponse({ description: 'INVALID_PERIOD o INVALID_PARAMETER (limit 1-50).' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no es ADMINISTRATOR ni SUPER_ADMINISTRATOR.' })
  async usersAndCommissions(
    @Query() query: UsersAndCommissionsQueryDto,
  ): Promise<UsersAndCommissionsResponse> {
    try {
      return await this.getUsersAndCommissions.execute(query)
    } catch (error: unknown) {
      throw toMetricsHttpException(error)
    }
  }

  /** HU-91.2 / CA-05 (contrato §4.5). */
  @Get('closing-time-and-trends')
  @ApiOperation({ summary: 'Tiempo de cierre y tendencias por periodo' })
  @ApiOkResponse({ description: 'Tiempo de cierre y serie por bucket (hu-91.v1 §4.5).' })
  @ApiBadRequestResponse({ description: 'INVALID_PERIOD o INVALID_PARAMETER.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no es ADMINISTRATOR ni SUPER_ADMINISTRATOR.' })
  async closingTimeAndTrends(
    @Query() query: ClosingTimeAndTrendsQueryDto,
  ): Promise<ClosingTimeAndTrendsResponse> {
    try {
      return await this.getClosingTimeAndTrends.execute(query)
    } catch (error: unknown) {
      throw toMetricsHttpException(error)
    }
  }
}
