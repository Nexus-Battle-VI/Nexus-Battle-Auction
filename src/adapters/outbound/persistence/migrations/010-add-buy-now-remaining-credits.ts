import { sql, type Kysely } from 'kysely'

/**
 * HU-64.4 revelo un vacio de HU-64.3: reintentar una compra inmediata con el
 * mismo `operationId` DESPUES de que la subasta ya cerro no puede evaluar de
 * nuevo el dominio -la subasta ya no esta activa-, asi que la confirmacion
 * debe poder reconstruirse solo con lo persistido. Faltaba guardar los
 * creditos restantes del comprador.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('auction_buy_now_operations')
    .addColumn('remaining_credits', 'integer')
    .execute()

  await sql`update auction_buy_now_operations set remaining_credits = 0`.execute(db)

  await db.schema
    .alterTable('auction_buy_now_operations')
    .alterColumn('remaining_credits', (column) => column.setNotNull())
    .execute()

  await db.schema
    .alterTable('auction_buy_now_operations')
    .addCheckConstraint(
      'auction_buy_now_operations_remaining_non_negative',
      sql`remaining_credits >= 0`,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('auction_buy_now_operations')
    .dropConstraint('auction_buy_now_operations_remaining_non_negative')
    .execute()
  await db.schema.alterTable('auction_buy_now_operations').dropColumn('remaining_credits').execute()
}
