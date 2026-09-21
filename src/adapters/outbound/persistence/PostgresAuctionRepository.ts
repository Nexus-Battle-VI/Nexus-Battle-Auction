import { createHash, randomUUID } from 'node:crypto'

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'

import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../../application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  PersistBidResult,
  RecordPublicationFailureCommand,
} from '../../../application/ports/AuctionRepositoryPort'
import {
  AuctionStatus,
  MAX_ACTIVE_AUCTIONS_PER_SELLER,
  type AuctionSnapshot,
} from '../../../domain/entities/Auction'
import type { Bid, BidSnapshot } from '../../../domain/entities/Bid'
import type { Database } from './schema'

type AuctionRow = Selectable<Database['auctions']>

type AuctionBidRow = Selectable<Database['auction_bids']>

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

const toBidSnapshot = (row: AuctionBidRow): BidSnapshot => ({
  id: row.id,
  auctionId: row.auction_id,
  bidderId: row.bidder_id,
  amountCredits: row.amount_credits,
  placedAt: new Date(row.placed_at),
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

const findLeadingBid = async (
  db: AuctionDatabase,
  auctionId: string,
): Promise<BidSnapshot | null> => {
  const row = await db
    .selectFrom('auction_bids')
    .selectAll()
    .where('auction_id', '=', auctionId)
    .where('is_leader', '=', true)
    .executeTakeFirst()

  return row === undefined ? null : toBidSnapshot(row)
}

export class PostgresAuctionRepository implements AuctionRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult> {
    return this.db.transaction().execute(async (transaction) => {
      const snapshot = command.auction.snapshot()

      const hash = requestHash(command)

      // Serializa reintentos de la misma operacion.
      await sql`
          select pg_advisory_xact_lock(
            hashtext(${command.operationId})
          )
        `.execute(transaction)

      const previous = await transaction
        .selectFrom('auction_publication_operations')
        .select(['request_hash', 'auction_id'])
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (previous !== undefined) {
        if (previous.request_hash !== hash) {
          throw new IdempotencyConflictError()
        }

        const auction = await findAuction(transaction, previous.auction_id)

        if (auction === null) {
          throw new PersistedAuctionNotFoundError(previous.auction_id)
        }

        return {
          auction,
          replayed: true,
        }
      }

      // Serializa el limite de subastas
      // activas por vendedor.
      await sql`
          select pg_advisory_xact_lock(
            hashtext(${snapshot.sellerId})
          )
        `.execute(transaction)

      const active = await transaction
        .selectFrom('auctions')
        .select(
          sql<number>`
              count(*)::integer
            `.as('amount'),
        )
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

      return {
        auction: snapshot,
        replayed: false,
      }
    })
  }

  persistBid(bid: Bid): Promise<PersistBidResult> {
    return this.db.transaction().execute(async (transaction) => {
      const snapshot = bid.snapshot()

      // Todas las pujas de una misma subasta
      // pasan de una en una por esta seccion.
      await sql`
          select pg_advisory_xact_lock(
            hashtext(${snapshot.auctionId})
          )
        `.execute(transaction)

      const auction = await transaction
        .selectFrom('auctions')
        .select(['id', 'minimum_bid_credits'])
        .where('id', '=', snapshot.auctionId)
        .executeTakeFirst()

      if (auction === undefined) {
        throw new PersistedAuctionNotFoundError(snapshot.auctionId)
      }

      const duplicated = await transaction
        .selectFrom('auction_bids')
        .select('id')
        .where('id', '=', snapshot.id)
        .executeTakeFirst()

      if (duplicated !== undefined) {
        throw new BidAlreadyExistsError(snapshot.id)
      }

      const previousLeaderRow = await transaction
        .selectFrom('auction_bids')
        .selectAll()
        .where('auction_id', '=', snapshot.auctionId)
        .where('is_leader', '=', true)
        .executeTakeFirst()

      const previousLeader =
        previousLeaderRow === undefined ? null : toBidSnapshot(previousLeaderRow)

      /*
       * La validacion de dominio ocurre antes de
       * llegar al repositorio, pero mientras una
       * solicitud esperaba el lock otra puja pudo
       * convertirse en lider.
       *
       * Por eso se vuelve a comprobar contra el
       * lider REAL dentro de la transaccion.
       */
      if (previousLeaderRow !== undefined) {
        const minimumAllowed = previousLeaderRow.amount_credits + auction.minimum_bid_credits

        if (snapshot.amountCredits < minimumAllowed) {
          throw new ConcurrentBidConflictError()
        }

        await transaction
          .updateTable('auction_bids')
          .set({
            is_leader: false,
          })
          .where('id', '=', previousLeaderRow.id)
          .execute()
      }

      await transaction
        .insertInto('auction_bids')
        .values({
          id: snapshot.id,
          auction_id: snapshot.auctionId,
          bidder_id: snapshot.bidderId,
          amount_credits: snapshot.amountCredits,
          placed_at: snapshot.placedAt,
          is_leader: true,
        })
        .execute()

      return {
        bid: {
          ...snapshot,
          placedAt: new Date(snapshot.placedAt),
        },
        previousLeader,
      }
    })
  }

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null> {
    return findLeadingBid(this.db, auctionId)
  }

  async findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]> {
    const rows = await this.db
      .selectFrom('auction_bids')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .orderBy('placed_at', 'asc')
      .orderBy('id', 'asc')
      .execute()

    return rows.map(toBidSnapshot)
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
      .select(
        sql<number>`
          count(*)::integer
        `.as('amount'),
      )
      .where('seller_id', '=', sellerId)
      .where('status', '=', AuctionStatus.Active)
      .executeTakeFirstOrThrow()

    return row.amount
  }
}
