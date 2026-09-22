import { sql, type Kysely } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('auction_bids').addColumn('credit_reservation_id', 'text').execute()

  await sql`
    create unique index auction_bids_credit_reservation_uq
    on auction_bids (credit_reservation_id)
    where credit_reservation_id is not null
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex('auction_bids_credit_reservation_uq').execute()

  await db.schema.alterTable('auction_bids').dropColumn('credit_reservation_id').execute()
}
