import type { Auction, AuctionSnapshot, AuctionStatus } from '../../domain/entities/Auction'
import type { AutoBidConfig, AutoBidConfigSnapshot } from '../../domain/entities/AutoBidConfig'
import type { AuctionClosingResult } from '../../domain/entities/AuctionClosingResult'
import type { Bid, BidSnapshot } from '../../domain/entities/Bid'
import type {
  OfficialAuction,
  OfficialAuctionSnapshot,
} from '../../domain/entities/OfficialAuction'

export interface PersistAuctionPublicationCommand {
  readonly operationId: string
  readonly auction: Auction
  readonly inventoryCommitmentId: string
  readonly feeChargeId: string
}

export interface PersistAuctionPublicationResult {
  readonly auction: AuctionSnapshot
  readonly replayed: boolean
}

export interface PersistOfficialAuctionPublicationCommand {
  readonly operationId: string
  readonly auction: OfficialAuction
}

export interface PersistOfficialAuctionPublicationResult {
  readonly auction: OfficialAuctionSnapshot
  readonly replayed: boolean
}

export interface RecordPublicationFailureCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly sellerId: string
  readonly stage: string
  readonly reason: string
  readonly feeChargeId: string | null
  readonly inventoryCommitmentId: string | null
  readonly feeRefunded: boolean
  readonly inventoryReleased: boolean
  readonly occurredAt: Date
}

export interface PersistBidResult {
  readonly bid: BidSnapshot
  readonly previousLeader: BidSnapshot | null
  readonly previousLeaderReservationId: string | null
}
export interface FinishAuctionCommand {
  readonly auctionId: string
  readonly finishedAt: Date
  readonly closingResult: AuctionClosingResult
}

interface ActiveAuctionListItemBase {
  readonly id: string
  readonly sellerId: string
  readonly productId: string
  readonly status: 'ACTIVE'
  readonly publishedAt: Date
  readonly closesAt: Date
  readonly currentBidAmount: number | null
  /** Total de pujas persistidas en `auction_bids`; 0 si nunca hubo pujas. */
  readonly bidCount: number
}

export interface PlayerActiveAuctionListItem extends ActiveAuctionListItemBase {
  readonly publisherType: 'PLAYER'
  readonly priceKind: 'CREDITS'
  readonly minimumBidCredits: number
  readonly buyNowCredits: number | null
  readonly currency: null
  readonly minimumBidAmountMinor: null
  readonly buyNowAmountMinor: null
  readonly officialMark: null
}

export interface OfficialActiveAuctionListItem extends ActiveAuctionListItemBase {
  readonly publisherType: 'GAME_MASTER'
  readonly priceKind: 'REAL_MONEY'
  readonly minimumBidCredits: null
  readonly buyNowCredits: null
  readonly currency: string
  readonly minimumBidAmountMinor: number
  readonly buyNowAmountMinor: number | null
  readonly officialMark: 'OFFICIAL' | 'PREMIUM'
}

export type ActiveAuctionListItem = PlayerActiveAuctionListItem | OfficialActiveAuctionListItem

/**
 * Lectura unificada de una subasta para HU-88, independiente de su estado
 * (a diferencia de `ActiveAuctionListItem`, que solo cubre `ACTIVE`): el
 * detalle debe seguir mostrando una subasta `FINISHED`/`SOLD`. Mismo
 * vocabulario que `ActiveAuctionListItem` -no se inventa uno nuevo-, sin
 * `currentBidAmount`/`bidCount`: esos los sigue resolviendo `GetAuctionDetail`
 * con `findLeadingBid`/`countBids`, que no cambian de semantica.
 */
interface AuctionDetailSnapshotBase {
  readonly id: string
  readonly sellerId: string
  readonly productId: string
  readonly durationHours: 24 | 48
  readonly publicationFeeCredits: number
  readonly status: AuctionStatus
  readonly publishedAt: Date
  readonly closesAt: Date
  /** HU-90: no nulo si y solo si `status === AuctionStatus.Cancelled`. */
  readonly cancelledAt: Date | null
}

export interface PlayerAuctionDetailSnapshot extends AuctionDetailSnapshotBase {
  readonly publisherType: 'PLAYER'
  readonly priceKind: 'CREDITS'
  readonly minimumBidCredits: number
  readonly buyNowCredits: number | null
  readonly currency: null
  readonly minimumBidAmountMinor: null
  readonly buyNowAmountMinor: null
  readonly officialMark: null
}

export interface OfficialAuctionDetailSnapshot extends AuctionDetailSnapshotBase {
  readonly publisherType: 'GAME_MASTER'
  readonly priceKind: 'REAL_MONEY'
  readonly minimumBidCredits: null
  readonly buyNowCredits: null
  readonly currency: string
  readonly minimumBidAmountMinor: number
  readonly buyNowAmountMinor: number | null
  readonly officialMark: 'OFFICIAL' | 'PREMIUM'
}

export type AuctionDetailSnapshot = PlayerAuctionDetailSnapshot | OfficialAuctionDetailSnapshot

/** Pagina publica del historial de pujas (HU-88): nunca incluye `bidderId`. */
export interface BidHistoryItem {
  readonly id: string
  readonly amountCredits: number
  readonly placedAt: Date
}

export interface BidHistoryPageInput {
  readonly auctionId: string
  readonly page: number
  readonly pageSize: number
}

export interface BidHistoryPage {
  readonly items: readonly BidHistoryItem[]
  readonly total: number
}

/** Filtros opcionales del marketplace; ausentes = sin restriccion. */
export interface ActiveAuctionFilters {
  readonly publisherType?: 'PLAYER' | 'GAME_MASTER' | undefined
  readonly priceKind?: 'CREDITS' | 'REAL_MONEY' | undefined
  /** Solo indica que hay un precio de compra inmediata configurado. */
  readonly hasBuyNow?: boolean | undefined
}

/**
 * Orden explicito del marketplace. Sin orden se conserva el historico:
 * GAME_MASTER primero, luego cierre ascendente e id.
 */
export type ActiveAuctionSort = 'closingSoon' | 'newest' | 'priceAsc' | 'priceDesc' | 'mostBids'

/** Universo de subastas activas no vencidas que cumplen los filtros. */
export interface ActiveAuctionUniverseInput {
  readonly now: Date
  readonly filters?: ActiveAuctionFilters | undefined
}

export interface ListActiveAuctionsInput extends ActiveAuctionUniverseInput {
  readonly page: number
  readonly pageSize: number
  readonly sort?: ActiveAuctionSort | undefined
  /**
   * Restringe el listado a estos productos (busqueda por nombre de HU-87, ya
   * resuelta contra Catalog). Ausente = sin restriccion; vacio = ningun producto.
   */
  readonly productIds?: readonly string[] | undefined
}

export interface ActiveAuctionList {
  readonly items: readonly ActiveAuctionListItem[]
  readonly total: number
}

export type BidCreditOperationStatus =
  | 'PENDING_RESERVATION'
  | 'RESERVED'
  | 'BID_PERSISTED'
  | 'COMPENSATION_PENDING'
  | 'COMPENSATED'
  | 'COMPLETED'

export type BidCreditFailureStage =
  | 'CHECKING_BALANCE'
  | 'RESERVING_CREDITS'
  | 'PERSISTING_BID'
  | 'RELEASING_NEW_RESERVATION'
  | 'RELEASING_PREVIOUS_RESERVATION'

export interface BidCreditOperationSnapshot {
  readonly operationId: string
  readonly bidId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly amountCredits: number
  readonly status: BidCreditOperationStatus
  readonly reservationId: string | null
  readonly previousReservationId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateBidCreditOperationCommand {
  readonly operationId: string
  readonly bidId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly amountCredits: number
  readonly createdAt: Date
}

export interface UpdateBidCreditOperationCommand {
  readonly operationId: string
  readonly status: BidCreditOperationStatus
  readonly reservationId: string | null
  readonly previousReservationId: string | null
  readonly updatedAt: Date
}

export interface RecordBidCreditFailureCommand {
  readonly operationId: string
  readonly bidId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly stage: BidCreditFailureStage
  readonly reason: string
  readonly newReservationId: string | null
  readonly previousReservationId: string | null
  readonly newReservationReleased: boolean
  readonly previousReservationReleased: boolean
  readonly occurredAt: Date
}

/**
 * Cierre atomico de una subasta por compra inmediata (HU-64.3).
 *
 * `transactionId` viaja YA generado por el llamador (no aqui) para que un
 * reintento con el mismo `operationId` devuelva la misma confirmacion que vio
 * el comprador la primera vez, en lugar de una nueva.
 */
export interface CloseAuctionByBuyNowCommand {
  readonly operationId: string
  readonly transactionId: string
  readonly auctionId: string
  readonly buyerId: string
  readonly transferId: string
  readonly priceCredits: number
  readonly remainingCredits: number
  readonly closedAt: Date
}

export interface CloseAuctionByBuyNowResult {
  readonly auction: AuctionSnapshot
  readonly transactionId: string
  readonly replayed: boolean
}

/**
 * Confirmacion ya persistida de una compra inmediata, reconstruible SOLO con lo
 * guardado -sin volver a evaluar el dominio contra el estado actual de la
 * subasta-. Es lo que permite responder a un reintento con el mismo
 * `operationId` incluso despues de que la subasta ya cerro, cuando
 * `BuyNowDomainService` ya no aprobaria una compra nueva (HU-64.4).
 */
export interface BuyNowOperationRecord {
  readonly auction: AuctionSnapshot
  readonly transactionId: string
  readonly buyerId: string
  readonly transferId: string
  readonly priceCredits: number
  readonly remainingCredits: number
  readonly completedAt: Date
}

/**
 * HU-90. Transicion local ACTIVE -> CANCELLED, idempotencia por
 * `operationId` y creacion del seguimiento de efectos externos, todo en la
 * misma transaccion (mismo patron que `closeByBuyNow`).
 */
export interface CancelAuctionCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly sellerId: string
  readonly productId: string
  readonly cancelledAt: Date
  readonly inventoryCommitmentId: string
  readonly feeChargeId: string | null
  readonly refundAmountCredits: number
  readonly walletRefundOperationId: string
  readonly inventoryReleaseOperationId: string
}

export interface CancelAuctionResult {
  readonly auction: AuctionSnapshot
  readonly replayed: boolean
}

/**
 * HU-90, CA-05. Cancelacion automatica por sancion AUCTION_TERMS_VIOLATION.
 * Vendedor, producto y commitment de inventario NO viajan en el comando: el
 * repositorio los lee de la propia fila bajo el lock, igual que las reservas
 * de puja a liberar.
 */
export interface CancelAuctionAutomaticallyCommand {
  readonly operationId: string
  readonly auctionId: string
  /** Id de la sancion de Account que disparo la cancelacion. */
  readonly triggerReferenceId: string
  readonly cancelledAt: Date
  readonly inventoryReleaseOperationId: string
}

/** Pagina de vendedores con subastas ACTIVE, por cursor de `sellerId`. */
export interface ListActiveSellerIdsInput {
  /** Exclusivo. `null` para la primera pagina. */
  readonly afterSellerId: string | null
  readonly limit: number
}

export interface RecordBuyNowFailureCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly buyerId: string
  readonly stage: string
  readonly reason: string
  readonly transferId: string | null
  readonly creditsReversed: boolean
  readonly occurredAt: Date
}

export interface AuctionRepositoryPort {
  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult>
  publishOfficial(
    command: PersistOfficialAuctionPublicationCommand,
  ): Promise<PersistOfficialAuctionPublicationResult>
  recordFailure(command: RecordPublicationFailureCommand): Promise<void>

  findById(auctionId: string): Promise<AuctionSnapshot | null>
  findOfficialById(auctionId: string): Promise<OfficialAuctionSnapshot | null>

  /**
   * HU-88: detalle unificado PLAYER/GAME_MASTER en cualquier estado. NO
   * reemplaza a `findById` (CREDITS-only, usado por reglas de negocio de
   * puja/auto-puja/compra/publicacion/watchlist que no deben ver oficiales).
   */
  findDetailById(auctionId: string): Promise<AuctionDetailSnapshot | null>

  findAuctionAggregate(auctionId: string): Promise<Auction | null>
  findInventoryCommitmentId(auctionId: string): Promise<string | null>
  /** HU-90: necesario para el refund del 50% al cancelar. */
  findFeeChargeId(auctionId: string): Promise<string | null>
  finishAuction(command: FinishAuctionCommand): Promise<void>

  /**
   * HU-90. CAS `ACTIVE -> CANCELLED` serializado con el MISMO
   * `pg_advisory_xact_lock(hashtext(auctionId))` que usan `persistBid` y
   * `closeByBuyNow`, para que una puja o una compra inmediata concurrentes
   * nunca puedan entrelazarse con una cancelacion a medias. Revalida
   * ACTIVE/sin-pujas/ventana-de-6h bajo el lock -no confia en la lectura
   * previa del llamador, igual que `persistBid` revalida contra el lider
   * real-: lanza `AuctionRuleViolation` (mismos codigos que el dominio) si
   * el estado cambio mientras se esperaba el lock.
   */
  cancelAuction(command: CancelAuctionCommand): Promise<CancelAuctionResult>

  /**
   * HU-90, CA-05. CAS `ACTIVE -> CANCELLED` de la cancelacion automatica,
   * bajo el MISMO lock por subasta que `cancelAuction`, `persistBid` y
   * `closeByBuyNow`. Solo revalida ACTIVE (ni pujas ni ventana de 6h). En la
   * misma transaccion deja el seguimiento del release de inventario y de
   * cada reserva de puja que pueda seguir activa, la auditoria y
   * `auction.cancelled.v1` con origen TERMS_VIOLATION. No crea refund.
   * Lanza `AuctionRuleViolation(AUCTION_NOT_ACTIVE)` si otra transicion
   * terminal gano la carrera.
   */
  cancelAuctionAutomatically(
    command: CancelAuctionAutomaticallyCommand,
  ): Promise<CancelAuctionResult>

  /**
   * HU-90, CA-05. Vendedores DISTINTOS con al menos una subasta en creditos
   * ACTIVE, ordenados por `sellerId`. Solo ids: el sondeo de sanciones hace
   * una consulta a Account por vendedor, no por subasta.
   */
  listActiveSellerIds(input: ListActiveSellerIdsInput): Promise<readonly string[]>

  /** HU-90, CA-05. Ids de las subastas en creditos ACTIVE de un vendedor. */
  listActiveAuctionIdsBySeller(sellerId: string): Promise<readonly string[]>

  /** Subastas activas cuyo cierre cae en `(from, until]`. */
  findActiveClosingBetween(from: Date, until: Date): Promise<readonly AuctionSnapshot[]>

  /** Marketplace: activas no vencidas, ordenadas y paginadas. */
  listActive(input: ListActiveAuctionsInput): Promise<ActiveAuctionList>

  /** `product_id` del universo del marketplace, para resolver una busqueda contra Catalog. */
  listActiveProductIds(input: ActiveAuctionUniverseInput): Promise<readonly string[]>

  countActiveBySeller(sellerId: string): Promise<number>

  persistBid(bid: Bid, reservationId?: string, operationId?: string): Promise<PersistBidResult>

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null>

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]>

  /** Total de pujas persistidas de la subasta (buy-now no cuenta). */
  countBids(auctionId: string): Promise<number>

  /**
   * Pagina publica del historial de pujas (HU-88). Nunca expone `bidderId`.
   * Orden estable `placedAt ASC, id ASC` -igual que `findBidHistory`, sin
   * tocar su semantica interna, usada por settlement/recordatorios/auto-puja.
   */
  listBidHistoryPage(input: BidHistoryPageInput): Promise<BidHistoryPage>

  findLastBidByBidder(bidderId: string): Promise<BidSnapshot | null>

  countActiveBidsByBidder(bidderId: string): Promise<number>

  createBidCreditOperation(command: CreateBidCreditOperationCommand): Promise<void>

  updateBidCreditOperation(command: UpdateBidCreditOperationCommand): Promise<void>

  findBidCreditOperation(operationId: string): Promise<BidCreditOperationSnapshot | null>

  /**
   * La operacion de creditos asociada a una puja concreta (HU-64.5).
   *
   * `bid_id` es unico en `auction_bid_credit_operations` (HU-63.2): a lo sumo
   * un resultado. Permite encontrar `reservationId` a partir de la puja lider
   * -que es lo unico que `findLeadingBid` expone-, sin que quien lo consulta
   * necesite conocer de antemano el `operationId` original de esa puja.
   */
  findBidCreditOperationByBid(bidId: string): Promise<BidCreditOperationSnapshot | null>

  recordBidCreditFailure(command: RecordBidCreditFailureCommand): Promise<void>

  /**
   * Crea o reconfigura (upsert) la puja automatica de un jugador en una
   * subasta. Solo puede existir una configuracion por (auctionId, bidderId).
   */
  saveAutoBidConfig(config: AutoBidConfig): Promise<AutoBidConfigSnapshot>

  findAutoBidConfig(auctionId: string, bidderId: string): Promise<AutoBidConfigSnapshot | null>

  /**
   * Configuraciones activas de OTROS jugadores en la subasta, candidatas a
   * reaccionar ante una puja rival (HU-67.2).
   */
  findActiveAutoBidsForAuction(
    auctionId: string,
    excludeBidderId: string,
  ): Promise<readonly AutoBidConfigSnapshot[]>

  closeByBuyNow(command: CloseAuctionByBuyNowCommand): Promise<CloseAuctionByBuyNowResult>

  recordBuyNowFailure(command: RecordBuyNowFailureCommand): Promise<void>

  findBuyNowOperation(operationId: string): Promise<BuyNowOperationRecord | null>
  /** Operacion durable que identifica una compra inmediata para una subasta. */
  findBuyNowOperationByAuctionId(auctionId: string): Promise<BuyNowOperationRecord | null>
}

export const AUCTION_REPOSITORY = Symbol('AuctionRepositoryPort')
