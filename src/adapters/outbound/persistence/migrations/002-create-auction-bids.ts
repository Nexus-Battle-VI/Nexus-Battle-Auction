import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('auction_bids')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('bidder_id', 'text', (column) => column.notNull())
    .addColumn('amount_credits', 'integer', (column) => column.notNull())
    .addColumn('placed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('is_leader', 'boolean', (column) => column.notNull().defaultTo(false))
    .addCheckConstraint('auction_bids_amount_positive', sql`amount_credits > 0`)
    .execute()

  await db.schema
    .createIndex('auction_bids_auction_history_idx')
    .on('auction_bids')
    .columns(['auction_id', 'placed_at'])
    .execute()

  await db.schema
    .createIndex('auction_bids_bidder_idx')
    .on('auction_bids')
    .columns(['bidder_id', 'placed_at'])
    .execute()

  await sql`
    create unique index auction_bids_single_leader_uq
    on auction_bids (auction_id)
    where is_leader = true
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_bids').execute()
}
