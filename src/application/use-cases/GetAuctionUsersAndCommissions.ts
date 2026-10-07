import { AuctionDuration } from '../../domain/value-objects/AuctionDuration'
import type {
  ActiveUserEntry,
  AuctionMetricsRepositoryPort,
  DurationFeeAggregate,
} from '../ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  periodEnvelope,
  resolveLimit,
  resolveMetricsPeriod,
} from '../services/auction-metrics-period'
import type { UnavailableMetric } from './GetAuctionVolumeAndSuccess'

export interface UsersAndCommissionsQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly limit?: string | undefined
}

/** Importe en creditos: numero con a lo sumo 2 decimales; puede ser negativo (`net`). */
export interface CreditsAmount {
  readonly unit: 'CREDITS'
  readonly amount: number
}

export interface ActiveUserResponse extends ActiveUserEntry {
  readonly rank: number
}

export interface UsersAndCommissionsResponse {
  readonly definitionsVersion: string
  readonly period: ReturnType<typeof periodEnvelope>['period']
  readonly asOf: string
  readonly limit: number
  readonly activeUsers: {
    readonly definition: 'DISTINCT_AUCTIONS_WITH_SELLER_BIDDER_OR_BUYER_ACTION'
    readonly totalActiveUsers: number
    readonly byRole: {
      readonly sellers: number
      readonly bidders: number
      readonly buyers: number
    }
    readonly top: readonly {
      readonly rank: number
      readonly playerId: string
      readonly activeAuctions: number
      readonly asSeller: number
      readonly asBidder: number
      readonly asBuyer: number
    }[]
  }
  readonly commissions: {
    readonly scope: 'PUBLICATION_FEE_ONLY'
    readonly unit: 'CREDITS'
    readonly source: 'AUCTION_LOCAL'
    readonly gross: CreditsAmount
    readonly refunded: CreditsAmount
    readonly net: CreditsAmount
    readonly pendingRefunds: { readonly count: number; readonly amount: CreditsAmount }
    readonly byDuration: readonly {
      readonly durationHours: number
      readonly auctions: number
      readonly feePerAuction: number
      readonly gross: CreditsAmount
    }[]
    readonly salesCommission: UnavailableMetric
    readonly realMoneyCommission: UnavailableMetric
    readonly walletReconciliation: UnavailableMetric
  }
}

/** Duraciones permitidas por el dominio: el contrato siempre lista ambas. */
const DURATIONS_HOURS = [24, 48] as const

const HUNDREDTHS = 100n

/** Centesimas de credito (entero exacto) -> importe. Division por 100 de un entero pequeno: exacta en JSON. */
const credits = (hundredths: bigint): CreditsAmount => ({
  unit: 'CREDITS',
  amount: Number(hundredths) / Number(HUNDREDTHS),
})

/**
 * HU-91.5 / CA-04. Usuarios activos y comisiones de publicacion
 * (contrato `hu-91.v1` §3.2, §3.4 y §4.4).
 *
 * USUARIOS. Un usuario activo es un `sub` con al menos una accion de mercado
 * (publicar, pujar o comprar de inmediato) en una subasta de JUGADOR dentro del
 * periodo; su grado es el numero de SUBASTAS distintas, no de pujas. `playerId` es el
 * `sub` opaco: ni nombre ni correo (decision D-2).
 *
 * COMISIONES. La unica comision de Subasta es la tarifa de publicacion (1 credito a
 * 24 h, 3 a 48 h), calculada desde las tablas de Auction: bruto (publicaciones del
 * periodo) menos reembolsos CONFIRMADOS (cancelaciones del periodo). Las cancelaciones
 * automaticas (HU-90 CA-05) no reembolsan: su estado es `NOT_REQUIRED` y no entran ni
 * en reembolsado ni en pendiente, asi que su comision sigue en el neto. No existe
 * comision por venta ni en dinero real, y Wallet no tiene lectura: `UNAVAILABLE`.
 *
 * Sin datos, las SUMAS valen 0 (no `null`: 0 es el valor verdadero de una suma vacia,
 * a diferencia de un promedio) y las listas salen vacias. Todo el calculo de importes
 * usa centesimas enteras con `BigInt`: sin coma flotante.
 */
export class GetAuctionUsersAndCommissions {
  constructor(
    private readonly repository: AuctionMetricsRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(query: UsersAndCommissionsQuery): Promise<UsersAndCommissionsResponse> {
    const asOf = this.clock.now()
    const period = resolveMetricsPeriod(query, asOf)
    const limit = resolveLimit(query.limit)

    const { activeUsers, commissions } = await this.repository.getUsersAndCommissions(period, limit)

    const feeOf = (durations: readonly DurationFeeAggregate[]): bigint =>
      durations.reduce((sum, row) => sum + BigInt(row.feeCredits) * HUNDREDTHS, 0n)
    const gross = feeOf(commissions.byDuration)
    const refunded = BigInt(Math.round(commissions.refunded.hundredths))
    const pending = BigInt(Math.round(commissions.pending.hundredths))

    return {
      ...periodEnvelope(period, asOf),
      limit,
      activeUsers: {
        definition: 'DISTINCT_AUCTIONS_WITH_SELLER_BIDDER_OR_BUYER_ACTION',
        totalActiveUsers: activeUsers.totalActiveUsers,
        byRole: { ...activeUsers.byRole },
        top: activeUsers.top.map((user, index) => ({
          rank: index + 1,
          playerId: user.playerId,
          activeAuctions: user.activeAuctions,
          asSeller: user.asSeller,
          asBidder: user.asBidder,
          asBuyer: user.asBuyer,
        })),
      },
      commissions: {
        scope: 'PUBLICATION_FEE_ONLY',
        unit: 'CREDITS',
        source: 'AUCTION_LOCAL',
        gross: credits(gross),
        refunded: credits(refunded),
        net: credits(gross - refunded),
        pendingRefunds: {
          count: commissions.pending.count,
          amount: credits(pending),
        },
        byDuration: DURATIONS_HOURS.map((durationHours) => {
          const row = commissions.byDuration.find((entry) => entry.durationHours === durationHours)
          return {
            durationHours,
            auctions: row?.auctions ?? 0,
            // La tarifa por subasta es una regla del dominio, no un dato: existe aunque no haya publicaciones.
            feePerAuction: AuctionDuration.fromHours(durationHours).publicationFee.value,
            gross: credits(feeOf(row === undefined ? [] : [row])),
          }
        }),
        salesCommission: { availability: 'UNAVAILABLE', reason: 'NO_SALE_COMMISSION_DEFINED' },
        realMoneyCommission: {
          availability: 'UNAVAILABLE',
          reason: 'OFFICIAL_AUCTION_HAS_NO_FEES',
        },
        walletReconciliation: {
          availability: 'UNAVAILABLE',
          reason: 'WALLET_READ_ENDPOINT_NOT_AVAILABLE',
        },
      },
    }
  }
}
