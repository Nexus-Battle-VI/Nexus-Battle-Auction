import { sql, type Kysely } from 'kysely'

/**
 * HU-90 (PR3), `7.7.10`. Cancelacion manual de una subasta activa.
 *
 * `auctions` gana `cancelled_at` (espejo de `finished_at`: no nulo si y solo
 * si `status = 'CANCELLED'`) y el estado terminal se agrega al CHECK
 * existente (mismo patron que la migracion 013 con `SOLD`).
 *
 * Dos tablas nuevas, mismo patron que publicacion/compra inmediata:
 * - `auction_cancellation_operations`: idempotencia del endpoint
 *   (`operation_id` + `request_hash`), igual que `auction_buy_now_operations`.
 * - `auction_cancellations`: progreso de los DOS efectos externos (refund
 *   parcial en Wallet, release en Player-Inventory), una fila por subasta,
 *   mismo vocabulario de estado (`PENDING/CONFIRMED/RETRYABLE/TERMINAL_ERROR`)
 *   que ya usa `auction_inventory_settlement_intents.status`.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('auctions').addColumn('cancelled_at', 'timestamptz').execute()

  await sql`alter table auctions drop constraint auctions_status_valid`.execute(db)
  await sql`
    alter table auctions
    add constraint auctions_status_valid check (status in ('ACTIVE', 'FINISHED', 'SOLD', 'CANCELLED'))
  `.execute(db)
  await sql`
    alter table auctions
    add constraint auctions_cancelled_at_valid check (
      (status = 'CANCELLED' and cancelled_at is not null) or
      (status <> 'CANCELLED' and cancelled_at is null)
    )
  `.execute(db)

  await db.schema
    .createTable('auction_cancellation_operations')
    .addColumn('operation_id', 'text', (column) => column.primaryKey())
    .addColumn('request_hash', 'text', (column) => column.notNull())
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('completed_at', 'timestamptz', (column) => column.notNull())
    .execute()

  // Protege contra dos operaciones DISTINTAS que ganaran la carrera antes de
  // que el bloqueo consultivo de `cancelAuction` decidiera (mismo motivo que
  // `auction_buy_now_operations_auction_uq` de la migracion 013).
  await db.schema
    .createIndex('auction_cancellation_operations_auction_uq')
    .on('auction_cancellation_operations')
    .column('auction_id')
    .unique()
    .execute()

  await db.schema
    .createTable('auction_cancellations')
    .addColumn('auction_id', 'text', (column) =>
      column.primaryKey().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('seller_id', 'text', (column) => column.notNull())
    .addColumn('product_id', 'text', (column) => column.notNull())
    .addColumn('inventory_commitment_id', 'text', (column) => column.notNull())
    .addColumn('fee_charge_id', 'text')
    .addColumn('refund_amount_credits', 'numeric', (column) => column.notNull())
    .addColumn('wallet_refund_operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('wallet_refund_status', 'varchar(20)', (column) => column.notNull())
    .addColumn('wallet_refund_last_error', 'text')
    .addColumn('inventory_release_operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('inventory_release_status', 'varchar(20)', (column) => column.notNull())
    .addColumn('inventory_release_last_error', 'text')
    .addColumn('cancelled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint(
      'auction_cancellations_refund_amount_valid',
      // `7.7.10`: la base es siempre 1 o 3 creditos, asi que el 50% es
      // siempre 0.5 o 1.5 -nunca una fraccion arbitraria-.
      sql`refund_amount_credits in (0.5, 1.5)`,
    )
    .addCheckConstraint(
      'auction_cancellations_wallet_refund_status_valid',
      sql`wallet_refund_status in ('PENDING', 'CONFIRMED', 'RETRYABLE', 'TERMINAL_ERROR')`,
    )
    .addCheckConstraint(
      'auction_cancellations_inventory_release_status_valid',
      sql`inventory_release_status in ('PENDING', 'CONFIRMED', 'RETRYABLE', 'TERMINAL_ERROR')`,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_cancellations').execute()
  await db.schema.dropIndex('auction_cancellation_operations_auction_uq').execute()
  await db.schema.dropTable('auction_cancellation_operations').execute()
  await sql`alter table auctions drop constraint auctions_cancelled_at_valid`.execute(db)
  await sql`alter table auctions drop constraint auctions_status_valid`.execute(db)
  await sql`
    alter table auctions
    add constraint auctions_status_valid check (status in ('ACTIVE', 'FINISHED', 'SOLD'))
  `.execute(db)
  await db.schema.alterTable('auctions').dropColumn('cancelled_at').execute()
}
