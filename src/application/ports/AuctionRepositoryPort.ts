import type { Auction, AuctionSnapshot } from '../../domain/entities/Auction'
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

export interface ActiveAuctionListItem {
  readonly id: string
  readonly sellerId: string
  readonly productId: string
  readonly minimumBidCredits: number
  readonly buyNowCredits: number | null
  readonly status: 'ACTIVE'
  readonly publishedAt: Date
  readonly closesAt: Date
  readonly currentBidAmount: number | null
}

export interface ListActiveAuctionsInput {
  readonly now: Date
  readonly page: number
  readonly pageSize: number
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
  findAuctionAggregate(auctionId: string): Promise<Auction | null>
  findInventoryCommitmentId(auctionId: string): Promise<string | null>
  finishAuction(command: FinishAuctionCommand): Promise<void>

  /** Subastas activas cuyo cierre cae en `(from, until]`. */
  findActiveClosingBetween(from: Date, until: Date): Promise<readonly AuctionSnapshot[]>

  /** Marketplace: activas no vencidas, ordenadas y paginadas. */
  listActive(input: ListActiveAuctionsInput): Promise<ActiveAuctionList>

  countActiveBySeller(sellerId: string): Promise<number>

  persistBid(bid: Bid, reservationId?: string, operationId?: string): Promise<PersistBidResult>

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null>

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]>

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
}

export const AUCTION_REPOSITORY = Symbol('AuctionRepositoryPort')
