import type { AuctionMetricsRepositoryPort } from '../ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  periodEnvelope,
  ratioOrNull,
  resolveMetricsPeriod,
} from '../services/auction-metrics-period'

/** Indisponible explicito (patron de HU-89 `view-statistics`): nunca ceros inventados. */
export interface UnavailableMetric {
  readonly availability: 'UNAVAILABLE'
  readonly reason: string
}

export interface VolumeAndSuccessResponse {
  readonly definitionsVersion: string
  readonly period: ReturnType<typeof periodEnvelope>['period']
  readonly asOf: string
  readonly playerAuctions: {
    readonly currencyUnit: 'CREDITS'
    readonly published: number
    readonly closed: {
      readonly total: number
      readonly withWinner: number
      readonly soldByBuyNow: number
      readonly withoutBids: number
      readonly settlementFailedTerminal: number
    }
    readonly cancelled: number
    readonly active: number
    readonly awaitingClosure: number
    readonly successRate: {
      readonly numerator: number
      readonly denominator: number
      readonly value: number | null
      readonly formula: '(withWinner + soldByBuyNow) / closed.total'
      readonly excludes: readonly ['CANCELLED', 'ACTIVE']
    }
    readonly claims: {
      readonly createdInPeriod: number
      readonly pending: number
      readonly claimed: number
      readonly expired: number
    }
  }
  readonly officialAuctions: {
    readonly currencyUnit: 'REAL_MONEY'
    readonly published: number
    readonly byMark: { readonly OFFICIAL: number; readonly PREMIUM: number }
    readonly successRate: UnavailableMetric
  }
}

export interface VolumeAndSuccessQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/**
 * HU-91.2 / CA-01. Volumen y tasa de exito (contrato `hu-91.v1` §3.1 y §4.1).
 *
 * `tasa = (adjudicadas + compra inmediata) / cerradas` sobre subastas de
 * jugador cerradas por el mercado en el periodo. Las canceladas y las activas
 * quedan fuera del denominador; las oficiales (dinero real) no tienen flujo de
 * cierre y su tasa es `UNAVAILABLE` de forma permanente.
 */
export class GetAuctionVolumeAndSuccess {
  constructor(
    private readonly repository: AuctionMetricsRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(query: VolumeAndSuccessQuery): Promise<VolumeAndSuccessResponse> {
    const asOf = this.clock.now()
    const period = resolveMetricsPeriod(query, asOf)
    const { player, official } = await this.repository.getVolumeAndSuccess(period, asOf)

    const closedTotal = player.closedWithWinner + player.soldByBuyNow + player.closedWithoutBids
    const successes = player.closedWithWinner + player.soldByBuyNow

    return {
      ...periodEnvelope(period, asOf),
      playerAuctions: {
        currencyUnit: 'CREDITS',
        published: player.published,
        closed: {
          total: closedTotal,
          withWinner: player.closedWithWinner,
          soldByBuyNow: player.soldByBuyNow,
          withoutBids: player.closedWithoutBids,
          settlementFailedTerminal: player.settlementFailedTerminal,
        },
        cancelled: player.cancelled,
        active: player.active,
        awaitingClosure: player.awaitingClosure,
        successRate: {
          numerator: successes,
          denominator: closedTotal,
          value: ratioOrNull(successes, closedTotal),
          formula: '(withWinner + soldByBuyNow) / closed.total',
          excludes: ['CANCELLED', 'ACTIVE'],
        },
        claims: { ...player.claims },
      },
      officialAuctions: {
        currencyUnit: 'REAL_MONEY',
        published: official.published,
        byMark: { ...official.byMark },
        successRate: {
          availability: 'UNAVAILABLE',
          reason: 'OFFICIAL_AUCTION_HAS_NO_CLOSING_FLOW',
        },
      },
    }
  }
}
