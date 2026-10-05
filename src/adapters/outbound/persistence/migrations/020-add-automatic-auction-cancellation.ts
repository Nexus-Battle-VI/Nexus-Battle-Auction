import { sql, type Kysely } from 'kysely'

/**
 * HU-90, CA-05. Cancelacion automatica por sancion AUCTION_TERMS_VIOLATION.
 *
 * `auction_cancellations` ya es una fila por subasta cancelada, asi que es
 * el lugar natural para la trazabilidad -no se toca `auctions`-:
 * - `origin`: `MANUAL` (lo unico que existia; por eso es el default y las
 *   filas previas quedan clasificadas sin backfill) o `TERMS_VIOLATION`.
 * - `trigger_reference_id`: id de la sancion de Account que la disparo.
 *
 * Una automatica NO reembolsa la comision de publicacion: su refund es 0,
 * no tiene `wallet_refund_operation_id` y su estado es `NOT_REQUIRED`. Las
 * dos restricciones previas (monto en 0.5/1.5, estado en los cuatro valores)
 * se sustituyen por una sola discriminada por `origin`, que conserva intacta
 * la regla manual.
 *
 * `auction_cancellation_reservation_releases`: una automatica puede ocurrir
 * con pujas, y cada reserva de creditos que pueda seguir activa en Wallet se
 * libera y se reconcilia por separado (una fila por reserva), mismo
 * vocabulario de estado que el resto de efectos de la cancelacion.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('auction_cancellations')
    .addColumn('origin', 'varchar(20)', (column) => column.notNull().defaultTo('MANUAL'))
    .execute()
  await db.schema
    .alterTable('auction_cancellations')
    .addColumn('trigger_reference_id', 'text')
    .execute()

  await sql`
    alter table auction_cancellations alter column wallet_refund_operation_id drop not null
  `.execute(db)
  await sql`
    alter table auction_cancellations drop constraint auction_cancellations_refund_amount_valid
  `.execute(db)
  await sql`
    alter table auction_cancellations
    drop constraint auction_cancellations_wallet_refund_status_valid
  `.execute(db)
  await sql`
    alter table auction_cancellations
    add constraint auction_cancellations_origin_valid check (
      (
        origin = 'MANUAL' and
        trigger_reference_id is null and
        refund_amount_credits in (0.5, 1.5) and
        wallet_refund_operation_id is not null and
        wallet_refund_status in ('PENDING', 'CONFIRMED', 'RETRYABLE', 'TERMINAL_ERROR')
      ) or (
        origin = 'TERMS_VIOLATION' and
        trigger_reference_id is not null and
        refund_amount_credits = 0 and
        wallet_refund_operation_id is null and
        wallet_refund_status = 'NOT_REQUIRED'
      )
    )
  `.execute(db)

  await db.schema
    .createTable('auction_cancellation_reservation_releases')
    .addColumn('auction_id', 'text', (column) =>
      column.notNull().references('auction_cancellations.auction_id').onDelete('restrict'),
    )
    .addColumn('reservation_id', 'text', (column) => column.notNull())
    .addColumn('operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('status', 'varchar(20)', (column) => column.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('auction_cancellation_reservation_releases_pk', [
      'auction_id',
      'reservation_id',
    ])
    .addCheckConstraint(
      'auction_cancellation_reservation_releases_status_valid',
      sql`status in ('PENDING', 'CONFIRMED', 'RETRYABLE', 'TERMINAL_ERROR')`,
    )
    .execute()
}

/**
 * Solo reversible mientras no exista ninguna cancelacion automatica: una
 * fila `TERMS_VIOLATION` no cumple las restricciones manuales que se
 * restauran, y borrarla perderia la trazabilidad de una subasta cancelada.
 */
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('auction_cancellation_reservation_releases').execute()
  await sql`
    alter table auction_cancellations drop constraint auction_cancellations_origin_valid
  `.execute(db)
  await sql`
    alter table auction_cancellations
    add constraint auction_cancellations_wallet_refund_status_valid check (
      wallet_refund_status in ('PENDING', 'CONFIRMED', 'RETRYABLE', 'TERMINAL_ERROR')
    )
  `.execute(db)
  await sql`
    alter table auction_cancellations
    add constraint auction_cancellations_refund_amount_valid check (
      refund_amount_credits in (0.5, 1.5)
    )
  `.execute(db)
  await sql`
    alter table auction_cancellations alter column wallet_refund_operation_id set not null
  `.execute(db)
  await db.schema.alterTable('auction_cancellations').dropColumn('trigger_reference_id').execute()
  await db.schema.alterTable('auction_cancellations').dropColumn('origin').execute()
}
