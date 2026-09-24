import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresAuctionPublicationIntentRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionPublicationIntentRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

const now = new Date('2026-09-23T12:00:00.000Z')
const input = (overrides: Partial<{ operationId: string; auctionId: string }> = {}) => ({
  operationId: 'publish-operation-1',
  auctionId: 'auction-1',
  sellerId: 'seller-1',
  productId: 'product-1',
  closesAt: new Date('2026-09-24T12:00:00.000Z'),
  createdAt: now,
  ...overrides,
})

describe('PostgresAuctionPublicationIntentRepository', () => {
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
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('Migration failed.')
    }
  })

  afterAll(async () => {
    if (db !== undefined) await db.destroy()
    if (container !== undefined) await container.stop()
  })

  beforeEach(async () => {
    await sql`truncate auction_publication_intents`.execute(database())
  })

  it('crea una sola intencion por operationId y conserva su auctionId', async () => {
    const repository = new PostgresAuctionPublicationIntentRepository(database())
    const first = await repository.getOrCreate(input())
    const replay = await repository.getOrCreate(input({ auctionId: 'auction-other' }))

    expect(replay.auctionId).toBe(first.auctionId)
    await expect(
      database().selectFrom('auction_publication_intents').selectAll().execute(),
    ).resolves.toHaveLength(1)
  })

  it('persiste el commitment y lo recupera desde una instancia nueva', async () => {
    const repository = new PostgresAuctionPublicationIntentRepository(database())
    await repository.getOrCreate(input())
    await repository.persistInventoryCommitment('publish-operation-1', 'commitment-1', now)

    await expect(
      new PostgresAuctionPublicationIntentRepository(database()).getByOperationId(
        'publish-operation-1',
      ),
    ).resolves.toMatchObject({
      auctionId: 'auction-1',
      inventoryCommitmentId: 'commitment-1',
      inventoryStatus: 'COMMITTED',
    })
  })

  it('concurrent getOrCreate mantiene un unico intent durable', async () => {
    const first = new PostgresAuctionPublicationIntentRepository(database())
    const second = new PostgresAuctionPublicationIntentRepository(database())
    const [left, right] = await Promise.all([
      first.getOrCreate(input({ auctionId: 'auction-left' })),
      second.getOrCreate(input({ auctionId: 'auction-right' })),
    ])

    expect(left.auctionId).toBe(right.auctionId)
    await expect(
      database().selectFrom('auction_publication_intents').selectAll().execute(),
    ).resolves.toHaveLength(1)
  })

  it('marca completion durable', async () => {
    const repository = new PostgresAuctionPublicationIntentRepository(database())
    await repository.getOrCreate(input())
    await expect(
      repository.markPublicationCompleted('publish-operation-1', now),
    ).resolves.toMatchObject({
      publicationStatus: 'COMPLETED',
    })
  })
})
