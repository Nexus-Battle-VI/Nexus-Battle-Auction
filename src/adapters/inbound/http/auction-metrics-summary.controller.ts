import {
  BadRequestException,
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger'

import { AuctionMetricsQueryError } from '../../../application/errors/AuctionMetricsError'
import { Role } from '../../../application/ports/TokenVerifierPort'
import {
  AuctionMetricsUnavailableError,
  GetAuctionMetricsSummary,
  type MetricsSummaryResponse,
} from '../../../application/use-cases/GetAuctionMetricsSummary'
import { AuthenticationRequired, Roles } from './auth/decorators'
import { MetricsSummaryQueryDto } from './auction-metrics-summary.dto'

const toSummaryHttpException = (error: unknown): Error => {
  if (error instanceof AuctionMetricsQueryError) {
    return new BadRequestException({ statusCode: 400, code: error.code, message: error.message })
  }
  if (error instanceof AuctionMetricsUnavailableError) {
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'METRICS_UNAVAILABLE',
      message: error.message,
    })
  }
  return error instanceof Error ? error : new Error('Fallo desconocido de las metricas.')
}

/**
 * Consolidado de metricas de Subasta (HU-91.6, contrato `hu-91.v1` §4.6).
 *
 * Controlador PROPIO, aditivo: comparte el prefijo `v1/admin/auction-metrics` con
 * `AuctionMetricsController` pero no lo modifica. Solo lectura. Misma autorizacion que los
 * cinco endpoints existentes: `@Roles(Role.Administrator)` (el `RolesGuard` admite al super
 * administrador por jerarquia) + `@AuthenticationRequired()`, que impide que `AUTH_MODE=disabled`
 * deje la ruta abierta.
 */
@ApiTags('auction-metrics')
@ApiBearerAuth()
@AuthenticationRequired()
@Roles(Role.Administrator)
@Controller('v1/admin/auction-metrics')
export class AuctionMetricsSummaryController {
  constructor(private readonly getSummary: GetAuctionMetricsSummary) {}

  /**
   * Cinco secciones con UN periodo; una que falla queda DEGRADED y las demas siguen.
   * 503 solo si fallan todas.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Consolidado de metricas de subasta' })
  @ApiOkResponse({
    description:
      'Cinco secciones, cada una AVAILABLE o DEGRADED, sobre el mismo periodo (hu-91.v1 §4.6).',
  })
  @ApiBadRequestResponse({ description: 'INVALID_PERIOD o INVALID_PARAMETER.' })
  @ApiUnauthorizedResponse({ description: 'Access token ausente o invalido.' })
  @ApiForbiddenResponse({ description: 'La identidad no es ADMINISTRATOR ni SUPER_ADMINISTRATOR.' })
  @ApiServiceUnavailableResponse({ description: 'Ninguna seccion pudo calcularse.' })
  async summary(@Query() query: MetricsSummaryQueryDto): Promise<MetricsSummaryResponse> {
    try {
      return await this.getSummary.execute(query)
    } catch (error: unknown) {
      throw toSummaryHttpException(error)
    }
  }
}
