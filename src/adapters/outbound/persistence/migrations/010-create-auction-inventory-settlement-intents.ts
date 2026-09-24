import { sql, type Kysely } from 'kysely'
import type { Database } from '../schema'

export const up = async (db: Kysely<Database>): Promise<void> => {
  await db.schema
    .createTable('auction_inventory_settlement_intents')
    .addColumn('auction_id', 'varchar(200)', (column) => column.primaryKey())
    .addColumn('operation_id', 'varchar(300)', (column) => column.notNull().unique())
    .addColumn('action', 'varchar(30)', (column) => column.notNull())
    .addColumn('commitment_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('seller_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('product_id', 'varchar(200)', (column) => column.notNull())
    .addColumn('winner_id', 'varchar(200)')
    .addColumn('status', 'varchar(30)', (column) => column.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addColumn('confirmed_at', 'timestamptz')
    .addCheckConstraint(
      'auction_inventory_settlement_intents_action_valid',
      sql`action in ('RELEASE', 'PENDING_CLAIM')`,
    )
    .addCheckConstraint(
      'auction_inventory_settlement_intents_status_valid',
      sql`status in ('PENDING', 'CONFIRMED', 'RETRYABLE', 'TERMINAL_ERROR')`,
    )
    .addCheckConstraint(
      'auction_inventory_settlement_intents_winner_valid',
      sql`(action = 'RELEASE' and winner_id is null) or (action = 'PENDING_CLAIM' and winner_id is not null)`,
    )
    .addCheckConstraint(
      'auction_inventory_settlement_intents_confirmed_valid',
      sql`(status = 'CONFIRMED' and confirmed_at is not null) or (status <> 'CONFIRMED' and confirmed_at is null)`,
    )
    .execute()
  await db.schema
    .createIndex('auction_inventory_settlement_intents_status_idx')
    .on('auction_inventory_settlement_intents')
    .column('status')
    .execute()
}

export const down = async (db: Kysely<Database>): Promise<void> => {
  await db.schema.dropTable('auction_inventory_settlement_intents').execute()
}
