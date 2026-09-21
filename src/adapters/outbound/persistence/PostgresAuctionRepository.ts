import { createHash, randomUUID } from 'node:crypto'

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'

import {
  ActiveAuctionLimitExceededError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../../application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  RecordPublicationFailureCommand,
} from '../../../application/ports/AuctionRepositoryPort'
import {
  AuctionStatus,
  MAX_ACTIVE_AUCTIONS_PER_SELLER,
  type AuctionSnapshot,
} from '../../../domain/entities/Auction'
import type { Database } from './schema'

type AuctionRow = Selectable<Database['auctions']>
type AuctionDatabase = Kysely<Database> | Transaction<Database>

const requestHash = (command: PersistAuctionPublicationCommand): string => {
  const auction = command.auction.snapshot()
  return createHash('sha256')
    .update(
      JSON.stringify([
        auction.sellerId,
        auction.productId,
        auction.durationHours,
        auction.publicationFeeCredits,
        auction.minimumBidCredits,
        auction.buyNowCredits,
        auction.status,
      ]),
      'utf8',
    )
    .digest('hex')
}

const toSnapshot = (row: AuctionRow): AuctionSnapshot => ({
  id: row.id,
  sellerId: row.seller_id,
  productId: row.product_id,
  durationHours: row.duration_hours as 24 | 48,
  publicationFeeCredits: row.publication_fee_credits,
  minimumBidCredits: row.minimum_bid_credits,
  buyNowCredits: row.buy_now_credits,
  status: row.status as AuctionStatus,
  publishedAt: new Date(row.published_at),
  closesAt: new Date(row.closes_at),
})

const findAuction = async (
  db: AuctionDatabase,
  auctionId: string,
): Promise<AuctionSnapshot | null> => {
  const row = await db
    .selectFrom('auctions')
    .selectAll()
    .where('id', '=', auctionId)
    .executeTakeFirst()
  return row === undefined ? null : toSnapshot(row)
}

export class PostgresAuctionRepository implements AuctionRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult> {
    return this.db.transaction().execute(async (transaction) => {
      const snapshot = command.auction.snapshot()
      const hash = requestHash(command)

      // El bloqueo por operacion serializa reintentos simultaneos. El bloqueo
      // por vendedor convierte el conteo 9 -> 10 en una decision atomica.
      await sql`select pg_advisory_xact_lock(hashtext(${command.operationId}))`.execute(transaction)
      const previous = await transaction
        .selectFrom('auction_publication_operations')
        .select(['request_hash', 'auction_id'])
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (previous !== undefined) {
        if (previous.request_hash !== hash) throw new IdempotencyConflictError()
        const auction = await findAuction(transaction, previous.auction_id)
        if (auction === null) throw new PersistedAuctionNotFoundError(previous.auction_id)
        return { auction, replayed: true }
      }

      await sql`select pg_advisory_xact_lock(hashtext(${snapshot.sellerId}))`.execute(transaction)
      const active = await transaction
        .selectFrom('auctions')
        .select(sql<number>`count(*)::integer`.as('amount'))
        .where('seller_id', '=', snapshot.sellerId)
        .where('status', '=', AuctionStatus.Active)
        .executeTakeFirstOrThrow()
      if (active.amount >= MAX_ACTIVE_AUCTIONS_PER_SELLER) {
        throw new ActiveAuctionLimitExceededError()
      }

      await transaction
        .insertInto('auctions')
        .values({
          id: snapshot.id,
          seller_id: snapshot.sellerId,
          product_id: snapshot.productId,
          duration_hours: snapshot.durationHours,
          publication_fee_credits: snapshot.publicationFeeCredits,
          minimum_bid_credits: snapshot.minimumBidCredits,
          buy_now_credits: snapshot.buyNowCredits,
          status: snapshot.status,
          published_at: snapshot.publishedAt,
          closes_at: snapshot.closesAt,
          inventory_commitment_id: command.inventoryCommitmentId,
          fee_charge_id: command.feeChargeId,
        })
        .execute()

      await transaction
        .insertInto('auction_publication_operations')
        .values({
          operation_id: command.operationId,
          request_hash: hash,
          auction_id: snapshot.id,
          completed_at: snapshot.publishedAt,
        })
        .execute()
      await transaction
        .insertInto('auction_audit_log')
        .values({
          auction_id: snapshot.id,
          operation_id: command.operationId,
          action: 'AUCTION_PUBLISHED',
          actor_id: snapshot.sellerId,
          occurred_at: snapshot.publishedAt,
          details: {
            inventoryCommitmentId: command.inventoryCommitmentId,
            feeChargeId: command.feeChargeId,
          },
        })
        .execute()
      await transaction
        .insertInto('outbox_events')
        .values({
          id: randomUUID(),
          aggregate_id: snapshot.id,
          event_type: 'auction.published.v1',
          payload: snapshot,
          occurred_at: snapshot.publishedAt,
          published_at: null,
        })
        .execute()

      return { auction: snapshot, replayed: false }
    })
  }

  findById(auctionId: string): Promise<AuctionSnapshot | null> {
    return findAuction(this.db, auctionId)
  }

  async recordFailure(command: RecordPublicationFailureCommand): Promise<void> {
    await this.db
      .insertInto('auction_publication_failures')
      .values({
        operation_id: command.operationId,
        auction_id: command.auctionId,
        seller_id: command.sellerId,
        stage: command.stage,
        reason: command.reason,
        fee_charge_id: command.feeChargeId,
        inventory_commitment_id: command.inventoryCommitmentId,
        fee_refunded: command.feeRefunded,
        inventory_released: command.inventoryReleased,
        occurred_at: command.occurredAt,
      })
      .onConflict((conflict) =>
        conflict.column('operation_id').doUpdateSet({
          stage: command.stage,
          reason: command.reason,
          fee_charge_id: command.feeChargeId,
          inventory_commitment_id: command.inventoryCommitmentId,
          fee_refunded: command.feeRefunded,
          inventory_released: command.inventoryReleased,
          occurred_at: command.occurredAt,
        }),
      )
      .execute()
  }

  async countActiveBySeller(sellerId: string): Promise<number> {
    const row = await this.db
      .selectFrom('auctions')
      .select(sql<number>`count(*)::integer`.as('amount'))
      .where('seller_id', '=', sellerId)
      .where('status', '=', AuctionStatus.Active)
      .executeTakeFirstOrThrow()
    return row.amount
  }
}
