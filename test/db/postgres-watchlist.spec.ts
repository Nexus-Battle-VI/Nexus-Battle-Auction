import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import { PostgresWatchlistRepository } from '../../src/adapters/outbound/persistence/PostgresWatchlistRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import {
  down,
  up,
} from '../../src/adapters/outbound/persistence/migrations/003-create-auction-watchlist'
import { WatchlistEntry } from '../../src/domain/entities/WatchlistEntry'
import { watchlistAuction } from '../support/watchlist-auction'
import { watchlistContract } from '../support/watchlist-contract'

/** Motor real: unicidad concurrente, claves foraneas y migracion reversible. */
describe('Watchlist PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let repository: PostgresWatchlistRepository
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    const auctions = new PostgresAuctionRepository(db)
    await auctions.publish(watchlistAuction('auction-1'))
    await auctions.publish(watchlistAuction('auction-2'))
  }, 120_000)
  beforeEach(async () => {
    await db.deleteFrom('auction_watchlist').execute()
    repository = new PostgresWatchlistRepository(db)
  })
  afterAll(async () => {
    // beforeAll puede fallar antes de asignar db si Docker no esta disponible.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await db?.destroy()
    await container?.stop()
  })
  watchlistContract(() => repository)

  it('conserva seguimientos al recrear repositorio y conexion', async () => {
    const entry = WatchlistEntry.create({
      playerId: 'player-1',
      auctionId: 'auction-1',
      followedAt: new Date('2026-09-21T12:00:00Z'),
    })
    await repository.create(entry)
    const other = createDatabase({ connectionString: container!.getConnectionUri() })
    try {
      expect(
        (await new PostgresWatchlistRepository(other).find('player-1', 'auction-1'))?.snapshot(),
      ).toEqual(entry.snapshot())
    } finally {
      await other.destroy()
    }
  })

  it('aplica unicidad incluso escribiendo SQL directo', async () => {
    const row = { player_id: 'player-1', auction_id: 'auction-1', followed_at: new Date() }
    await db.insertInto('auction_watchlist').values(row).execute()
    await expect(db.insertInto('auction_watchlist').values(row).execute()).rejects.toMatchObject({
      code: '23505',
    })
  })

  it.each(['', ' invalid ', '-player', 'a'.repeat(129)])(
    'el motor rechaza player_id invalido %p',
    async (playerId) => {
      await expect(
        db
          .insertInto('auction_watchlist')
          .values({ player_id: playerId, auction_id: 'auction-1', followed_at: new Date() })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' })
    },
  )

  it('el motor rechaza fechas no finitas', async () => {
    await expect(
      sql`insert into auction_watchlist values ('player-1', 'auction-1', 'infinity'::timestamptz)`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('propaga errores de infraestructura sin convertirlos en duplicados', async () => {
    const offline = createDatabase({
      connectionString: 'postgres://nobody:nothing@127.0.0.1:1/missing',
    })
    try {
      await expect(
        new PostgresWatchlistRepository(offline).create(
          WatchlistEntry.create({ playerId: 'p', auctionId: 'a', followedAt: new Date() }),
        ),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    } finally {
      await offline.destroy()
    }
  })

  it('revierte y reaplica solo la tabla watchlist', async () => {
    await down(db)
    expect(
      (
        await sql<{
          name: string | null
        }>`select to_regclass('public.auction_watchlist')::text as name`.execute(db)
      ).rows[0]?.name,
    ).toBeNull()
    await up(db)
    expect(await new PostgresAuctionRepository(db).findById('auction-1')).not.toBeNull()
    expect((await migrateToLatest(db)).applied).toEqual([])
  })
})
