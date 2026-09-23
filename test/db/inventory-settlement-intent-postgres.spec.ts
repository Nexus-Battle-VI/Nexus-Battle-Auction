import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionInventorySettlementIntentRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

const now = new Date('2026-09-23T12:00:00.000Z')
const release = (
  overrides: Partial<{ auctionId: string; operationId: string; commitmentId: string }> = {},
) => ({
  auctionId: 'auction-1',
  operationId: 'auction:auction-1:inventory:release',
  action: 'RELEASE' as const,
  commitmentId: 'commitment-1',
  sellerId: 'seller-1',
  productId: 'product-1',
  createdAt: now,
  ...overrides,
})
const pending = {
  auctionId: 'auction-2',
  operationId: 'auction:auction-2:inventory:pending-claim',
  action: 'PENDING_CLAIM' as const,
  commitmentId: 'commitment-2',
  sellerId: 'seller-2',
  winnerId: 'winner-2',
  productId: 'product-2',
  createdAt: now,
}

describe('PostgresAuctionInventorySettlementIntentRepository', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database> | undefined
  const database = (): Kysely<Database> => {
    if (db === undefined) throw new Error('Database not initialized.')
    return db
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(database())
    if (outcome.error !== undefined)
      throw outcome.error instanceof Error ? outcome.error : new Error('Migration failed.')
  })
  afterAll(async () => {
    if (db !== undefined) await db.destroy()
    if (container !== undefined) await container.stop()
  })
  beforeEach(async () => {
    await sql`truncate auction_inventory_settlement_intents`.execute(database())
  })

  it('crea RELEASE, replay y restart con el mismo intent durable', async () => {
    const first = new PostgresAuctionInventorySettlementIntentRepository(database())
    const created = await first.getOrCreate(release())
    const replay = await new PostgresAuctionInventorySettlementIntentRepository(
      database(),
    ).getOrCreate(release())
    expect(replay).toEqual(created)
    expect(replay).toMatchObject({ action: 'RELEASE', winnerId: null, status: 'PENDING' })
  })

  it('persiste PENDING_CLAIM y winner tras restart', async () => {
    const repository = new PostgresAuctionInventorySettlementIntentRepository(database())
    await repository.getOrCreate(pending)
    await expect(
      new PostgresAuctionInventorySettlementIntentRepository(database()).getByAuctionId(
        'auction-2',
      ),
    ).resolves.toMatchObject({ action: 'PENDING_CLAIM', winnerId: 'winner-2' })
  })

  it('rechaza intent incompatible y mantiene una fila', async () => {
    const repository = new PostgresAuctionInventorySettlementIntentRepository(database())
    await repository.getOrCreate(release())
    await expect(repository.getOrCreate({ ...pending, auctionId: 'auction-1' })).rejects.toThrow(
      'Conflicto',
    )
    await expect(
      database().selectFrom('auction_inventory_settlement_intents').selectAll().execute(),
    ).resolves.toHaveLength(1)
  })

  it('persiste retry, confirmacion idempotente y terminal', async () => {
    const repository = new PostgresAuctionInventorySettlementIntentRepository(database())
    await repository.getOrCreate(release())
    await repository.markRetryable('auction-1', 'timeout', now)
    const confirmed = await repository.markConfirmed('auction-1', now)
    await expect(
      repository.markConfirmed('auction-1', new Date('2026-09-24T12:00:00.000Z')),
    ).resolves.toEqual(confirmed)
    await repository.getOrCreate(
      release({
        auctionId: 'auction-terminal',
        operationId: 'auction:auction-terminal:inventory:release',
      }),
    )
    await expect(
      repository.markTerminalError('auction-terminal', 'conflict', now),
    ).resolves.toMatchObject({ status: 'TERMINAL_ERROR', lastError: 'conflict' })
  })

  it('concurrent getOrCreate deja una sola fila', async () => {
    const left = new PostgresAuctionInventorySettlementIntentRepository(database())
    const right = new PostgresAuctionInventorySettlementIntentRepository(database())
    const [first, second] = await Promise.all([
      left.getOrCreate(release()),
      right.getOrCreate(release()),
    ])
    expect(first).toEqual(second)
    await expect(
      database().selectFrom('auction_inventory_settlement_intents').selectAll().execute(),
    ).resolves.toHaveLength(1)
  })
})
