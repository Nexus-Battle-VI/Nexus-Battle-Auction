import { sql, type Kysely } from 'kysely'
import type { Database } from '../schema'

export const up = async (db: Kysely<Database>): Promise<void> => {
  await db.schema.alterTable('auction_settlements').addColumn('settled_at', 'timestamptz').execute()
  await db.schema
    .createTable('auction_pending_claims')
    .addColumn('auction_id', 'varchar(200)', (column) =>
      column.primaryKey().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('winner_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('product_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('winning_bid_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('final_amount_credits', 'bigint', (column) => column.notNull())
    .addColumn('settled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('claim_status', 'varchar(20)', (column) => column.notNull().defaultTo('PENDING'))
    .addColumn('claimed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('auction_pending_claims_amount_positive', sql`final_amount_credits > 0`)
    .addCheckConstraint(
      'auction_pending_claims_status_valid',
      sql`claim_status in ('PENDING', 'CLAIMED')`,
    )
    .addCheckConstraint(
      'auction_pending_claims_claimed_at_valid',
      sql`(claim_status = 'PENDING' and claimed_at is null) or (claim_status = 'CLAIMED' and claimed_at is not null)`,
    )
    .execute()
  await db.schema
    .createIndex('auction_pending_claims_winner_pending_idx')
    .on('auction_pending_claims')
    .columns(['winner_id', 'claim_status', 'settled_at'])
    .execute()
}
export const down = async (db: Kysely<Database>): Promise<void> => {
  await db.schema.dropTable('auction_pending_claims').execute()
  await db.schema.alterTable('auction_settlements').dropColumn('settled_at').execute()
}
