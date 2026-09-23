// HU-65.2: sigue a la migracion 006 reservada por HU-67.
import { sql, type Kysely } from 'kysely'
import type { Database } from '../schema'

export const up = async (db: Kysely<Database>): Promise<void> => {
  await db.schema
    .alterTable('auctions')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('closing_result_type', 'varchar(30)')
    .addColumn('winning_bid_id', 'varchar(200)')
    .addColumn('winner_id', 'varchar(200)')
    .addColumn('final_amount_credits', 'bigint')
    .execute()
  await sql`alter table auctions drop constraint auctions_status_valid`.execute(db)
  await sql`alter table auctions add constraint auctions_status_valid check (status in ('ACTIVE','FINISHED'))`.execute(
    db,
  )
  await db.schema
    .createTable('auction_settlements')
    .addColumn('auction_id', 'varchar(200)', (c) => c.primaryKey())
    .addColumn('status', 'varchar(40)', (c) => c.notNull())
    .addColumn('result_type', 'varchar(30)', (c) => c.notNull())
    .addColumn('winning_bid_id', 'varchar(200)')
    .addColumn('winner_id', 'varchar(200)')
    .addColumn('winning_hold_id', 'varchar(200)')
    .addColumn('seller_id', 'varchar(200)', (c) => c.notNull())
    .addColumn('final_amount_credits', 'bigint')
    .addColumn('capture_operation_id', 'varchar(300)', (c) => c.unique())
    .addColumn('capture_status', 'varchar(40)', (c) => c.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint(
      'auction_settlements_status_check',
      sql`status in ('PENDING','CAPTURE_PENDING','CAPTURED','LOSER_RELEASES_PENDING','COMPLETED','FAILED_RETRYABLE','FAILED_TERMINAL')`,
    )
    .addCheckConstraint(
      'auction_settlements_result_check',
      sql`result_type in ('WITH_WINNER','WITHOUT_BIDS')`,
    )
    .addCheckConstraint(
      'auction_settlements_capture_status_check',
      sql`capture_status in ('NOT_REQUIRED','PENDING','CONFIRMED','RETRYABLE','TERMINAL_ERROR')`,
    )
    .addCheckConstraint(
      'auction_settlements_winner_check',
      sql`(result_type = 'WITHOUT_BIDS' and winning_bid_id is null and winner_id is null and winning_hold_id is null and final_amount_credits is null) or (result_type = 'WITH_WINNER' and winning_bid_id is not null and winner_id is not null and winning_hold_id is not null and final_amount_credits is not null)`,
    )
    .execute()
  await db.schema
    .createTable('auction_settlement_releases')
    .addColumn('auction_id', 'varchar(200)', (c) => c.notNull())
    .addColumn('bid_id', 'varchar(200)', (c) => c.notNull())
    .addColumn('hold_id', 'varchar(200)', (c) => c.notNull())
    .addColumn('operation_id', 'varchar(300)', (c) => c.notNull().unique())
    .addColumn('status', 'varchar(40)', (c) => c.notNull())
    .addColumn('reason', 'varchar(40)', (c) => c.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('auction_settlement_releases_pk', ['auction_id', 'bid_id'])
    .addCheckConstraint(
      'auction_settlement_releases_status_check',
      sql`status in ('PENDING','RELEASED','RETRYABLE','TERMINAL_ERROR')`,
    )
    .addCheckConstraint(
      'auction_settlement_releases_reason_check',
      sql`reason = 'AUCTION_SETTLEMENT_LOST'`,
    )
    .execute()
}
export const down = async (db: Kysely<Database>): Promise<void> => {
  await db.schema.dropTable('auction_settlement_releases').execute()
  await db.schema.dropTable('auction_settlements').execute()
  await db.schema
    .alterTable('auctions')
    .dropColumn('finished_at')
    .dropColumn('closing_result_type')
    .dropColumn('winning_bid_id')
    .dropColumn('winner_id')
    .dropColumn('final_amount_credits')
    .execute()
  await sql`alter table auctions drop constraint auctions_status_valid`.execute(db)
  await sql`alter table auctions add constraint auctions_status_valid check (status in ('ACTIVE'))`.execute(
    db,
  )
}
