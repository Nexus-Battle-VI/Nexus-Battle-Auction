import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('auction_early_closure_notifications')
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('bidder_id', 'text', (column) => column.notNull())
    .addColumn('transaction_id', 'text', (column) => column.notNull())
    .addColumn('bid_id', 'text', (column) => column.notNull())
    .addColumn('amount_credits', 'integer', (column) => column.notNull())
    .addColumn('closed_at', 'timestamptz', (column) => column.notNull())
    /*
     * NULL en ambas cuando esta puja ya no tenia nada que liberar -toda puja
     * desplazada libero su reserva en tiempo real, HU-63.2/63.4-: solo la
     * puja que segua siendo lider al momento del cierre las trae.
     */
    .addColumn('credit_operation_id', 'text')
    .addColumn('credit_reservation_id', 'text')
    .addColumn('status', 'text', (column) => column.notNull().defaultTo('PENDING'))
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('credits_released', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('auction_early_closure_notifications_pk', [
      'auction_id',
      'bidder_id',
      'transaction_id',
    ])
    .addCheckConstraint(
      'auction_early_closure_notifications_status_valid',
      sql`status in ('PENDING', 'SENT', 'FAILED')`,
    )
    .addCheckConstraint('auction_early_closure_notifications_attempts_valid', sql`attempts >= 0`)
    .execute()

  await db.schema
    .createIndex('auction_early_closure_notifications_failed_idx')
    .on('auction_early_closure_notifications')
    .column('status')
    .where('status', '=', 'FAILED')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_early_closure_notifications').execute()
}
