import { type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('auction_bid_credit_failures')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('bid_id', 'text', (column) => column.notNull())
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('bidder_id', 'text', (column) => column.notNull())
    .addColumn('stage', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('new_reservation_id', 'text')
    .addColumn('previous_reservation_id', 'text')
    .addColumn('new_reservation_released', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('previous_reservation_released', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .execute()

  await db.schema
    .createIndex('auction_bid_credit_failures_auction_idx')
    .on('auction_bid_credit_failures')
    .column('auction_id')
    .execute()

  await db.schema
    .createIndex('auction_bid_credit_failures_bidder_idx')
    .on('auction_bid_credit_failures')
    .column('bidder_id')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_bid_credit_failures').execute()
}
