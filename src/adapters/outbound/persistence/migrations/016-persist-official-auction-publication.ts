import { sql, type Kysely } from 'kysely'

/**
 * Anade la publicacion oficial (HU-66) a `auctions` sin reescribir la
 * migracion 001: solo columnas nuevas, todas opcionales u con un valor por
 * defecto compatible con las filas HU-62 existentes, y una restriccion
 * discriminada que sustituye a las tres que asumian creditos siempre.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('auctions')
    .addColumn('publisher_type', 'text', (column) => column.notNull().defaultTo('PLAYER'))
    .execute()
  await db.schema
    .alterTable('auctions')
    .addColumn('price_kind', 'text', (column) => column.notNull().defaultTo('CREDITS'))
    .execute()
  await db.schema.alterTable('auctions').addColumn('official_mark', 'text').execute()
  await db.schema.alterTable('auctions').addColumn('currency', 'text').execute()
  await db.schema.alterTable('auctions').addColumn('minimum_bid_amount_minor', 'integer').execute()
  await db.schema.alterTable('auctions').addColumn('buy_now_amount_minor', 'integer').execute()

  // Una publicacion oficial no tiene precio en creditos ni reserva de
  // inventario o cobro de comision: las tres columnas pasan a ser opcionales.
  await db.schema
    .alterTable('auctions')
    .alterColumn('minimum_bid_credits', (column) => column.dropNotNull())
    .execute()
  await db.schema
    .alterTable('auctions')
    .alterColumn('inventory_commitment_id', (column) => column.dropNotNull())
    .execute()
  await db.schema
    .alterTable('auctions')
    .alterColumn('fee_charge_id', (column) => column.dropNotNull())
    .execute()

  await db.schema.alterTable('auctions').dropConstraint('auctions_fee_positive').execute()
  await db.schema.alterTable('auctions').dropConstraint('auctions_minimum_bid_positive').execute()
  await db.schema.alterTable('auctions').dropConstraint('auctions_buy_now_valid').execute()

  await db.schema
    .alterTable('auctions')
    .addCheckConstraint('auctions_fee_non_negative', sql`publication_fee_credits >= 0`)
    .execute()
  await db.schema
    .alterTable('auctions')
    .addCheckConstraint(
      'auctions_publisher_type_valid',
      sql`publisher_type in ('PLAYER', 'GAME_MASTER')`,
    )
    .execute()
  await db.schema
    .alterTable('auctions')
    .addCheckConstraint('auctions_price_kind_valid', sql`price_kind in ('CREDITS', 'REAL_MONEY')`)
    .execute()
  await db.schema
    .alterTable('auctions')
    .addCheckConstraint(
      'auctions_official_mark_valid',
      sql`official_mark is null or official_mark in ('OFFICIAL', 'PREMIUM')`,
    )
    .execute()

  // Una fila es exactamente una de las dos ramas: nunca una mezcla de campos
  // de creditos y de dinero real, ni un publicador incompatible con su marca.
  await db.schema
    .alterTable('auctions')
    .addCheckConstraint(
      'auctions_pricing_discriminated',
      sql`
        (
          price_kind = 'CREDITS'
          and publisher_type = 'PLAYER'
          and official_mark is null
          and currency is null
          and minimum_bid_amount_minor is null
          and buy_now_amount_minor is null
          and minimum_bid_credits is not null
          and minimum_bid_credits > 0
          and (buy_now_credits is null or buy_now_credits > minimum_bid_credits)
          and inventory_commitment_id is not null
          and fee_charge_id is not null
        )
        or
        (
          price_kind = 'REAL_MONEY'
          and publisher_type = 'GAME_MASTER'
          and official_mark is not null
          and official_mark in ('OFFICIAL', 'PREMIUM')
          and currency is not null
          and minimum_bid_credits is null
          and buy_now_credits is null
          and publication_fee_credits = 0
          and minimum_bid_amount_minor is not null
          and minimum_bid_amount_minor > 0
          and (buy_now_amount_minor is null or buy_now_amount_minor > minimum_bid_amount_minor)
          and inventory_commitment_id is null
          and fee_charge_id is null
        )
      `,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('auctions').dropConstraint('auctions_pricing_discriminated').execute()
  await db.schema.alterTable('auctions').dropConstraint('auctions_official_mark_valid').execute()
  await db.schema.alterTable('auctions').dropConstraint('auctions_price_kind_valid').execute()
  await db.schema.alterTable('auctions').dropConstraint('auctions_publisher_type_valid').execute()
  await db.schema.alterTable('auctions').dropConstraint('auctions_fee_non_negative').execute()

  await db.schema
    .alterTable('auctions')
    .addCheckConstraint('auctions_minimum_bid_positive', sql`minimum_bid_credits > 0`)
    .execute()
  await db.schema
    .alterTable('auctions')
    .addCheckConstraint(
      'auctions_buy_now_valid',
      sql`buy_now_credits is null or buy_now_credits > minimum_bid_credits`,
    )
    .execute()
  await db.schema
    .alterTable('auctions')
    .addCheckConstraint('auctions_fee_positive', sql`publication_fee_credits > 0`)
    .execute()

  await db.schema
    .alterTable('auctions')
    .alterColumn('fee_charge_id', (column) => column.setNotNull())
    .execute()
  await db.schema
    .alterTable('auctions')
    .alterColumn('inventory_commitment_id', (column) => column.setNotNull())
    .execute()
  await db.schema
    .alterTable('auctions')
    .alterColumn('minimum_bid_credits', (column) => column.setNotNull())
    .execute()

  await db.schema.alterTable('auctions').dropColumn('buy_now_amount_minor').execute()
  await db.schema.alterTable('auctions').dropColumn('minimum_bid_amount_minor').execute()
  await db.schema.alterTable('auctions').dropColumn('currency').execute()
  await db.schema.alterTable('auctions').dropColumn('official_mark').execute()
  await db.schema.alterTable('auctions').dropColumn('price_kind').execute()
  await db.schema.alterTable('auctions').dropColumn('publisher_type').execute()
}
