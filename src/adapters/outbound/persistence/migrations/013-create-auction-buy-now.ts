import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`alter table auctions drop constraint auctions_status_valid`.execute(db)
  await sql`
    alter table auctions
    add constraint auctions_status_valid check (status in ('ACTIVE', 'SOLD'))
  `.execute(db)

  await db.schema
    .createTable('auction_buy_now_operations')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('request_hash', 'text', (column) => column.notNull())
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('buyer_id', 'text', (column) => column.notNull())
    .addColumn('transfer_id', 'text', (column) => column.notNull())
    .addColumn('price_credits', 'integer', (column) => column.notNull())
    .addColumn('transaction_id', 'text', (column) => column.notNull().unique())
    .addColumn('completed_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('auction_buy_now_operations_price_positive', sql`price_credits > 0`)
    .execute()

  // Una subasta solo puede venderse por compra inmediata una vez: protege
  // contra dos operaciones DISTINTAS (operation_id distinto) que ganaran la
  // carrera antes de que el bloqueo consultivo de `closeByBuyNow` decidiera.
  await db.schema
    .createIndex('auction_buy_now_operations_auction_uq')
    .on('auction_buy_now_operations')
    .column('auction_id')
    .unique()
    .execute()

  await db.schema
    .createTable('auction_buy_now_failures')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('buyer_id', 'text', (column) => column.notNull())
    .addColumn('stage', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('transfer_id', 'text')
    .addColumn('credits_reversed', 'boolean', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_buy_now_failures').execute()
  await db.schema.dropIndex('auction_buy_now_operations_auction_uq').execute()
  await db.schema.dropTable('auction_buy_now_operations').execute()
  await sql`alter table auctions drop constraint auctions_status_valid`.execute(db)
  await sql`
    alter table auctions
    add constraint auctions_status_valid check (status in ('ACTIVE'))
  `.execute(db)
}
