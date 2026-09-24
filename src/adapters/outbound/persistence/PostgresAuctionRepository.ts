import { createHash, randomUUID } from 'node:crypto'

import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'

import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../../application/errors/AuctionPersistenceError'
import {
  AuctionAlreadyClosedError,
  BuyNowIdempotencyConflictError,
} from '../../../application/errors/BuyNowTransactionError'
import type {
  AuctionRepositoryPort,
  ActiveAuctionList,
  BidCreditOperationSnapshot,
  BidCreditOperationStatus,
  BuyNowOperationRecord,
  CloseAuctionByBuyNowCommand,
  CloseAuctionByBuyNowResult,
  CreateBidCreditOperationCommand,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  ListActiveAuctionsInput,
  PersistBidResult,
  FinishAuctionCommand,
  RecordBidCreditFailureCommand,
  RecordBuyNowFailureCommand,
  PersistOfficialAuctionPublicationCommand,
  PersistOfficialAuctionPublicationResult,
  RecordPublicationFailureCommand,
  UpdateBidCreditOperationCommand,
} from '../../../application/ports/AuctionRepositoryPort'
import type {
  AuctionSettlementCandidate,
  AuctionSettlementCandidateReaderPort,
} from '../../../application/ports/AuctionSettlementWorkRepositoryPort'
import type { AuctionClosingOutcome } from '../../../domain/entities/Auction'
import {
  Auction,
  AuctionStatus,
  MAX_ACTIVE_AUCTIONS_PER_SELLER,
  type AuctionSnapshot,
} from '../../../domain/entities/Auction'
import type { AutoBidConfig, AutoBidConfigSnapshot } from '../../../domain/entities/AutoBidConfig'
import type { Bid, BidSnapshot } from '../../../domain/entities/Bid'
import type { OfficialAuctionMark } from '../../../domain/entities/OfficialAuction'
import {
  AuctionPublisherType,
  type OfficialAuctionSnapshot,
} from '../../../domain/entities/OfficialAuction'
import type { Database } from './schema'

type AuctionRow = Selectable<Database['auctions']>

type AuctionBidRow = Selectable<Database['auction_bids']>

type BidCreditOperationRow = Selectable<Database['auction_bid_credit_operations']>

type AutoBidConfigRow = Selectable<Database['auction_auto_bids']>

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

const officialRequestHash = (command: PersistOfficialAuctionPublicationCommand): string => {
  const auction = command.auction.snapshot()
  return createHash('sha256')
    .update(
      JSON.stringify([
        auction.publisherId,
        auction.productId,
        auction.durationHours,
        auction.currency,
        auction.minimumBidAmountMinor,
        auction.buyNowAmountMinor,
        auction.mark,
        auction.status,
      ]),
      'utf8',
    )
    .digest('hex')
}

/** `null` si la fila no pertenece a la rama de creditos (HU-62). */
const toSnapshot = (row: AuctionRow): AuctionSnapshot | null => {
  if (row.price_kind !== 'CREDITS' || row.minimum_bid_credits === null) return null

  return {
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
  }
}

/** `null` si la fila no pertenece a la rama de dinero real (HU-66). */
const toOfficialSnapshot = (row: AuctionRow): OfficialAuctionSnapshot | null => {
  if (
    row.price_kind !== 'REAL_MONEY' ||
    row.currency === null ||
    row.minimum_bid_amount_minor === null ||
    row.official_mark === null
  ) {
    return null
  }

  return {
    id: row.id,
    publisherId: row.seller_id,
    publisherType: AuctionPublisherType.GameMaster,
    productId: row.product_id,
    durationHours: row.duration_hours as 24 | 48,
    publicationFeeCredits: 0,
    currency: row.currency,
    minimumBidAmountMinor: row.minimum_bid_amount_minor,
    buyNowAmountMinor: row.buy_now_amount_minor,
    mark: row.official_mark as OfficialAuctionMark,
    status: row.status as AuctionStatus,
    publishedAt: new Date(row.published_at),
    closesAt: new Date(row.closes_at),
  }
}

/** Solo se llama con filas CREDITS; una fila REAL_MONEY aqui es un error del llamador. */
const toAuction = (row: AuctionRow): Auction => {
  const snapshot = toSnapshot(row)
  if (snapshot === null) {
    throw new PersistedAuctionNotFoundError(row.id)
  }

  if (row.status !== 'FINISHED' || row.finished_at === null) {
    return Auction.rehydrate({ ...snapshot, finishedAt: null, closingResult: null })
  }

  return Auction.rehydrate({
    ...snapshot,
    finishedAt: row.finished_at,
    closingResult: {
      outcome: row.closing_result_type as AuctionClosingOutcome,
      finishedAt: row.finished_at,
      winnerId: row.winner_id,
      winningBidId: row.winning_bid_id,
      finalAmountCredits:
        row.final_amount_credits === null ? null : Number(row.final_amount_credits),
    },
  })
}

const toBidSnapshot = (row: AuctionBidRow): BidSnapshot => ({
  id: row.id,
  auctionId: row.auction_id,
  bidderId: row.bidder_id,
  amountCredits: row.amount_credits,
  placedAt: new Date(row.placed_at),
  ...(row.credit_reservation_id === null ? {} : { creditReservationId: row.credit_reservation_id }),
})

/** configuredAt refleja la ultima reconfiguracion (updated_at), no la primera (created_at). */
const toAutoBidConfigSnapshot = (row: AutoBidConfigRow): AutoBidConfigSnapshot => ({
  auctionId: row.auction_id,
  bidderId: row.bidder_id,
  maxAmountCredits: row.max_amount_credits,
  configuredAt: new Date(row.updated_at),
  isActive: row.is_active,
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

const findAuctionAggregate = async (
  db: AuctionDatabase,
  auctionId: string,
): Promise<Auction | null> => {
  const row = await db
    .selectFrom('auctions')
    .selectAll()
    .where('id', '=', auctionId)
    .executeTakeFirst()

  return row === undefined ? null : toAuction(row)
}

const buyNowRequestHash = (command: CloseAuctionByBuyNowCommand): string =>
  createHash('sha256')
    .update(JSON.stringify([command.auctionId, command.buyerId, command.priceCredits]), 'utf8')
    .digest('hex')

const findOfficialAuction = async (
  db: AuctionDatabase,
  auctionId: string,
): Promise<OfficialAuctionSnapshot | null> => {
  const row = await db
    .selectFrom('auctions')
    .selectAll()
    .where('id', '=', auctionId)
    .executeTakeFirst()

  return row === undefined ? null : toOfficialSnapshot(row)
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

export class PostgresAuctionRepository
  implements AuctionRepositoryPort, AuctionSettlementCandidateReaderPort
{
  /**
   * Consulta determinista para el scheduler de recordatorios de HU-68.
   *
   * Solo CREDITS: una publicacion oficial (HU-66) no tiene pujas ni
   * recordatorios de cierre en este incremento.
   */
  async findActiveClosingBetween(from: Date, until: Date): Promise<readonly AuctionSnapshot[]> {
    const rows = await this.db
      .selectFrom('auctions')
      .selectAll()
      .where('price_kind', '=', 'CREDITS')
      .where('status', '=', AuctionStatus.Active)
      .where('closes_at', '>', from)
      .where('closes_at', '<=', until)
      .orderBy('closes_at', 'asc')
      .execute()
    return rows.flatMap((row) => {
      const snapshot = toSnapshot(row)
      return snapshot === null ? [] : [snapshot]
    })
  }

  /** Marketplace de jugador (HU-62): una publicacion oficial no aparece aqui. */
  async listActive(input: ListActiveAuctionsInput): Promise<ActiveAuctionList> {
    const offset = (input.page - 1) * input.pageSize
    const [rows, count] = await Promise.all([
      this.db
        .selectFrom('auctions')
        .leftJoin('auction_bids as leader', (join) =>
          join.onRef('leader.auction_id', '=', 'auctions.id').on('leader.is_leader', '=', true),
        )
        .select([
          'auctions.id',
          'auctions.seller_id',
          'auctions.product_id',
          'auctions.publisher_type',
          'auctions.price_kind',
          'auctions.minimum_bid_credits',
          'auctions.buy_now_credits',
          'auctions.currency',
          'auctions.minimum_bid_amount_minor',
          'auctions.buy_now_amount_minor',
          'auctions.official_mark',
          'auctions.status',
          'auctions.published_at',
          'auctions.closes_at',
          'leader.amount_credits as current_bid_amount',
        ])
        .where('auctions.status', '=', AuctionStatus.Active)
        .where('auctions.closes_at', '>', input.now)
        .orderBy(sql`case when auctions.publisher_type = 'GAME_MASTER' then 0 else 1 end`)
        .orderBy('auctions.closes_at', 'asc')
        .orderBy('auctions.id', 'asc')
        .limit(input.pageSize)
        .offset(offset)
        .execute(),
      this.db
        .selectFrom('auctions')
        .select(sql<number>`count(*)::integer`.as('total'))
        .where('status', '=', AuctionStatus.Active)
        .where('closes_at', '>', input.now)
        .executeTakeFirstOrThrow(),
    ])
    return {
      total: count.total,
      items: rows.map((row) => {
        const base = {
          id: row.id,
          sellerId: row.seller_id,
          productId: row.product_id,
          status: 'ACTIVE' as const,
          publishedAt: new Date(row.published_at),
          closesAt: new Date(row.closes_at),
          currentBidAmount: row.current_bid_amount,
        }

        if (row.price_kind === 'CREDITS' && row.minimum_bid_credits !== null) {
          return {
            ...base,
            publisherType: 'PLAYER' as const,
            priceKind: 'CREDITS' as const,
            minimumBidCredits: row.minimum_bid_credits,
            buyNowCredits: row.buy_now_credits,
            currency: null,
            minimumBidAmountMinor: null,
            buyNowAmountMinor: null,
            officialMark: null,
          }
        }

        if (
          row.price_kind === 'REAL_MONEY' &&
          row.publisher_type === 'GAME_MASTER' &&
          row.currency !== null &&
          row.minimum_bid_amount_minor !== null &&
          (row.official_mark === 'OFFICIAL' || row.official_mark === 'PREMIUM')
        ) {
          return {
            ...base,
            publisherType: 'GAME_MASTER' as const,
            priceKind: 'REAL_MONEY' as const,
            minimumBidCredits: null,
            buyNowCredits: null,
            currency: row.currency,
            minimumBidAmountMinor: row.minimum_bid_amount_minor,
            buyNowAmountMinor: row.buy_now_amount_minor,
            officialMark: row.official_mark,
            currentBidAmount: null,
          }
        }

        throw new Error(`La subasta ${row.id} tiene una configuracion de precio invalida.`)
      }),
    }
  }

  constructor(private readonly db: Kysely<Database>) {}
  async finishAuction(command: FinishAuctionCommand): Promise<void> {
    const result = command.closingResult.snapshot()
    const update = await this.db
      .updateTable('auctions')
      .set({
        status: AuctionStatus.Finished,
        finished_at: command.finishedAt,
        closing_result_type: result.outcome,
        winning_bid_id: result.winningBidId,
        winner_id: result.winnerId,
        final_amount_credits: result.finalAmountCredits,
      })
      .where('id', '=', command.auctionId)
      .where('status', '=', AuctionStatus.Active)
      .executeTakeFirst()
    if (update.numUpdatedRows === 0n) {
      const current = await this.db
        .selectFrom('auctions')
        .select('status')
        .where('id', '=', command.auctionId)
        .executeTakeFirst()
      if (current === undefined) throw new PersistedAuctionNotFoundError(command.auctionId)
      throw new Error('La subasta ya fue finalizada.')
    }
  }

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

      // Serializa el limite de subastas activas por vendedor.
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
          publisher_type: AuctionPublisherType.Player,
          price_kind: 'CREDITS',
          publication_fee_credits: snapshot.publicationFeeCredits,
          minimum_bid_credits: snapshot.minimumBidCredits,
          buy_now_credits: snapshot.buyNowCredits,
          currency: null,
          minimum_bid_amount_minor: null,
          buy_now_amount_minor: null,
          official_mark: null,
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

  publishOfficial(
    command: PersistOfficialAuctionPublicationCommand,
  ): Promise<PersistOfficialAuctionPublicationResult> {
    return this.db.transaction().execute(async (transaction) => {
      const snapshot = command.auction.snapshot()
      const hash = officialRequestHash(command)

      // Mismo bloqueo por operacion que HU-62; una publicacion oficial no
      // comparte el limite de diez subastas activas de PLAYER, asi que no hay
      // bloqueo por publicador aqui.
      await sql`select pg_advisory_xact_lock(hashtext(${command.operationId}))`.execute(transaction)
      const previous = await transaction
        .selectFrom('auction_publication_operations')
        .select(['request_hash', 'auction_id'])
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (previous !== undefined) {
        if (previous.request_hash !== hash) throw new IdempotencyConflictError()
        const auction = await findOfficialAuction(transaction, previous.auction_id)
        if (auction === null) throw new PersistedAuctionNotFoundError(previous.auction_id)
        return { auction, replayed: true }
      }

      await transaction
        .insertInto('auctions')
        .values({
          id: snapshot.id,
          seller_id: snapshot.publisherId,
          product_id: snapshot.productId,
          duration_hours: snapshot.durationHours,
          publisher_type: AuctionPublisherType.GameMaster,
          price_kind: 'REAL_MONEY',
          publication_fee_credits: snapshot.publicationFeeCredits,
          minimum_bid_credits: null,
          buy_now_credits: null,
          currency: snapshot.currency,
          minimum_bid_amount_minor: snapshot.minimumBidAmountMinor,
          buy_now_amount_minor: snapshot.buyNowAmountMinor,
          official_mark: snapshot.mark,
          status: snapshot.status,
          published_at: snapshot.publishedAt,
          closes_at: snapshot.closesAt,
          inventory_commitment_id: null,
          fee_charge_id: null,
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
          action: 'OFFICIAL_AUCTION_PUBLISHED',
          actor_id: snapshot.publisherId,
          occurred_at: snapshot.publishedAt,
          details: { mark: snapshot.mark },
        })
        .execute()
      await transaction
        .insertInto('outbox_events')
        .values({
          id: randomUUID(),
          aggregate_id: snapshot.id,
          event_type: 'auction.official-published.v1',
          payload: snapshot,
          occurred_at: snapshot.publishedAt,
          published_at: null,
        })
        .execute()

      return { auction: snapshot, replayed: false }
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

  async findBidCreditOperationByBid(bidId: string): Promise<BidCreditOperationSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_bid_credit_operations')
      .selectAll()
      .where('bid_id', '=', bidId)
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

      /*
       * Todas las pujas de una misma subasta
       * pasan de una en una por esta seccion.
       */
      await sql`
        select pg_advisory_xact_lock(
          hashtext(${snapshot.auctionId})
        )
      `.execute(transaction)

      const auction = await transaction
        .selectFrom('auctions')
        .select(['id', 'minimum_bid_credits'])
        .where('id', '=', snapshot.auctionId)
        .where('price_kind', '=', 'CREDITS')
        .executeTakeFirst()

      // Una publicacion oficial (HU-66) no admite pujas en este incremento:
      // para persistBid es como si la subasta no existiera.
      if (auction?.minimum_bid_credits === undefined || auction.minimum_bid_credits === null) {
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
          credit_reservation_id: creditReservationId,
        })
        .execute()

      /*
       * La puja y el cambio a BID_PERSISTED se guardan
       * dentro de la misma transaccion.
       */
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

  async findLastBidByBidder(bidderId: string): Promise<BidSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_bids')
      .selectAll()
      .where('bidder_id', '=', bidderId)
      .orderBy('placed_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst()

    return row === undefined ? null : toBidSnapshot(row)
  }

  async countActiveBidsByBidder(bidderId: string): Promise<number> {
    const row = await this.db
      .selectFrom('auction_bids')
      .innerJoin('auctions', 'auctions.id', 'auction_bids.auction_id')
      .select(
        sql<number>`
          count(*)::integer
        `.as('amount'),
      )
      .where('auction_bids.bidder_id', '=', bidderId)
      .where('auction_bids.is_leader', '=', true)
      .where('auctions.status', '=', AuctionStatus.Active)
      .executeTakeFirstOrThrow()

    return row.amount
  }

  findById(auctionId: string): Promise<AuctionSnapshot | null> {
    return findAuction(this.db, auctionId)
  }

  findOfficialById(auctionId: string): Promise<OfficialAuctionSnapshot | null> {
    return findOfficialAuction(this.db, auctionId)
  }

  /** Solo CREDITS: la liquidacion en dinero real de una publicacion oficial no existe todavia. */
  async findSettlementCandidates(now: Date): Promise<readonly AuctionSettlementCandidate[]> {
    const rows = await this.db
      .selectFrom('auctions')
      .select(['id', 'status', 'closes_at'])
      .where('price_kind', '=', 'CREDITS')
      .where('closes_at', '<=', now)
      .where('status', 'in', [AuctionStatus.Active, AuctionStatus.Finished])
      .orderBy('closes_at', 'asc')
      .orderBy('id', 'asc')
      .execute()

    return rows.map((row) => ({
      auctionId: row.id,
      status: row.status as AuctionStatus,
      closesAt: new Date(row.closes_at),
    }))
  }

  findAuctionAggregate(auctionId: string): Promise<Auction | null> {
    return findAuctionAggregate(this.db, auctionId)
  }

  async findInventoryCommitmentId(auctionId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('auctions')
      .select('inventory_commitment_id')
      .where('id', '=', auctionId)
      .executeTakeFirst()

    return row?.inventory_commitment_id ?? null
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

  async saveAutoBidConfig(config: AutoBidConfig): Promise<AutoBidConfigSnapshot> {
    const snapshot = config.snapshot()

    try {
      const row = await this.db
        .insertInto('auction_auto_bids')
        .values({
          auction_id: snapshot.auctionId,
          bidder_id: snapshot.bidderId,
          max_amount_credits: snapshot.maxAmountCredits,
          is_active: snapshot.isActive,
          created_at: snapshot.configuredAt,
          updated_at: snapshot.configuredAt,
        })
        .onConflict((conflict) =>
          conflict.columns(['auction_id', 'bidder_id']).doUpdateSet({
            max_amount_credits: snapshot.maxAmountCredits,
            is_active: snapshot.isActive,
            updated_at: snapshot.configuredAt,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow()

      return toAutoBidConfigSnapshot(row)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && 'constraint' in error) {
        if (error.code === '23503' && error.constraint === 'auction_auto_bids_auction_fk') {
          throw new PersistedAuctionNotFoundError(snapshot.auctionId)
        }
      }

      throw error
    }
  }

  async findAutoBidConfig(
    auctionId: string,
    bidderId: string,
  ): Promise<AutoBidConfigSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_auto_bids')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .where('bidder_id', '=', bidderId)
      .executeTakeFirst()

    return row === undefined ? null : toAutoBidConfigSnapshot(row)
  }

  async findActiveAutoBidsForAuction(
    auctionId: string,
    excludeBidderId: string,
  ): Promise<readonly AutoBidConfigSnapshot[]> {
    const rows = await this.db
      .selectFrom('auction_auto_bids')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .where('is_active', '=', true)
      .where('bidder_id', '!=', excludeBidderId)
      .orderBy('bidder_id', 'asc')
      .execute()

    return rows.map(toAutoBidConfigSnapshot)
  }

  closeByBuyNow(command: CloseAuctionByBuyNowCommand): Promise<CloseAuctionByBuyNowResult> {
    return this.db.transaction().execute(async (transaction) => {
      const hash = buyNowRequestHash(command)

      // Serializa reintentos de la misma operacion.
      await sql`
          select pg_advisory_xact_lock(
            hashtext(${command.operationId})
          )
        `.execute(transaction)

      const previousOperation = await transaction
        .selectFrom('auction_buy_now_operations')
        .select(['request_hash', 'auction_id', 'transaction_id'])
        .where('operation_id', '=', command.operationId)
        .executeTakeFirst()

      if (previousOperation !== undefined) {
        if (previousOperation.request_hash !== hash) {
          throw new BuyNowIdempotencyConflictError()
        }

        const auction = await findAuction(transaction, previousOperation.auction_id)

        if (auction === null) {
          throw new PersistedAuctionNotFoundError(previousOperation.auction_id)
        }

        return {
          auction,
          transactionId: previousOperation.transaction_id,
          replayed: true,
        }
      }

      // Serializa cualquier otra compra inmediata (o cierre) que compita por
      // la MISMA subasta: solo una gana la carrera.
      await sql`
          select pg_advisory_xact_lock(
            hashtext(${command.auctionId})
          )
        `.execute(transaction)

      const auctionRow = await transaction
        .selectFrom('auctions')
        .selectAll()
        .where('id', '=', command.auctionId)
        .executeTakeFirst()

      if (auctionRow === undefined) {
        throw new PersistedAuctionNotFoundError(command.auctionId)
      }

      if (auctionRow.status !== (AuctionStatus.Active as string)) {
        throw new AuctionAlreadyClosedError(command.auctionId)
      }

      await transaction
        .updateTable('auctions')
        .set({ status: AuctionStatus.SoldByBuyNow, closes_at: command.closedAt })
        .where('id', '=', command.auctionId)
        .execute()

      await transaction
        .insertInto('auction_buy_now_operations')
        .values({
          operation_id: command.operationId,
          request_hash: hash,
          auction_id: command.auctionId,
          buyer_id: command.buyerId,
          transfer_id: command.transferId,
          price_credits: command.priceCredits,
          remaining_credits: command.remainingCredits,
          transaction_id: command.transactionId,
          completed_at: command.closedAt,
        })
        .execute()

      await transaction
        .insertInto('auction_audit_log')
        .values({
          auction_id: command.auctionId,
          operation_id: command.operationId,
          action: 'AUCTION_CLOSED_BY_BUY_NOW',
          actor_id: command.buyerId,
          occurred_at: command.closedAt,
          details: {
            transferId: command.transferId,
            priceCredits: command.priceCredits,
            transactionId: command.transactionId,
          },
        })
        .execute()

      // HU-64.5 consume este evento para notificar a los demas participantes y
      // liberar los creditos reservados de sus pujas perdedoras. `productId`
      // viaja en el payload -y no solo `auctionId`- para que un consumidor
      // como HU-65.3/HU-69 (Nexus-Battle-Commerce, "pendientes de recoger")
      // pueda registrar el producto ganado sin una consulta adicional.
      await transaction
        .insertInto('outbox_events')
        .values({
          id: randomUUID(),
          aggregate_id: command.auctionId,
          event_type: 'auction.closed_by_buy_now.v1',
          payload: {
            auctionId: command.auctionId,
            productId: auctionRow.product_id,
            sellerId: auctionRow.seller_id,
            buyerId: command.buyerId,
            priceCredits: command.priceCredits,
            transactionId: command.transactionId,
            closedAt: command.closedAt,
          },
          occurred_at: command.closedAt,
          published_at: null,
        })
        .execute()

      const auction = await findAuction(transaction, command.auctionId)

      if (auction === null) {
        throw new PersistedAuctionNotFoundError(command.auctionId)
      }

      return {
        auction,
        transactionId: command.transactionId,
        replayed: false,
      }
    })
  }

  async recordBuyNowFailure(command: RecordBuyNowFailureCommand): Promise<void> {
    await this.db
      .insertInto('auction_buy_now_failures')
      .values({
        operation_id: command.operationId,
        auction_id: command.auctionId,
        buyer_id: command.buyerId,
        stage: command.stage,
        reason: command.reason,
        transfer_id: command.transferId,
        credits_reversed: command.creditsReversed,
        occurred_at: command.occurredAt,
      })
      .onConflict((conflict) =>
        conflict.column('operation_id').doUpdateSet({
          stage: command.stage,
          reason: command.reason,
          transfer_id: command.transferId,
          credits_reversed: command.creditsReversed,
          occurred_at: command.occurredAt,
        }),
      )
      .execute()
  }

  async findBuyNowOperation(operationId: string): Promise<BuyNowOperationRecord | null> {
    const operation = await this.db
      .selectFrom('auction_buy_now_operations')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirst()

    if (operation === undefined) {
      return null
    }

    const auction = await findAuction(this.db, operation.auction_id)

    if (auction === null) {
      throw new PersistedAuctionNotFoundError(operation.auction_id)
    }

    return {
      auction,
      transactionId: operation.transaction_id,
      buyerId: operation.buyer_id,
      transferId: operation.transfer_id,
      priceCredits: operation.price_credits,
      remainingCredits: operation.remaining_credits,
      completedAt: new Date(operation.completed_at),
    }
  }

  async findBuyNowOperationByAuctionId(auctionId: string): Promise<BuyNowOperationRecord | null> {
    const operation = await this.db
      .selectFrom('auction_buy_now_operations')
      .select('operation_id')
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()
    return operation === undefined ? null : this.findBuyNowOperation(operation.operation_id)
  }
}
