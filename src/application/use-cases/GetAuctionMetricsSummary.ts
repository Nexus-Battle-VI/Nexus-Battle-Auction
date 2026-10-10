import type { ClockPort } from '../ports/ClockPort'
import {
  periodEnvelope,
  resolveGranularity,
  resolveLimit,
  resolveMetricsPeriod,
} from '../services/auction-metrics-period'
import type { AveragePricesResponse, GetAuctionAveragePrices } from './GetAuctionAveragePrices'
import type {
  ClosingTimeAndTrendsResponse,
  GetAuctionClosingTimeAndTrends,
} from './GetAuctionClosingTimeAndTrends'
import type {
  GetAuctionProductRankings,
  ProductRankingsResponse,
} from './GetAuctionProductRankings'
import type {
  GetAuctionUsersAndCommissions,
  UsersAndCommissionsResponse,
} from './GetAuctionUsersAndCommissions'
import type {
  GetAuctionVolumeAndSuccess,
  VolumeAndSuccessResponse,
} from './GetAuctionVolumeAndSuccess'

export interface MetricsSummaryQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly limit?: string | undefined
  readonly granularity?: string | undefined
}

export const SUMMARY_SECTIONS = [
  'volumeAndSuccess',
  'closingTimeAndTrends',
  'productRankings',
  'averagePrices',
  'usersAndCommissions',
] as const

export type SummarySectionName = (typeof SUMMARY_SECTIONS)[number]

/** Motivo generico: nunca se filtra el mensaje de la excepcion original. */
export const SECTION_FAILED_REASON = 'SECTION_COMPUTATION_FAILED'

export type SummarySection<T> =
  | { readonly status: 'AVAILABLE'; readonly data: T }
  | { readonly status: 'DEGRADED'; readonly reason: typeof SECTION_FAILED_REASON }

export interface MetricsSummaryResponse {
  readonly definitionsVersion: string
  readonly period: ReturnType<typeof periodEnvelope>['period']
  readonly asOf: string
  readonly limit: number
  readonly granularity: 'DAY' | 'WEEK' | 'MONTH'
  readonly sections: {
    readonly volumeAndSuccess: SummarySection<VolumeAndSuccessResponse>
    readonly closingTimeAndTrends: SummarySection<ClosingTimeAndTrendsResponse>
    readonly productRankings: SummarySection<ProductRankingsResponse>
    readonly averagePrices: SummarySection<AveragePricesResponse>
    readonly usersAndCommissions: SummarySection<UsersAndCommissionsResponse>
  }
}

/** Todas las secciones fallaron: el consolidado no tiene nada que mostrar (HTTP 503). */
export class AuctionMetricsUnavailableError extends Error {
  constructor() {
    super('Ninguna seccion de metricas pudo calcularse.')
    this.name = 'AuctionMetricsUnavailableError'
  }
}

export type SectionFailureObserver = (section: SummarySectionName, error: unknown) => void

/**
 * HU-91.6. Consolidado de metricas (contrato `hu-91.v1` §4.6): orquesta los cinco casos de
 * uso existentes con UN solo periodo, para que la pantalla haga una llamada y todas las
 * secciones midan exactamente el mismo intervalo.
 *
 * Validacion primero: periodo, `limit` y `granularity` se validan antes de calcular nada, de
 * modo que un parametro invalido es siempre 400 y nunca una seccion DEGRADED.
 *
 * Aislamiento: cada seccion se resuelve de forma independiente (`Promise.allSettled`). Una
 * que falla queda `DEGRADED` con motivo generico y las demas siguen; solo si fallan TODAS se
 * lanza `AuctionMetricsUnavailableError`. El `enrichment` de Catalog caido NO degrada la
 * seccion de rankings: es parte de su contrato (§4.2) y la seccion sigue `AVAILABLE`.
 */
export class GetAuctionMetricsSummary {
  constructor(
    private readonly volumeAndSuccess: GetAuctionVolumeAndSuccess,
    private readonly closingTimeAndTrends: GetAuctionClosingTimeAndTrends,
    private readonly productRankings: GetAuctionProductRankings,
    private readonly averagePrices: GetAuctionAveragePrices,
    private readonly usersAndCommissions: GetAuctionUsersAndCommissions,
    private readonly clock: ClockPort,
    private readonly onSectionFailure: SectionFailureObserver = () => undefined,
  ) {}

  async execute(query: MetricsSummaryQuery): Promise<MetricsSummaryResponse> {
    const asOf = this.clock.now()
    const period = resolveMetricsPeriod(query, asOf)
    const limit = resolveLimit(query.limit)
    const granularity = resolveGranularity(query.granularity, period)

    // Periodo ya resuelto: las cinco secciones reciben las MISMAS fechas.
    const range = { from: period.from.toISOString(), to: period.to.toISOString() }

    const [volume, closing, rankings, prices, users] = await Promise.allSettled([
      this.volumeAndSuccess.execute(range),
      this.closingTimeAndTrends.execute({ ...range, granularity }),
      this.productRankings.execute({ ...range, limit: String(limit) }),
      this.averagePrices.execute(range),
      this.usersAndCommissions.execute({ ...range, limit: String(limit) }),
    ])

    const settled = {
      volumeAndSuccess: volume,
      closingTimeAndTrends: closing,
      productRankings: rankings,
      averagePrices: prices,
      usersAndCommissions: users,
    }

    const failed = SUMMARY_SECTIONS.filter((name) => settled[name].status === 'rejected')
    if (failed.length === SUMMARY_SECTIONS.length) {
      for (const name of failed) this.report(name, settled[name])
      throw new AuctionMetricsUnavailableError()
    }

    return {
      ...periodEnvelope(period, asOf),
      limit,
      granularity,
      sections: {
        volumeAndSuccess: this.toSection('volumeAndSuccess', volume),
        closingTimeAndTrends: this.toSection('closingTimeAndTrends', closing),
        productRankings: this.toSection('productRankings', rankings),
        averagePrices: this.toSection('averagePrices', prices),
        usersAndCommissions: this.toSection('usersAndCommissions', users),
      },
    }
  }

  private toSection<T>(
    name: SummarySectionName,
    result: PromiseSettledResult<T>,
  ): SummarySection<T> {
    if (result.status === 'fulfilled') return { status: 'AVAILABLE', data: result.value }
    this.report(name, result)
    return { status: 'DEGRADED', reason: SECTION_FAILED_REASON }
  }

  private report(name: SummarySectionName, result: PromiseSettledResult<unknown>): void {
    if (result.status === 'rejected') this.onSectionFailure(name, result.reason)
  }
}
