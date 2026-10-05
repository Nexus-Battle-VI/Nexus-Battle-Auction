import type { AuctionMetricsRepositoryPort } from '../ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  averageHalfUp,
  periodEnvelope,
  resolveMetricsPeriod,
} from '../services/auction-metrics-period'
import type { UnavailableMetric } from './GetAuctionVolumeAndSuccess'

export interface AveragePricesQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/** Importe en creditos: numero con a lo sumo 2 decimales. */
export interface CreditsAmount {
  readonly unit: 'CREDITS'
  readonly amount: number
}

/** Importe en dinero real: entero en la unidad minima de SU moneda. */
export interface RealMoneyAmount {
  readonly unit: 'REAL_MONEY'
  readonly currency: string
  readonly amountMinor: number
}

export interface CurrencyPricesResponse {
  readonly currency: string
  readonly publishedCount: number
  readonly listedMinimumBid: {
    readonly average: RealMoneyAmount
    readonly min: RealMoneyAmount
    readonly max: RealMoneyAmount
  }
  readonly listedBuyNow: {
    readonly count: number
    readonly average: RealMoneyAmount | null
  }
}

export interface AveragePricesResponse {
  readonly definitionsVersion: string
  readonly period: ReturnType<typeof periodEnvelope>['period']
  readonly asOf: string
  readonly credits: {
    readonly basis: 'FINAL_SALE_PRICE'
    readonly salesCount: number
    readonly average: CreditsAmount | null
    readonly median: CreditsAmount | null
    readonly min: CreditsAmount | null
    readonly max: CreditsAmount | null
    readonly byChannel: {
      readonly AUCTION_CLOSE: {
        readonly salesCount: number
        readonly average: CreditsAmount | null
      }
      readonly BUY_NOW: {
        readonly salesCount: number
        readonly average: CreditsAmount | null
      }
    }
    readonly listedMinimumBid: {
      readonly auctionsCount: number
      readonly average: CreditsAmount | null
    }
  }
  readonly realMoney: {
    readonly basis: 'LISTED_PRICE'
    readonly note: string
    readonly finalSalePrice: UnavailableMetric
    readonly byCurrency: readonly CurrencyPricesResponse[]
  }
}

const CREDIT_DECIMALS = 2
const MINOR_DECIMALS = 0

const credits = (amount: number | null): CreditsAmount | null =>
  amount === null ? null : { unit: 'CREDITS', amount }

/**
 * HU-91.4 / CA-03. Precios promedio por moneda (contrato `hu-91.v1` §3.4 y §4.3).
 *
 * La separacion es estructural: `credits` (subastas de jugador) y `realMoney`
 * (oficiales) son ramas distintas y cada importe lleva su unidad; ningun campo
 * suma ni promedia entre ellas, ni entre monedas.
 *
 * - Creditos: PRECIO FINAL DE VENTA de lo cerrado en el periodo, con el cierre por
 *   subasta (`final_amount_credits`) y la compra inmediata (`price_credits`):
 *   omitir la segunda subestimaria el promedio. Las canceladas, las sin pujas y las
 *   activas no son una venta y no entran.
 * - Dinero real: solo PRECIO DE LISTA de lo publicado, por moneda. Las oficiales no
 *   tienen flujo de venta, asi que el precio final es `UNAVAILABLE` (no se inventa).
 * - Sin muestra los promedios son `null`, nunca 0. Creditos a 2 decimales y dinero
 *   real a entero de unidad minima, ambos half-up exacto.
 */
export class GetAuctionAveragePrices {
  constructor(
    private readonly repository: AuctionMetricsRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(query: AveragePricesQuery): Promise<AveragePricesResponse> {
    const asOf = this.clock.now()
    const period = resolveMetricsPeriod(query, asOf)
    const aggregate = await this.repository.getAveragePrices(period)

    const { sales, byChannel, listedMinimumBid } = aggregate.credits
    const averageOf = (stats: {
      readonly sum: number
      readonly count: number
    }): CreditsAmount | null => credits(averageHalfUp(stats.sum, stats.count, CREDIT_DECIMALS))

    return {
      ...periodEnvelope(period, asOf),
      credits: {
        basis: 'FINAL_SALE_PRICE',
        salesCount: sales.count,
        average: averageOf(sales),
        median: credits(sales.median),
        min: credits(sales.min),
        max: credits(sales.max),
        byChannel: {
          AUCTION_CLOSE: {
            salesCount: byChannel.AUCTION_CLOSE.count,
            average: averageOf(byChannel.AUCTION_CLOSE),
          },
          BUY_NOW: {
            salesCount: byChannel.BUY_NOW.count,
            average: averageOf(byChannel.BUY_NOW),
          },
        },
        listedMinimumBid: {
          auctionsCount: listedMinimumBid.count,
          average: averageOf(listedMinimumBid),
        },
      },
      realMoney: {
        basis: 'LISTED_PRICE',
        note: 'Subasta oficial no tiene flujo de venta: se reporta precio de publicación, no de transacción.',
        finalSalePrice: {
          availability: 'UNAVAILABLE',
          reason: 'OFFICIAL_AUCTION_HAS_NO_SALE_FLOW',
        },
        byCurrency: aggregate.realMoney.map((entry): CurrencyPricesResponse => {
          const minor = (amountMinor: number): RealMoneyAmount => ({
            unit: 'REAL_MONEY',
            currency: entry.currency,
            amountMinor,
          })
          const buyNowAverage = averageHalfUp(entry.buyNow.sum, entry.buyNow.count, MINOR_DECIMALS)
          const minimumBidAverage = averageHalfUp(
            entry.minimumBid.sum,
            entry.publishedCount,
            MINOR_DECIMALS,
          )
          if (minimumBidAverage === null) {
            throw new Error(`La moneda ${entry.currency} figura sin publicaciones.`)
          }
          return {
            currency: entry.currency,
            publishedCount: entry.publishedCount,
            listedMinimumBid: {
              average: minor(minimumBidAverage),
              min: minor(entry.minimumBid.min),
              max: minor(entry.minimumBid.max),
            },
            listedBuyNow: {
              count: entry.buyNow.count,
              average: buyNowAverage === null ? null : minor(buyNowAverage),
            },
          }
        }),
      },
    }
  }
}
