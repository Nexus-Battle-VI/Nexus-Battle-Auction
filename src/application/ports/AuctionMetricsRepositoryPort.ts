/**
 * Puerto de lectura de las metricas de Subasta (HU-91.2).
 *
 * Contrato: `Nexus-Battle-Infrastructure/docs/contracts/hu-91-auction-metrics-v1.md`
 * (`hu-91.v1`). El puerto devuelve AGREGADOS crudos; la forma JSON de la
 * respuesta, las razones y los redondeos viven en los casos de uso, de modo
 * que el adaptador PostgreSQL y el de memoria solo deben coincidir en cifras.
 *
 * Reglas comunes (contrato §3): periodo semiabierto `[from, to)` en UTC, solo
 * subastas de jugador (`price_kind = 'CREDITS'`) salvo el volumen oficial, y
 * cada contador anclado a SU propio timestamp persistido. Es un puerto de solo
 * lectura: ninguna operacion modifica estado.
 */

export interface MetricsPeriod {
  readonly from: Date
  readonly to: Date
}

export type TrendGranularity = 'DAY' | 'WEEK' | 'MONTH'

/** Motivo de cierre de una subasta de jugador cerrada por el mercado (contrato §3.3). */
export type CloseReason = 'EXPIRED_WITH_WINNER' | 'EXPIRED_WITHOUT_BIDS' | 'BUY_NOW'

export const CLOSE_REASONS: readonly CloseReason[] = [
  'EXPIRED_WITH_WINNER',
  'EXPIRED_WITHOUT_BIDS',
  'BUY_NOW',
]

export interface PlayerVolumeAggregate {
  /** Publicadas en el periodo (`published_at`). */
  readonly published: number
  /** Cerradas en el periodo, ancladas a su cierre efectivo (contrato §3.1). */
  readonly closedWithWinner: number
  readonly soldByBuyNow: number
  readonly closedWithoutBids: number
  /** Cerradas con liquidacion `FAILED_TERMINAL`; siguen contando como exito. */
  readonly settlementFailedTerminal: number
  /** Canceladas en el periodo (`cancelled_at`). */
  readonly cancelled: number
  /** `ACTIVE` con `closes_at > asOf` (instantanea, no acotada al periodo). */
  readonly active: number
  /** `ACTIVE` con `closes_at <= asOf`: pendientes del scheduler. */
  readonly awaitingClosure: number
  /** Reclamos creados en el periodo (`auction_pending_claims.settled_at`). */
  readonly claims: {
    readonly createdInPeriod: number
    readonly pending: number
    readonly claimed: number
    readonly expired: number
  }
}

export interface OfficialVolumeAggregate {
  readonly published: number
  readonly byMark: { readonly OFFICIAL: number; readonly PREMIUM: number }
}

export interface VolumeAndSuccessAggregate {
  readonly player: PlayerVolumeAggregate
  readonly official: OfficialVolumeAggregate
}

export interface DurationStats {
  readonly sampleSize: number
  readonly average: number | null
  readonly median: number | null
  readonly p90: number | null
}

export interface ClosingTimeAggregate {
  /** `closed_at - published_at`, en segundos, de las subastas cerradas en el periodo. */
  readonly overall: DurationStats
  readonly byCloseReason: Readonly<
    Record<CloseReason, { readonly sampleSize: number; readonly average: number | null }>
  >
  /** `finished_at - closes_at`, en segundos, solo para `FINISHED` (diagnostico del scheduler). */
  readonly settlementLag: {
    readonly sampleSize: number
    readonly average: number | null
    readonly p90: number | null
  }
}

/** Punto disperso de la serie: solo existen buckets con algun dato. */
export interface TrendPoint {
  readonly bucketStart: Date
  readonly published: number
  readonly closedWithWinner: number
  readonly soldByBuyNow: number
  readonly closedWithoutBids: number
  readonly cancelled: number
  /** Promedio de `closed_at - published_at` de lo cerrado en el bucket; `null` sin cierres. */
  readonly averageClosingSeconds: number | null
  readonly officialPublished: number
}

export interface AuctionMetricsRepositoryPort {
  getVolumeAndSuccess(period: MetricsPeriod, asOf: Date): Promise<VolumeAndSuccessAggregate>
  getClosingTime(period: MetricsPeriod): Promise<ClosingTimeAggregate>
  getTrendPoints(
    period: MetricsPeriod,
    granularity: TrendGranularity,
  ): Promise<readonly TrendPoint[]>
}

export const AUCTION_METRICS_REPOSITORY = Symbol('AuctionMetricsRepositoryPort')
