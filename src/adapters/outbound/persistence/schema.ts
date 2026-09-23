/**
 * Esquema de la base de datos del servicio, tipado para Kysely.
 *
 * **Es la unica fuente de verdad de los tipos de persistencia.** No hay paso de
 * generacion de codigo: lo que se declara aqui es lo que el compilador verifica
 * en cada consulta. Cada migracion que cree o cambie una tabla debe reflejarse
 * aqui en el mismo Pull Request.
 *
 * Nombres de columna en `snake_case`, que es la convencion de PostgreSQL. La
 * traduccion a la instantanea del agregado ocurre en un `mapping.ts` explicito.
 *
 */
import type { ColumnType, Generated } from 'kysely'

type Timestamp = ColumnType<Date, Date | string, Date | string>
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>

export interface AuctionTable {
  id: string
  seller_id: string
  product_id: string
  duration_hours: number
  publication_fee_credits: number
  minimum_bid_credits: number
  buy_now_credits: number | null
  status: string
  published_at: Timestamp
  closes_at: Timestamp
  inventory_commitment_id: string
  fee_charge_id: string
  finished_at: Date | null
  closing_result_type: string | null
  winning_bid_id: string | null
  winner_id: string | null
  final_amount_credits: string | number | null
  created_at: GeneratedTimestamp
}

export interface AuctionBidTable {
  id: string
  auction_id: string
  bidder_id: string
  amount_credits: number
  placed_at: Timestamp
  is_leader: boolean
  credit_reservation_id: string | null
}

export interface AuctionBidCreditOperationTable {
  operation_id: string
  bid_id: string
  auction_id: string
  bidder_id: string
  amount_credits: number
  status: string
  reservation_id: string | null
  previous_reservation_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface AuctionBidCreditFailureTable {
  id: Generated<number>
  operation_id: string
  bid_id: string
  auction_id: string
  bidder_id: string
  stage: string
  reason: string
  new_reservation_id: string | null
  previous_reservation_id: string | null
  new_reservation_released: boolean
  previous_reservation_released: boolean
  occurred_at: Timestamp
}

export interface AuctionPublicationOperationTable {
  operation_id: string
  request_hash: string
  auction_id: string
  completed_at: Timestamp
}

export interface AuctionPublicationFailureTable {
  operation_id: string
  auction_id: string
  seller_id: string
  stage: string
  reason: string
  fee_charge_id: string | null
  inventory_commitment_id: string | null
  fee_refunded: boolean
  inventory_released: boolean
  occurred_at: Timestamp
}

export interface AuctionBuyNowOperationTable {
  operation_id: string
  request_hash: string
  auction_id: string
  buyer_id: string
  transfer_id: string
  price_credits: number
  remaining_credits: number
  transaction_id: string
  completed_at: Timestamp
}

export interface AuctionBuyNowFailureTable {
  operation_id: string
  auction_id: string
  buyer_id: string
  stage: string
  reason: string
  transfer_id: string | null
  credits_reversed: boolean
  occurred_at: Timestamp
}

export interface AuctionAuditLogTable {
  id: Generated<number>
  auction_id: string
  operation_id: string
  action: string
  actor_id: string
  occurred_at: Timestamp
  details: unknown
}

export interface OutboxEventTable {
  id: string
  aggregate_id: string
  event_type: string
  payload: unknown
  occurred_at: Timestamp
  published_at: Timestamp | null
}

export interface Database {
  auction_watchlist: AuctionWatchlistTable
  auctions: AuctionTable
  auction_bids: AuctionBidTable
  auction_auto_bids: AuctionAutoBidTable
  auction_publication_operations: AuctionPublicationOperationTable
  auction_publication_failures: AuctionPublicationFailureTable
  auction_bid_credit_operations: AuctionBidCreditOperationTable
  auction_bid_credit_failures: AuctionBidCreditFailureTable
  auction_buy_now_operations: AuctionBuyNowOperationTable
  auction_buy_now_failures: AuctionBuyNowFailureTable
  auction_audit_log: AuctionAuditLogTable
  outbox_events: OutboxEventTable
  auction_settlements: AuctionSettlementTable
  auction_settlement_releases: AuctionSettlementReleaseTable
  auction_pending_claims: AuctionPendingClaimTable
}

export interface AuctionSettlementTable {
  auction_id: string
  status: string
  result_type: string
  winning_bid_id: string | null
  winner_id: string | null
  winning_hold_id: string | null
  seller_id: string
  final_amount_credits: string | number | null
  capture_operation_id: string | null
  capture_status: string
  last_error: string | null
  created_at: Timestamp
  updated_at: Timestamp
  settled_at: Timestamp | null
}
export interface AuctionPendingClaimTable {
  auction_id: string
  winner_id: string
  product_id: string
  winning_bid_id: string
  final_amount_credits: string | number
  settled_at: Timestamp
  claim_status: 'PENDING' | 'CLAIMED'
  claimed_at: Timestamp | null
  created_at: Timestamp
  updated_at: Timestamp
}
export interface AuctionSettlementReleaseTable {
  auction_id: string
  bid_id: string
  hold_id: string
  operation_id: string
  status: string
  reason: string
  last_error: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

/** Identidad compuesta de seguimiento; player_id no referencia bases de otros servicios. */
export interface AuctionWatchlistTable {
  player_id: string
  auction_id: string
  followed_at: Timestamp
}

/** Clave primaria compuesta (auction_id, bidder_id): a lo sumo una fila por jugador y subasta. */
export interface AuctionAutoBidTable {
  auction_id: string
  bidder_id: string
  max_amount_credits: number
  is_active: boolean
  created_at: Timestamp
  updated_at: Timestamp
}
