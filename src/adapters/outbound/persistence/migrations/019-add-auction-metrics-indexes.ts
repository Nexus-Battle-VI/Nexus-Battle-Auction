import { sql, type Kysely } from 'kysely'

/**
 * HU-91.2 (R-06 del contrato `hu-91-auction-metrics-v1`). Indices para los
 * filtros por periodo de las metricas de Subasta: hasta la migracion 018 no
 * existia ninguno sobre estas columnas y cada consulta escaneaba la tabla.
 *
 * - `auctions(published_at)` completo: lo usan el volumen de jugador Y el
 *   oficial (`price_kind` distinto), asi que no es parcial.
 * - `finished_at` y `cancelled_at`: parciales por estado y `price_kind='CREDITS'`,
 *   igual que las consultas (solo subastas de jugador).
 * - `auction_bids(placed_at)` y `auction_buy_now_operations(completed_at)`:
 *   actividad y cierre por compra inmediata (HU-91.5 reutiliza ambos).
 *
 * `CREATE INDEX` sin `CONCURRENTLY`: el migrador de Kysely ejecuta cada
 * migracion dentro de una transaccion y `CONCURRENTLY` no puede correr en una.
 * Bloquea escrituras mientras se construye; con el volumen actual es breve,
 * pero es un dato a considerar si la tabla creciera antes del despliegue.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`
    create index auctions_published_at_idx on auctions (published_at)
  `.execute(db)
  await sql`
    create index auctions_finished_at_credits_idx on auctions (finished_at)
    where price_kind = 'CREDITS' and status = 'FINISHED'
  `.execute(db)
  await sql`
    create index auctions_cancelled_at_credits_idx on auctions (cancelled_at)
    where price_kind = 'CREDITS' and status = 'CANCELLED'
  `.execute(db)
  await sql`
    create index auction_bids_placed_at_idx on auction_bids (placed_at)
  `.execute(db)
  await sql`
    create index auction_buy_now_operations_completed_at_idx
    on auction_buy_now_operations (completed_at)
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`drop index auction_buy_now_operations_completed_at_idx`.execute(db)
  await sql`drop index auction_bids_placed_at_idx`.execute(db)
  await sql`drop index auctions_cancelled_at_credits_idx`.execute(db)
  await sql`drop index auctions_finished_at_credits_idx`.execute(db)
  await sql`drop index auctions_published_at_idx`.execute(db)
}
