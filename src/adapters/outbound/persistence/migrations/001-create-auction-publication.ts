import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('auctions')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('seller_id', 'text', (column) => column.notNull())
    .addColumn('product_id', 'text', (column) => column.notNull())
    .addColumn('duration_hours', 'smallint', (column) => column.notNull())
    .addColumn('publication_fee_credits', 'integer', (column) => column.notNull())
    .addColumn('minimum_bid_credits', 'integer', (column) => column.notNull())
    .addColumn('buy_now_credits', 'integer')
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('published_at', 'timestamptz', (column) => column.notNull())
    .addColumn('closes_at', 'timestamptz', (column) => column.notNull())
    .addColumn('inventory_commitment_id', 'text', (column) => column.notNull())
    .addColumn('fee_charge_id', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('auctions_duration_valid', sql`duration_hours in (24, 48)`)
    .addCheckConstraint('auctions_fee_positive', sql`publication_fee_credits > 0`)
    .addCheckConstraint('auctions_minimum_bid_positive', sql`minimum_bid_credits > 0`)
    .addCheckConstraint(
      'auctions_buy_now_valid',
      sql`buy_now_credits is null or buy_now_credits > minimum_bid_credits`,
    )
    .addCheckConstraint('auctions_status_valid', sql`status in ('ACTIVE')`)
    .addCheckConstraint('auctions_dates_valid', sql`closes_at > published_at`)
    .execute()

  await db.schema
    .createIndex('auctions_active_seller_idx')
    .on('auctions')
    .columns(['seller_id', 'status'])
    .execute()
  await sql`
    create unique index auctions_active_product_uq
    on auctions (product_id) where status = 'ACTIVE'
  `.execute(db)

  await db.schema
    .createTable('auction_publication_operations')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('request_hash', 'text', (column) => column.notNull())
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().unique().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('completed_at', 'timestamptz', (column) => column.notNull())
    .execute()

  await db.schema
    .createTable('auction_audit_log')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('operation_id', 'text', (column) => column.notNull())
    .addColumn('action', 'text', (column) => column.notNull())
    .addColumn('actor_id', 'text', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('details', 'jsonb', (column) => column.notNull())
    .execute()

  await db.schema
    .createTable('auction_publication_failures')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('seller_id', 'text', (column) => column.notNull())
    .addColumn('stage', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('fee_charge_id', 'text')
    .addColumn('inventory_commitment_id', 'text')
    .addColumn('fee_refunded', 'boolean', (column) => column.notNull())
    .addColumn('inventory_released', 'boolean', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .execute()

  await db.schema
    .createTable('outbox_events')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('aggregate_id', 'text', (column) => column.notNull())
    .addColumn('event_type', 'text', (column) => column.notNull())
    .addColumn('payload', 'jsonb', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('published_at', 'timestamptz')
    .execute()
  await sql`
    create index outbox_events_pending_idx
    on outbox_events (occurred_at) where published_at is null
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('outbox_events').execute()
  await db.schema.dropTable('auction_publication_failures').execute()
  await db.schema.dropTable('auction_audit_log').execute()
  await db.schema.dropTable('auction_publication_operations').execute()
  await db.schema.dropTable('auctions').execute()
}
