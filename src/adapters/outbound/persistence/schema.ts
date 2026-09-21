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
  created_at: GeneratedTimestamp
}

export interface AuctionBidTable {
  id: string
  auction_id: string
  bidder_id: string
  amount_credits: number
  placed_at: Timestamp
  is_leader: boolean

  /**
   * Reserva de Wallet que respalda los creditos comprometidos por esta puja.
   *
   * Es nullable porque las filas creadas antes de HU-63.2 no disponen de esta
   * asociacion. Las nuevas pujas gestionadas por el flujo de HU-63.2 deberan
   * persistirla.
   */
  credit_reservation_id: string | null
}

export interface AuctionBidCreditFailureTable {
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

export interface Database {
  auctions: AuctionTable
  auction_bids: AuctionBidTable
  auction_bid_credit_operations: AuctionBidCreditOperationTable
  auction_bid_credit_failures: AuctionBidCreditFailureTable
  auction_publication_operations: AuctionPublicationOperationTable
  auction_publication_failures: AuctionPublicationFailureTable
  auction_audit_log: AuctionAuditLogTable
  outbox_events: OutboxEventTable
}
