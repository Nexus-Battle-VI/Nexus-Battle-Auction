import type { Kysely } from 'kysely'

/**
 * HU-90 (PR3), `7.7.10`. Reconciliacion durable de cancelaciones con efectos
 * externos pendientes.
 *
 * `auction_cancellations` gana `lease_owner`/`lease_until`, mismo par de
 * columnas (mismo nombre, mismo tipo) que `auction_settlement_work` ya usa
 * para el reclamo de settlement: el reconciler reclama filas con
 * `FOR UPDATE SKIP LOCKED` y un lease corto, en vez de mantener abierta una
 * transaccion durante las llamadas HTTP a Wallet/Inventory. No se crea una
 * tabla de trabajo separada porque `auction_cancellations` ya es una fila por
 * subasta con todo lo que el reconciler necesita leer.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('auction_cancellations').addColumn('lease_owner', 'text').execute()
  await db.schema
    .alterTable('auction_cancellations')
    .addColumn('lease_until', 'timestamptz')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('auction_cancellations').dropColumn('lease_until').execute()
  await db.schema.alterTable('auction_cancellations').dropColumn('lease_owner').execute()
}
