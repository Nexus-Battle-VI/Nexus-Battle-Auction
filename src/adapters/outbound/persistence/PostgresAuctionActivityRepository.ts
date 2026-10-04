import { sql, type Kysely } from 'kysely'

import type {
  AuctionActivityRepositoryPort,
  AuctionTransactionType,
  OwnedAuctionPageInput,
  PersonalAuctionPage,
  PersonalAuctionTransaction,
  PersonalBidPage,
  PersonalPageInput,
  PersonalTransactionPage,
} from '../../../application/ports/AuctionActivityRepositoryPort'
import { AuctionStatus, CANCELLATION_WINDOW_MS } from '../../../domain/entities/Auction'
import type { Database } from './schema'

interface TransactionRow {
  readonly id: string
  readonly auction_id: string
  readonly type: AuctionTransactionType
  readonly reference: string
  readonly occurred_at: Date
  readonly status: string
  readonly amount: number | string | null
}

/** Adaptador de lectura aislado para las vistas privadas de HU-89. */
export class PostgresAuctionActivityRepository implements AuctionActivityRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async listOwnedAuctions(input: OwnedAuctionPageInput): Promise<PersonalAuctionPage> {
    const offset = (input.page - 1) * input.pageSize
    const base = this.db
      .selectFrom('auctions')
      .where('auctions.seller_id', '=', input.playerId)
      .where('auctions.price_kind', '=', 'CREDITS')
    const [rows, count] = await Promise.all([
      base
        .select([
          'auctions.id',
          'auctions.product_id',
          'auctions.status',
          'auctions.minimum_bid_credits',
          'auctions.buy_now_credits',
          'auctions.published_at',
          'auctions.closes_at',
          'auctions.finished_at',
          'auctions.cancelled_at',
          sql<number>`(select count(*)::integer from auction_bids b where b.auction_id = auctions.id)`.as(
            'bid_count',
          ),
          sql<
            number | null
          >`(select b.amount_credits from auction_bids b where b.auction_id = auctions.id and b.is_leader = true limit 1)`.as(
            'current_bid_credits',
          ),
        ])
        .orderBy('auctions.published_at', 'desc')
        .orderBy('auctions.id', 'asc')
        .limit(input.pageSize)
        .offset(offset)
        .execute(),
      base.select(sql<number>`count(*)::integer`.as('total')).executeTakeFirstOrThrow(),
    ])

    return {
      total: count.total,
      items: rows.map((row) => {
        const status = row.status as AuctionStatus
        return {
          auctionId: row.id,
          productId: row.product_id,
          status,
          minimumBidCredits: row.minimum_bid_credits ?? 0,
          buyNowCredits: row.buy_now_credits,
          currentBidCredits: row.current_bid_credits,
          bidCount: row.bid_count,
          publishedAt: new Date(row.published_at),
          closesAt: new Date(row.closes_at),
          finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
          cancelledAt: row.cancelled_at === null ? null : new Date(row.cancelled_at),
          actions: {
            view: true,
            cancel:
              status === AuctionStatus.Active &&
              row.bid_count === 0 &&
              new Date(row.closes_at).getTime() - input.now.getTime() > CANCELLATION_WINDOW_MS,
          },
        }
      }),
    }
  }

  async listBidParticipations(input: PersonalPageInput): Promise<PersonalBidPage> {
    const offset = (input.page - 1) * input.pageSize
    const latest = this.db
      .selectFrom('auction_bids as own')
      .distinctOn('own.auction_id')
      .select([
        'own.auction_id',
        'own.amount_credits as own_amount_credits',
        'own.placed_at as own_placed_at',
      ])
      .where('own.bidder_id', '=', input.playerId)
      .orderBy('own.auction_id', 'asc')
      .orderBy('own.placed_at', 'desc')
      .orderBy('own.id', 'desc')
      .as('latest')

    const [rows, count] = await Promise.all([
      this.db
        .selectFrom(latest)
        .innerJoin('auctions', 'auctions.id', 'latest.auction_id')
        .leftJoin('auction_bids as leader', (join) =>
          join
            .onRef('leader.auction_id', '=', 'latest.auction_id')
            .on('leader.is_leader', '=', true),
        )
        .select([
          'latest.auction_id',
          'latest.own_amount_credits',
          'latest.own_placed_at',
          'auctions.product_id',
          'auctions.status',
          'auctions.winner_id',
          'auctions.final_amount_credits',
          'auctions.closes_at',
          'leader.bidder_id as leader_bidder_id',
          'leader.amount_credits as leader_amount_credits',
        ])
        .orderBy('latest.own_placed_at', 'desc')
        .orderBy('latest.auction_id', 'asc')
        .limit(input.pageSize)
        .offset(offset)
        .execute(),
      this.db
        .selectFrom('auction_bids')
        .select(sql<number>`count(distinct auction_id)::integer`.as('total'))
        .where('bidder_id', '=', input.playerId)
        .executeTakeFirstOrThrow(),
    ])

    return {
      total: count.total,
      items: rows.map((row) => {
        const status = row.status as AuctionStatus
        return {
          auctionId: row.auction_id,
          productId: row.product_id,
          auctionStatus: status,
          participationStatus:
            status === AuctionStatus.Active
              ? row.leader_bidder_id === input.playerId
                ? 'LEADING'
                : 'OUTBID'
              : row.winner_id === input.playerId
                ? 'WON'
                : 'LOST',
          ownLatestBidCredits: row.own_amount_credits,
          ownLatestBidAt: new Date(row.own_placed_at),
          currentBidCredits:
            row.leader_amount_credits ??
            (row.final_amount_credits === null ? null : Number(row.final_amount_credits)),
          closesAt: new Date(row.closes_at),
        }
      }),
    }
  }

  async listTransactions(input: PersonalPageInput): Promise<PersonalTransactionPage> {
    const offset = (input.page - 1) * input.pageSize
    const history = sql<TransactionRow>`
      select 'publication:' || p.operation_id as id, p.auction_id,
        'PUBLICATION_FEE' as type, p.operation_id as reference,
        p.completed_at as occurred_at, 'COMPLETED' as status,
        a.publication_fee_credits as amount
      from auction_publication_operations p
      join auctions a on a.id = p.auction_id
      where a.seller_id = ${input.playerId} and a.price_kind = 'CREDITS'
      union all
      select 'bid:' || b.operation_id, b.auction_id,
        'BID_RESERVATION', b.operation_id, b.created_at, b.status, b.amount_credits
      from auction_bid_credit_operations b where b.bidder_id = ${input.playerId}
      union all
      select 'buy-now:' || n.operation_id, n.auction_id,
        'BUY_NOW_PURCHASE', n.transaction_id, n.completed_at, 'COMPLETED', n.price_credits
      from auction_buy_now_operations n where n.buyer_id = ${input.playerId}
      union all
      select 'settlement-sale:' || s.auction_id, s.auction_id,
        'SETTLEMENT_SALE', coalesce(s.capture_operation_id, s.auction_id),
        coalesce(s.settled_at, s.updated_at), s.status, s.final_amount_credits
      from auction_settlements s where s.seller_id = ${input.playerId}
      union all
      select 'settlement-win:' || s.auction_id, s.auction_id,
        'SETTLEMENT_WIN', coalesce(s.capture_operation_id, s.auction_id),
        coalesce(s.settled_at, s.updated_at), s.status, s.final_amount_credits
      from auction_settlements s where s.winner_id = ${input.playerId}
      union all
      select 'cancellation:' || c.operation_id, c.auction_id,
        'CANCELLATION_REFUND', c.wallet_refund_operation_id, c.cancelled_at,
        c.wallet_refund_status, c.refund_amount_credits
      from auction_cancellations c where c.seller_id = ${input.playerId}
      union all
      select 'claim:' || c.auction_id, c.auction_id,
        'PRODUCT_CLAIM', c.auction_id, coalesce(c.claimed_at, c.updated_at),
        c.claim_status, c.final_amount_credits
      from auction_pending_claims c where c.winner_id = ${input.playerId}
    `
    const [pageResult, countResult] = await Promise.all([
      sql<TransactionRow>`select * from (${history}) h order by occurred_at desc, id asc limit ${input.pageSize} offset ${offset}`.execute(
        this.db,
      ),
      sql<{
        total: number | string
      }>`select count(*)::integer as total from (${history}) h`.execute(this.db),
    ])
    return {
      total: Number(countResult.rows[0]?.total ?? 0),
      items: pageResult.rows.map((row): PersonalAuctionTransaction => ({
        id: row.id,
        auctionId: row.auction_id,
        type: row.type,
        reference: row.reference,
        occurredAt: new Date(row.occurred_at),
        status: row.status,
        value: row.amount === null ? null : { amount: Number(row.amount), unit: 'CREDITS' },
      })),
    }
  }
}
