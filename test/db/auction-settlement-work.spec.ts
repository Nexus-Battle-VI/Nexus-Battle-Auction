import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresAuctionSettlementWorkRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionSettlementWorkRepository'
import * as settlementWorkMigration from '../../src/adapters/outbound/persistence/migrations/011-create-auction-settlement-work'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { AuctionSettlementWorkStatus } from '../../src/application/ports/AuctionSettlementWorkRepositoryPort'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

const now = new Date('2026-09-23T12:00:00.000Z')

describe('PostgresAuctionSettlementWorkRepository', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresAuctionSettlementWorkRepository
  let containerStarted = false
  let databaseInitialized = false

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    containerStarted = true
    db = createDatabase({ connectionString: container.getConnectionUri() })
    databaseInitialized = true
    const migration = await migrateToLatest(db)
    if (migration.error !== undefined) {
      throw migration.error instanceof Error ? migration.error : new Error('Migration failed')
    }
    repository = new PostgresAuctionSettlementWorkRepository(db)
  }, 120_000)

  afterEach(async () => {
    await db.deleteFrom('auction_settlement_work').execute()
    await db.deleteFrom('auction_inventory_settlement_intents').execute()
    await db.deleteFrom('auction_settlement_releases').execute()
    await db.deleteFrom('auction_pending_claims').execute()
    await db.deleteFrom('auction_settlements').execute()
    await db.deleteFrom('auction_bids').execute()
    await db.deleteFrom('auctions').execute()
  })

  afterAll(async () => {
    if (databaseInitialized) await db.destroy()
    if (containerStarted) await container.stop()
  })

  it('la migration 011 soporta down y up', async () => {
    await settlementWorkMigration.down(db)
    const absent = await sql<{ name: string | null }>`
      select to_regclass('public.auction_settlement_work')::text as name
    `.execute(db)
    expect(absent.rows[0]?.name).toBeNull()

    await settlementWorkMigration.up(db)
    const present = await sql<{ name: string | null }>`
      select to_regclass('public.auction_settlement_work')::text as name
    `.execute(db)
    expect(present.rows[0]?.name).toBe('auction_settlement_work')
  })

  it('descubre ACTIVE vencidas y FINISHED reintentables, pero excluye futuros y finales', async () => {
    await insertAuction('active-due', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await insertAuction('future', 'ACTIVE', '2026-09-24T10:00:00.000Z')
    await insertAuction('finished-retry', 'FINISHED', '2026-09-23T09:00:00.000Z')
    await insertAuction('finished-complete', 'FINISHED', '2026-09-23T08:00:00.000Z')
    await insertAuction('finished-terminal', 'FINISHED', '2026-09-23T07:00:00.000Z')
    await insertSettlement('finished-retry', 'FAILED_RETRYABLE')
    await insertSettlement('finished-complete', 'COMPLETED')
    await insertSettlement('finished-terminal', 'FAILED_TERMINAL')

    const claimed = await claim(repository, 'worker-1')
    expect(claimed.map((work) => work.auctionId)).toEqual(['finished-retry', 'active-due'])
  })

  it('reclama deterministamente por closesAt y auctionId', async () => {
    await insertAuction('auction-c', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await insertAuction('auction-b', 'ACTIVE', '2026-09-23T09:00:00.000Z')
    await insertAuction('auction-a', 'ACTIVE', '2026-09-23T09:00:00.000Z')

    const claimed = await claim(repository, 'worker-1')
    expect(claimed.map((work) => work.auctionId)).toEqual(['auction-a', 'auction-b', 'auction-c'])
  })

  it('usa la frontera inclusiva closesAt <= now con precision de milisegundo', async () => {
    await insertAuction('before', 'ACTIVE', '2026-09-23T11:59:59.999Z')
    await insertAuction('exact', 'ACTIVE', '2026-09-23T12:00:00.000Z')
    await insertAuction('after', 'ACTIVE', '2026-09-23T12:00:00.001Z')

    const claimed = await claim(repository, 'worker-1')
    expect(claimed.map((work) => work.auctionId)).toEqual(['before', 'exact'])
  })

  it('no reclama un lease vigente y recupera uno expirado', async () => {
    await insertAuction('auction-1', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await claim(repository, 'worker-1')
    await expect(claim(repository, 'worker-2')).resolves.toEqual([])

    const reclaimed = await claim(repository, 'worker-2', new Date('2026-09-23T12:05:00.000Z'))
    expect(reclaimed[0]).toMatchObject({ leaseOwner: 'worker-2', attempts: 2 })
  })

  it('aplica ownership estricto y mantiene COMPLETED estable ante replay', async () => {
    await insertAuction('auction-1', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await claim(repository, 'worker-1')
    await expect(
      repository.markCompleted({
        auctionId: 'auction-1',
        workerId: 'worker-2',
        now,
      }),
    ).rejects.toThrow(/no esta arrendado/)

    const completed = await repository.markCompleted({
      auctionId: 'auction-1',
      workerId: 'worker-1',
      now,
    })
    const replay = await repository.markCompleted({
      auctionId: 'auction-1',
      workerId: 'worker-2',
      now: new Date('2026-09-24T12:00:00.000Z'),
    })
    expect(replay).toEqual(completed)
    await expect(
      claim(repository, 'worker-3', new Date('2026-09-30T12:00:00.000Z')),
    ).resolves.toEqual([])
  })

  it('dos workers concurrentes no reclaman la misma Auction', async () => {
    for (let index = 0; index < 6; index += 1) {
      await insertAuction(`auction-${String(index)}`, 'ACTIVE', '2026-09-23T10:00:00.000Z')
    }
    const otherRepository = new PostgresAuctionSettlementWorkRepository(db)
    const [first, second] = await Promise.all([
      claim(repository, 'worker-1', now, 3),
      claim(otherRepository, 'worker-2', now, 3),
    ])

    const firstIds = new Set(first.map((work) => work.auctionId))
    expect(second.every((work) => !firstIds.has(work.auctionId))).toBe(true)
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(3)
    expect(first.length + second.length).toBeLessThanOrEqual(6)
  })

  it('persiste retry y terminal con timestamps coherentes', async () => {
    await insertAuction('retry', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await insertAuction('terminal', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await claim(repository, 'worker-1')
    const availableAt = new Date(now.getTime() + 30_000)
    const retry = await repository.markRetryable({
      auctionId: 'retry',
      workerId: 'worker-1',
      now,
      availableAt,
      error: 'temporary',
    })
    const terminal = await repository.markTerminal({
      auctionId: 'terminal',
      workerId: 'worker-1',
      now,
      error: 'permanent',
    })

    expect(retry).toMatchObject({
      status: AuctionSettlementWorkStatus.Retryable,
      availableAt,
      lastError: 'temporary',
      leaseOwner: null,
    })
    expect(terminal).toMatchObject({
      status: AuctionSettlementWorkStatus.Terminal,
      terminalAt: now,
      lastError: 'permanent',
    })

    await expect(
      claim(repository, 'worker-2', new Date(availableAt.getTime() - 1)),
    ).resolves.toEqual([])
    await expect(claim(repository, 'worker-2', availableAt)).resolves.toEqual([
      expect.objectContaining({ auctionId: 'retry', attempts: 2 }),
    ])
  })

  it('hace cumplir constraints de attempts y lease', async () => {
    await insertAuction('auction-1', 'ACTIVE', '2026-09-23T10:00:00.000Z')
    await expect(
      db
        .insertInto('auction_settlement_work')
        .values({
          auction_id: 'auction-1',
          status: AuctionSettlementWorkStatus.Leased,
          available_at: now,
          lease_owner: null,
          lease_until: null,
          attempts: -1,
          last_error: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
          terminal_at: null,
        })
        .execute(),
    ).rejects.toBeDefined()
  })

  const claim = (
    target: PostgresAuctionSettlementWorkRepository,
    leaseOwner: string,
    at = now,
    limit = 25,
  ) =>
    target.claimDue({
      now: at,
      workerId: leaseOwner,
      leaseUntil: new Date(at.getTime() + 300_000),
      limit,
    })

  const insertAuction = async (
    auctionId: string,
    status: 'ACTIVE' | 'FINISHED',
    closesAt: string,
  ): Promise<void> => {
    const finished = status === 'FINISHED'
    await db
      .insertInto('auctions')
      .values({
        id: auctionId,
        seller_id: `seller-${auctionId}`,
        product_id: `product-${auctionId}`,
        duration_hours: 24,
        publisher_type: 'PLAYER',
        price_kind: 'CREDITS',
        publication_fee_credits: 2,
        minimum_bid_credits: 10,
        buy_now_credits: null,
        status,
        published_at: new Date('2026-09-20T00:00:00.000Z'),
        closes_at: new Date(closesAt),
        inventory_commitment_id: `commitment-${auctionId}`,
        fee_charge_id: `fee-${auctionId}`,
        finished_at: finished ? new Date(closesAt) : null,
        closing_result_type: finished ? 'WITHOUT_BIDS' : null,
        winning_bid_id: null,
        winner_id: null,
        final_amount_credits: null,
      })
      .execute()
  }

  const insertSettlement = async (
    auctionId: string,
    status: 'FAILED_RETRYABLE' | 'COMPLETED' | 'FAILED_TERMINAL',
  ): Promise<void> => {
    await db
      .insertInto('auction_settlements')
      .values({
        auction_id: auctionId,
        status,
        result_type: 'WITHOUT_BIDS',
        winning_bid_id: null,
        winner_id: null,
        winning_hold_id: null,
        seller_id: `seller-${auctionId}`,
        final_amount_credits: null,
        capture_operation_id: null,
        capture_status: 'NOT_REQUIRED',
        last_error: status.startsWith('FAILED') ? 'failure' : null,
        created_at: now,
        updated_at: now,
        settled_at: status === 'COMPLETED' ? now : null,
      })
      .execute()
  }
})
