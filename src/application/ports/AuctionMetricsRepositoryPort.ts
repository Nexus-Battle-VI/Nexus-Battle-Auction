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

/** Publicaciones de un producto en el periodo (contrato §3.4, «mas subastados»). */
export interface ProductAuctionedCount {
  readonly productId: string
  /** Una fila de `auctions` = una publicacion; republicar el mismo producto cuenta de nuevo. */
  readonly total: number
  readonly playerCredits: number
  readonly officialRealMoney: number
}

/** Ventas de jugador de un producto cerradas en el periodo (contrato §3.4, «mas vendidos»). */
export interface ProductSoldCount {
  readonly productId: string
  readonly total: number
  readonly byAuctionClose: number
  readonly byBuyNow: number
}

/** Rankings ya ordenados (`total DESC, productId ASC`) y recortados a `limit`. */
export interface ProductRankingsAggregate {
  readonly mostAuctioned: readonly ProductAuctionedCount[]
  readonly mostSold: readonly ProductSoldCount[]
}

/** Ventas de jugador en creditos: acumulados exactos, sin promediar (el caso de uso redondea). */
export interface CreditSalesStats {
  readonly count: number
  /** Suma de precios finales (enteros). Con `count = 0` vale 0. */
  readonly sum: number
  readonly min: number | null
  readonly max: number | null
}

export type SaleChannel = 'AUCTION_CLOSE' | 'BUY_NOW'

/** Precios de lista de las subastas oficiales de UNA moneda, en unidad minima. */
export interface CurrencyListedPrices {
  /** ISO 4217. Nunca se combina con otra moneda. */
  readonly currency: string
  readonly publishedCount: number
  readonly minimumBid: {
    readonly sum: number
    readonly min: number
    readonly max: number
  }
  /** Solo las publicaciones que definieron compra inmediata. */
  readonly buyNow: { readonly count: number; readonly sum: number }
}

export interface AveragePricesAggregate {
  readonly credits: {
    /** Precio final de venta: `final_amount_credits` (cierre) o `price_credits` (compra inmediata). */
    readonly sales: CreditSalesStats & { readonly median: number | null }
    readonly byChannel: Readonly<Record<SaleChannel, CreditSalesStats>>
    /** `minimum_bid_credits` de TODA publicacion de jugador del periodo (`published_at`). */
    readonly listedMinimumBid: { readonly count: number; readonly sum: number }
  }
  /** Solo monedas con publicaciones, ordenadas por `currency` ASC (orden por bytes). */
  readonly realMoney: readonly CurrencyListedPrices[]
}

/**
 * REGLA ABIERTA (HU-91.5, a confirmar con el PO). Desde HU-90 CA-05 una subasta
 * `CANCELLED` puede tener pujas (la cancelacion automatica por sancion no exige
 * ausencia de pujas). El contrato `hu-91.v1` §3.2 solo dice que el VENDEDOR de una
 * cancelada cuenta; NO dice si las pujas hechas en ella son actividad del postor.
 *
 * Se aplica la definicion LITERAL: una puja es una accion de mercado con
 * `placed_at` en el periodo, sea cual sea el estado actual de la subasta. Esta es
 * la UNICA constante que decide el caso: ambos adaptadores la leen, y cambiarla a
 * `false` excluye las pujas de subastas canceladas sin tocar nada mas.
 */
export const COUNT_BIDS_ON_CANCELLED_AUCTIONS = true

/** Opciones de los adaptadores de metricas; por defecto, la constante de arriba. */
export interface AuctionMetricsAdapterOptions {
  readonly countBidsOnCancelledAuctions?: boolean
}

/** Un usuario activo con su grado de actividad: SUBASTAS distintas, no filas de pujas. */
export interface ActiveUserEntry {
  /** `sub` opaco del proveedor de identidad (D-2). Nunca nombre ni correo. */
  readonly playerId: string
  /** `COUNT(DISTINCT auction_id)` sobre la union de las tres acciones. */
  readonly activeAuctions: number
  readonly asSeller: number
  readonly asBidder: number
  readonly asBuyer: number
}

export interface ActiveUsersAggregate {
  /** Usuarios distintos con alguna accion de mercado en el periodo (no recortado por `limit`). */
  readonly totalActiveUsers: number
  readonly byRole: {
    readonly sellers: number
    readonly bidders: number
    readonly buyers: number
  }
  /** Ordenado `activeAuctions DESC, playerId ASC` (orden por bytes) y recortado a `limit`. */
  readonly top: readonly ActiveUserEntry[]
}

/** Comision de publicacion de las publicaciones de jugador de UNA duracion. */
export interface DurationFeeAggregate {
  readonly durationHours: number
  readonly auctions: number
  /** Suma de `publication_fee_credits` (enteros). */
  readonly feeCredits: number
}

/**
 * Importes de reembolso en CENTESIMAS de credito (enteros exactos): los reembolsos son
 * 0.5 o 1.5, y trabajar en enteros evita la coma flotante al restar del bruto.
 */
export interface RefundAggregate {
  readonly count: number
  readonly hundredths: number
}

export interface CommissionsAggregate {
  /** Solo duraciones con publicaciones en el periodo; el caso de uso rellena 24 y 48. */
  readonly byDuration: readonly DurationFeeAggregate[]
  /** Cancelaciones del periodo con `wallet_refund_status = 'CONFIRMED'`. */
  readonly refunded: RefundAggregate
  /** Cancelaciones del periodo con `wallet_refund_status` `PENDING` o `RETRYABLE`. */
  readonly pending: RefundAggregate
}

export interface UsersAndCommissionsAggregate {
  readonly activeUsers: ActiveUsersAggregate
  readonly commissions: CommissionsAggregate
}

export interface AuctionMetricsRepositoryPort {
  getUsersAndCommissions(
    period: MetricsPeriod,
    limit: number,
  ): Promise<UsersAndCommissionsAggregate>
  getAveragePrices(period: MetricsPeriod): Promise<AveragePricesAggregate>
  getVolumeAndSuccess(period: MetricsPeriod, asOf: Date): Promise<VolumeAndSuccessAggregate>
  getProductRankings(period: MetricsPeriod, limit: number): Promise<ProductRankingsAggregate>
  getClosingTime(period: MetricsPeriod): Promise<ClosingTimeAggregate>
  getTrendPoints(
    period: MetricsPeriod,
    granularity: TrendGranularity,
  ): Promise<readonly TrendPoint[]>
}

export const AUCTION_METRICS_REPOSITORY = Symbol('AuctionMetricsRepositoryPort')
