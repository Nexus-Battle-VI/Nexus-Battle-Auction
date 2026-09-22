import { sql, type Kysely } from 'kysely'

/** Refuerza en PostgreSQL identidad, unicidad y referencia solo dentro de Auction. */
export const up = async <DB>(db: Kysely<DB>): Promise<void> => {
  await db.schema
    .createTable('auction_watchlist')
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('auction_id', 'text', (column) => column.notNull())
    .addColumn('followed_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('auction_watchlist_pkey', ['player_id', 'auction_id'])
    .addForeignKeyConstraint(
      'auction_watchlist_auction_fk',
      ['auction_id'],
      'auctions',
      ['id'],
      (constraint) => constraint.onDelete('restrict'),
    )
    .addCheckConstraint(
      'auction_watchlist_player_valid',
      sql`player_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$'`,
    )
    .addCheckConstraint('auction_watchlist_date_finite', sql`isfinite(followed_at)`)
    .execute()
  await db.schema
    .createIndex('auction_watchlist_auction_idx')
    .on('auction_watchlist')
    .column('auction_id')
    .execute()
}

/** Rollback explicito: elimina seguimientos, nunca subastas, pujas ni usuarios. */
export const down = async <DB>(db: Kysely<DB>): Promise<void> => {
  await db.schema.dropTable('auction_watchlist').execute()
}
