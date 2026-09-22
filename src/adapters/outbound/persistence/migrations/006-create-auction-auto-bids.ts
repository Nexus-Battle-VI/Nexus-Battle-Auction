import { sql, type Kysely } from 'kysely'

/** Un jugador solo puede tener una configuracion de puja automatica activa por subasta. */
export const up = async <DB>(db: Kysely<DB>): Promise<void> => {
  await db.schema
    .createTable('auction_auto_bids')
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('bidder_id', 'text', (column) => column.notNull())
    .addColumn('max_amount_credits', 'integer', (column) => column.notNull())
    .addColumn('is_active', 'boolean', (column) => column.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('auction_auto_bids_pkey', ['auction_id', 'bidder_id'])
    .addForeignKeyConstraint(
      'auction_auto_bids_auction_fk',
      ['auction_id'],
      'auctions',
      ['id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .addCheckConstraint('auction_auto_bids_amount_positive', sql`max_amount_credits > 0`)
    .execute()

  await db.schema
    .createIndex('auction_auto_bids_active_idx')
    .on('auction_auto_bids')
    .columns(['auction_id', 'is_active'])
    .execute()
}

export const down = async <DB>(db: Kysely<DB>): Promise<void> => {
  await db.schema.dropTable('auction_auto_bids').execute()
}
