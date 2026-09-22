import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('auction_bid_credit_operations')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('bid_id', 'text', (column) => column.notNull().unique())
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('bidder_id', 'text', (column) => column.notNull())
    .addColumn('amount_credits', 'integer', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('reservation_id', 'text')
    .addColumn('previous_reservation_id', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('auction_bid_credit_operations_amount_positive', sql`amount_credits > 0`)
    .addCheckConstraint(
      'auction_bid_credit_operations_status_valid',
      sql`
        status in (
          'PENDING_RESERVATION',
          'RESERVED',
          'BID_PERSISTED',
          'COMPLETED',
          'COMPENSATION_PENDING',
          'COMPENSATED'
        )
      `,
    )
    .execute()

  await db.schema
    .createIndex('auction_bid_credit_operations_auction_idx')
    .on('auction_bid_credit_operations')
    .column('auction_id')
    .execute()

  await db.schema
    .createIndex('auction_bid_credit_operations_bidder_idx')
    .on('auction_bid_credit_operations')
    .column('bidder_id')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_bid_credit_operations').execute()
}
