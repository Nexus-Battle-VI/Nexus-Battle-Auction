import {
  CLOSE_REASONS,
  type AuctionMetricsRepositoryPort,
  type CloseReason,
  type TrendGranularity,
} from '../ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  bucketStartsFor,
  nextBucketStart,
  periodEnvelope,
  ratioOrNull,
  resolveGranularity,
  resolveMetricsPeriod,
  roundSeconds,
} from '../services/auction-metrics-period'
import type { UnavailableMetric } from './GetAuctionVolumeAndSuccess'

export interface ClosingTimeAndTrendsQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly granularity?: string | undefined
}

export interface TrendBucketResponse {
  readonly bucketStart: string
  readonly bucketEnd: string
  readonly playerAuctions: {
    readonly published: number
    readonly closedWithWinner: number
    readonly soldByBuyNow: number
    readonly closedWithoutBids: number
    readonly cancelled: number
    readonly successRate: number | null
    readonly averageClosingTimeSeconds: number | null
  }
  readonly officialAuctions: { readonly published: number }
}

export interface ClosingTimeAndTrendsResponse {
  readonly definitionsVersion: string
  readonly period: ReturnType<typeof periodEnvelope>['period']
  readonly asOf: string
  readonly granularity: TrendGranularity
  readonly closingTime: {
    readonly definition: 'closed_at - published_at (playerAuctions CLOSED in period)'
    readonly unit: 'SECONDS'
    readonly sampleSize: number
    readonly average: number | null
    readonly median: number | null
    readonly p90: number | null
    readonly byCloseReason: Readonly<
      Record<CloseReason, { readonly sampleSize: number; readonly average: number | null }>
    >
    readonly settlementLagSeconds: {
      readonly sampleSize: number
      readonly average: number | null
      readonly p90: number | null
    }
    readonly officialAuctions: UnavailableMetric
  }
  readonly trends: {
    readonly bucketAnchors: {
      readonly published: 'published_at'
      readonly closedWithWinner: 'finished_at'
      readonly soldByBuyNow: 'auction_buy_now_operations.completed_at'
      readonly closedWithoutBids: 'finished_at'
      readonly cancelled: 'cancelled_at'
    }
    readonly buckets: readonly TrendBucketResponse[]
  }
}

/**
 * HU-91.2 / CA-05. Tiempo de cierre y tendencias (contrato `hu-91.v1` §3.3 y §4.5).
 *
 * El tiempo de cierre es `closed_at - published_at` del cierre EFECTIVO
 * persistido (`finished_at` o `completed_at` de la compra inmediata), no
 * `closes_at - published_at`, que siempre vale 24 h o 48 h. Los buckets son
 * contiguos y completos: los vacios llevan ceros y `null`.
 */
export class GetAuctionClosingTimeAndTrends {
  constructor(
    private readonly repository: AuctionMetricsRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(query: ClosingTimeAndTrendsQuery): Promise<ClosingTimeAndTrendsResponse> {
    const asOf = this.clock.now()
    const period = resolveMetricsPeriod(query, asOf)
    const granularity = resolveGranularity(query.granularity, period)

    const [closing, points] = await Promise.all([
      this.repository.getClosingTime(period),
      this.repository.getTrendPoints(period, granularity),
    ])

    const pointByStart = new Map(points.map((point) => [point.bucketStart.getTime(), point]))
    const buckets = bucketStartsFor(period, granularity).map((start): TrendBucketResponse => {
      const point = pointByStart.get(start.getTime())
      const withWinner = point?.closedWithWinner ?? 0
      const sold = point?.soldByBuyNow ?? 0
      const withoutBids = point?.closedWithoutBids ?? 0
      return {
        bucketStart: start.toISOString(),
        bucketEnd: nextBucketStart(start, granularity).toISOString(),
        playerAuctions: {
          published: point?.published ?? 0,
          closedWithWinner: withWinner,
          soldByBuyNow: sold,
          closedWithoutBids: withoutBids,
          cancelled: point?.cancelled ?? 0,
          successRate: ratioOrNull(withWinner + sold, withWinner + sold + withoutBids),
          averageClosingTimeSeconds: roundSeconds(point?.averageClosingSeconds ?? null),
        },
        officialAuctions: { published: point?.officialPublished ?? 0 },
      }
    })

    const byCloseReason = Object.fromEntries(
      CLOSE_REASONS.map((reason) => [
        reason,
        {
          sampleSize: closing.byCloseReason[reason].sampleSize,
          average: roundSeconds(closing.byCloseReason[reason].average),
        },
      ]),
    ) as ClosingTimeAndTrendsResponse['closingTime']['byCloseReason']

    return {
      ...periodEnvelope(period, asOf),
      granularity,
      closingTime: {
        definition: 'closed_at - published_at (playerAuctions CLOSED in period)',
        unit: 'SECONDS',
        sampleSize: closing.overall.sampleSize,
        average: roundSeconds(closing.overall.average),
        median: roundSeconds(closing.overall.median),
        p90: roundSeconds(closing.overall.p90),
        byCloseReason,
        settlementLagSeconds: {
          sampleSize: closing.settlementLag.sampleSize,
          average: roundSeconds(closing.settlementLag.average),
          p90: roundSeconds(closing.settlementLag.p90),
        },
        officialAuctions: {
          availability: 'UNAVAILABLE',
          reason: 'OFFICIAL_AUCTION_HAS_NO_CLOSING_FLOW',
        },
      },
      trends: {
        bucketAnchors: {
          published: 'published_at',
          closedWithWinner: 'finished_at',
          soldByBuyNow: 'auction_buy_now_operations.completed_at',
          closedWithoutBids: 'finished_at',
          cancelled: 'cancelled_at',
        },
        buckets,
      },
    }
  }
}
