import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import {
  down,
  up,
} from '../../src/adapters/outbound/persistence/migrations/006-create-auction-auto-bids'
import { PersistedAuctionNotFoundError } from '../../src/application/errors/AuctionPersistenceError'
import { AutoBidConfig } from '../../src/domain/entities/AutoBidConfig'
import { watchlistAuction } from '../support/watchlist-auction'

const autoBidConfig = (
  auctionId: string,
  bidderId: string,
  maxAmountCredits: number,
  configuredAt: Date,
) =>
  AutoBidConfig.configure({
    auctionId,
    bidderId,
    maxAmountCredits,
    configuredAt,
    eligibility: {
      auctionStatus: 'ACTIVE',
      sellerId: 'seller-1',
    },
  })

/** Motor real: unicidad compuesta, clave foranea y migracion reversible. */
describe('Puja automatica PostgreSQL (HU-67.4)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let repository: PostgresAuctionRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()

    const auctions = new PostgresAuctionRepository(db)
    await auctions.publish(watchlistAuction('auction-1'))
    await auctions.publish(watchlistAuction('auction-2'))
  }, 120_000)

  beforeEach(async () => {
    await db.deleteFrom('auction_auto_bids').execute()
    repository = new PostgresAuctionRepository(db)
  })

  afterAll(async () => {
    // beforeAll puede fallar antes de asignar db si Docker no esta disponible.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await db?.destroy()
    await container?.stop()
  })

  it('guarda y recupera una configuracion nueva', async () => {
    const config = autoBidConfig('auction-1', 'bidder-1', 100, new Date('2026-09-21T12:00:00Z'))

    await expect(repository.saveAutoBidConfig(config)).resolves.toEqual(config.snapshot())

    await expect(repository.findAutoBidConfig('auction-1', 'bidder-1')).resolves.toEqual(
      config.snapshot(),
    )
  })

  it('retorna null cuando no existe configuracion', async () => {
    await expect(repository.findAutoBidConfig('auction-1', 'bidder-sin-config')).resolves.toBeNull()
  })

  it('rechaza configurar sobre una subasta inexistente', async () => {
    await expect(
      repository.saveAutoBidConfig(
        autoBidConfig('auction-missing', 'bidder-1', 100, new Date('2026-09-21T12:00:00Z')),
      ),
    ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)
  })

  it('reconfigurar hace upsert y conserva una unica fila por jugador y subasta', async () => {
    await repository.saveAutoBidConfig(
      autoBidConfig('auction-1', 'bidder-1', 100, new Date('2026-09-21T12:00:00Z')),
    )

    const updated = autoBidConfig('auction-1', 'bidder-1', 250, new Date('2026-09-21T12:05:00Z'))

    await expect(repository.saveAutoBidConfig(updated)).resolves.toEqual(updated.snapshot())

    await expect(repository.findAutoBidConfig('auction-1', 'bidder-1')).resolves.toEqual(
      updated.snapshot(),
    )

    const rows = await db
      .selectFrom('auction_auto_bids')
      .selectAll()
      .where('auction_id', '=', 'auction-1')
      .where('bidder_id', '=', 'bidder-1')
      .execute()

    expect(rows).toHaveLength(1)
  })

  it('findActiveAutoBidsForAuction excluye al postor indicado y otras subastas', async () => {
    await repository.saveAutoBidConfig(
      autoBidConfig('auction-1', 'bidder-1', 100, new Date('2026-09-21T12:00:00Z')),
    )
    await repository.saveAutoBidConfig(
      autoBidConfig('auction-1', 'bidder-2', 150, new Date('2026-09-21T12:01:00Z')),
    )
    await repository.saveAutoBidConfig(
      autoBidConfig('auction-2', 'bidder-3', 300, new Date('2026-09-21T12:02:00Z')),
    )

    const active = await repository.findActiveAutoBidsForAuction('auction-1', 'bidder-1')

    expect(active).toHaveLength(1)
    expect(active[0]?.bidderId).toBe('bidder-2')
  })

  it('el motor rechaza limites no positivos escribiendo SQL directo', async () => {
    await expect(
      db
        .insertInto('auction_auto_bids')
        .values({
          auction_id: 'auction-1',
          bidder_id: 'bidder-invalid',
          max_amount_credits: 0,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('el motor rechaza referenciar una subasta inexistente escribiendo SQL directo', async () => {
    await expect(
      db
        .insertInto('auction_auto_bids')
        .values({
          auction_id: 'auction-missing',
          bidder_id: 'bidder-1',
          max_amount_credits: 100,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('aplica la clave primaria compuesta incluso escribiendo SQL directo', async () => {
    const row = {
      auction_id: 'auction-1',
      bidder_id: 'bidder-1',
      max_amount_credits: 100,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }

    await db.insertInto('auction_auto_bids').values(row).execute()

    await expect(db.insertInto('auction_auto_bids').values(row).execute()).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('propaga errores de infraestructura sin convertirlos en resultados vacios', async () => {
    const offline = createDatabase({
      connectionString: 'postgres://nobody:nothing@127.0.0.1:1/missing',
    })

    try {
      await expect(
        new PostgresAuctionRepository(offline).findAutoBidConfig('auction-1', 'bidder-1'),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    } finally {
      await offline.destroy()
    }
  })

  it('revierte y reaplica solo la tabla auction_auto_bids', async () => {
    await down(db)

    expect(
      (
        await sql<{
          name: string | null
        }>`select to_regclass('public.auction_auto_bids')::text as name`.execute(db)
      ).rows[0]?.name,
    ).toBeNull()

    await up(db)

    expect(await repository.findAutoBidConfig('auction-1', 'bidder-1')).toBeNull()
    expect((await migrateToLatest(db)).applied).toEqual([])
  })
})
