import { sql, type Kysely } from 'kysely'

import type { Database } from '../schema'

export const up = async (db: Kysely<Database>): Promise<void> => {
  await db.schema
    .createTable('auction_settlement_work')
    .addColumn('auction_id', 'varchar(200)', (column) =>
      column.primaryKey().references('auctions.id').onDelete('restrict'),
    )
    .addColumn('status', 'varchar(30)', (column) => column.notNull())
    .addColumn('available_at', 'timestamptz', (column) => column.notNull())
    .addColumn('lease_owner', 'varchar(200)')
    .addColumn('lease_until', 'timestamptz')
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addColumn('completed_at', 'timestamptz')
    .addColumn('terminal_at', 'timestamptz')
    .addCheckConstraint(
      'auction_settlement_work_status_valid',
      sql`status in ('READY', 'LEASED', 'RETRYABLE', 'COMPLETED', 'TERMINAL')`,
    )
    .addCheckConstraint('auction_settlement_work_attempts_valid', sql`attempts >= 0`)
    .addCheckConstraint(
      'auction_settlement_work_lease_valid',
      sql`(status = 'LEASED' and lease_owner is not null and lease_until is not null) or (status <> 'LEASED' and lease_owner is null and lease_until is null)`,
    )
    .addCheckConstraint(
      'auction_settlement_work_completion_valid',
      sql`(status = 'COMPLETED' and completed_at is not null and terminal_at is null) or (status <> 'COMPLETED' and completed_at is null)`,
    )
    .addCheckConstraint(
      'auction_settlement_work_terminal_valid',
      sql`(status = 'TERMINAL' and terminal_at is not null and completed_at is null) or (status <> 'TERMINAL' and terminal_at is null)`,
    )
    .execute()

  await db.schema
    .createIndex('auction_settlement_work_claim_idx')
    .on('auction_settlement_work')
    .columns(['status', 'available_at', 'lease_until'])
    .execute()

  await db.schema
    .createIndex('auctions_settlement_discovery_idx')
    .on('auctions')
    .columns(['status', 'closes_at', 'id'])
    .execute()
}

export const down = async (db: Kysely<Database>): Promise<void> => {
  await db.schema.dropIndex('auctions_settlement_discovery_idx').execute()
  await db.schema.dropTable('auction_settlement_work').execute()
}
