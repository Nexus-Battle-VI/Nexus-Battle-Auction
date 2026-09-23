import { sql, type Kysely } from 'kysely'
import type { Database } from '../schema'

export const up = async (db: Kysely<Database>): Promise<void> => {
  await db.schema
    .createTable('auction_publication_intents')
    .addColumn('operation_id', 'varchar(300)', (column) => column.primaryKey())
    .addColumn('auction_id', 'varchar(200)', (column) => column.notNull().unique())
    .addColumn('seller_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('product_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('closes_at', 'timestamptz', (column) => column.notNull())
    .addColumn('inventory_commitment_id', 'varchar(200)')
    .addColumn('inventory_status', 'varchar(20)', (column) => column.notNull())
    .addColumn('publication_status', 'varchar(20)', (column) => column.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint(
      'auction_publication_intents_inventory_status_valid',
      sql`inventory_status in ('PENDING', 'COMMITTED', 'RELEASED')`,
    )
    .addCheckConstraint(
      'auction_publication_intents_publication_status_valid',
      sql`publication_status in ('PENDING', 'COMPLETED', 'FAILED_TERMINAL')`,
    )
    .addCheckConstraint(
      'auction_publication_intents_commitment_valid',
      sql`(inventory_status = 'PENDING' and inventory_commitment_id is null) or (inventory_status in ('COMMITTED', 'RELEASED') and inventory_commitment_id is not null)`,
    )
    .execute()
}

export const down = async (db: Kysely<Database>): Promise<void> => {
  await db.schema.dropTable('auction_publication_intents').execute()
}
