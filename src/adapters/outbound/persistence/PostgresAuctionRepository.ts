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
  BidCreditOperationSnapshot,
  BidCreditOperationStatus,
  CreateBidCreditOperationCommand,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  PersistBidResult,
  RecordBidCreditFailureCommand,
  RecordPublicationFailureCommand,
  UpdateBidCreditOperationCommand,
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

type BidCreditOperationRow = Selectable<Database['auction_bid_credit_operations']>

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

const toBidCreditOperationSnapshot = (row: BidCreditOperationRow): BidCreditOperationSnapshot => ({
  operationId: row.operation_id,
  bidId: row.bid_id,
  auctionId: row.auction_id,
  bidderId: row.bidder_id,
  amountCredits: row.amount_credits,
  status: row.status as BidCreditOperationStatus,
  reservationId: row.reservation_id,
  previousReservationId: row.previous_reservation_id,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
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

  createBidCreditOperation(command: CreateBidCreditOperationCommand): Promise<void> {
    return this.db.transaction().execute(async (transaction) => {
      await sql`
          select pg_advisory_xact_lock(
            hashtext(${command.operationId})
          )
        `.execute(transaction)

      await sql`
          select pg_advisory_xact_lock(
            hashtext(${command.bidId})
          )
        `.execute(transaction)

      const previous = await transaction
        .selectFrom('auction_bid_credit_operations')
        .selectAll()
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (previous !== undefined) {
        const sameIntent =
          previous.bid_id === command.bidId &&
          previous.auction_id === command.auctionId &&
          previous.bidder_id === command.bidderId &&
          previous.amount_credits === command.amountCredits

        if (!sameIntent) {
          throw new IdempotencyConflictError()
        }

        return
      }

      const sameBid = await transaction
        .selectFrom('auction_bid_credit_operations')
        .select('operation_id')
        .where('bid_id', '=', command.bidId)
        .executeTakeFirst()

      if (sameBid !== undefined) {
        throw new IdempotencyConflictError()
      }

      await transaction
        .insertInto('auction_bid_credit_operations')
        .values({
          operation_id: command.operationId,
          bid_id: command.bidId,
          auction_id: command.auctionId,
          bidder_id: command.bidderId,
          amount_credits: command.amountCredits,
          status: 'PENDING_RESERVATION',
          reservation_id: null,
          previous_reservation_id: null,
          created_at: command.createdAt,
          updated_at: command.createdAt,
        })
        .execute()
    })
  }

  async updateBidCreditOperation(command: UpdateBidCreditOperationCommand): Promise<void> {
    const result = await this.db
      .updateTable('auction_bid_credit_operations')
      .set({
        status: command.status,
        reservation_id: command.reservationId,
        previous_reservation_id: command.previousReservationId,
        updated_at: command.updatedAt,
      })
      .where('operation_id', '=', command.operationId)
      .executeTakeFirst()

    if (result.numUpdatedRows === 0n) {
      throw new Error(`La operacion de creditos ${command.operationId} no existe.`)
    }
  }

  async findBidCreditOperation(operationId: string): Promise<BidCreditOperationSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_bid_credit_operations')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirst()

    return row === undefined ? null : toBidCreditOperationSnapshot(row)
  }

  persistBid(
    bid: Bid,
    creditReservationId: string | null = null,
    operationId: string | null = null,
  ): Promise<PersistBidResult> {
    return this.db.transaction().execute(async (transaction) => {
      const snapshot = bid.snapshot()

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

      if (operationId !== null) {
        const creditOperation = await transaction
          .selectFrom('auction_bid_credit_operations')
          .selectAll()
          .where('operation_id', '=', operationId)
          .executeTakeFirst()

        if (creditOperation === undefined) {
          throw new Error(`La operacion de creditos ${operationId} no existe.`)
        }

        if (
          creditOperation.bid_id !== snapshot.id ||
          creditOperation.auction_id !== snapshot.auctionId ||
          creditOperation.bidder_id !== snapshot.bidderId ||
          creditOperation.amount_credits !== snapshot.amountCredits
        ) {
          throw new IdempotencyConflictError()
        }
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

      const previousLeaderReservationId =
        previousLeaderRow === undefined ? null : previousLeaderRow.credit_reservation_id

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
          credit_reservation_id: creditReservationId,
        })
        .execute()

      if (operationId !== null) {
        const update = await transaction
          .updateTable('auction_bid_credit_operations')
          .set({
            status: 'BID_PERSISTED',
            reservation_id: creditReservationId,
            previous_reservation_id: previousLeaderReservationId,
            updated_at: snapshot.placedAt,
          })
          .where('operation_id', '=', operationId)
          .executeTakeFirst()

        if (update.numUpdatedRows === 0n) {
          throw new Error(`La operacion de creditos ${operationId} no existe.`)
        }
      }

      return {
        bid: {
          ...snapshot,
          placedAt: new Date(snapshot.placedAt),
        },
        previousLeader,
        previousLeaderReservationId,
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

  async recordBidCreditFailure(command: RecordBidCreditFailureCommand): Promise<void> {
    await this.db
      .insertInto('auction_bid_credit_failures')
      .values({
        operation_id: command.operationId,
        bid_id: command.bidId,
        auction_id: command.auctionId,
        bidder_id: command.bidderId,
        stage: command.stage,
        reason: command.reason,
        new_reservation_id: command.newReservationId,
        previous_reservation_id: command.previousReservationId,
        new_reservation_released: command.newReservationReleased,
        previous_reservation_released: command.previousReservationReleased,
        occurred_at: command.occurredAt,
      })
      .onConflict((conflict) =>
        conflict.column('operation_id').doUpdateSet({
          bid_id: command.bidId,
          auction_id: command.auctionId,
          bidder_id: command.bidderId,
          stage: command.stage,
          reason: command.reason,
          new_reservation_id: command.newReservationId,
          previous_reservation_id: command.previousReservationId,
          new_reservation_released: command.newReservationReleased,
          previous_reservation_released: command.previousReservationReleased,
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
