import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import { Client } from 'pg'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { watchlistAuction } from '../support/watchlist-auction'

interface Notice {
  readonly auctionId: string
  readonly revision: number
  readonly reason: string
  readonly occurredAt: string
  readonly summary: {
    readonly status: string
    readonly currentBidCredits: number | null
    readonly bidCount: number
  }
}

/**
 * EN-034, TASK 34.2. Migracion 021: `revision` por subasta y aviso `pg_notify`
 * que PostgreSQL entrega SOLO al confirmar la transaccion.
 */
describe('Revision y aviso realtime de Subasta (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let listener: Client
  const notices: Notice[] = []

  const revisionOf = async (auctionId: string): Promise<number> => {
    const row = await db
      .selectFrom('auctions')
      .select('revision')
      .where('id', '=', auctionId)
      .executeTakeFirstOrThrow()
    return Number(row.revision)
  }

  /** Espera a que el listener haya recibido `count` avisos en total. */
  const waitForNotices = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (notices.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  const placeBid = async (auctionId: string, bidId: string, amount: number): Promise<void> => {
    await db.transaction().execute(async (tx) => {
      await sql`select id from auctions where id = ${auctionId} for update`.execute(tx)
      await sql`update auction_bids set is_leader = false where auction_id = ${auctionId}`.execute(
        tx,
      )
      await sql`
        insert into auction_bids (id, auction_id, bidder_id, amount_credits, placed_at, is_leader)
        values (${bidId}, ${auctionId}, 'bidder-1', ${amount}, now(), true)
      `.execute(tx)
    })
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()

    listener = new Client({ connectionString: container.getConnectionUri() })
    await listener.connect()
    listener.on('notification', (message) => {
      notices.push(JSON.parse(message.payload ?? '{}') as Notice)
    })
    await listener.query('LISTEN auction_realtime')
  }, 120_000)

  beforeEach(() => {
    notices.length = 0
  })

  afterAll(async () => {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    await listener?.end()
    await db?.destroy()
    await container?.stop()
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  })

  it('una subasta publicada nace en revision 0 y avisa PUBLISHED', async () => {
    await new PostgresAuctionRepository(db).publish(watchlistAuction('rt-publish'))
    await waitForNotices(1)

    expect(await revisionOf('rt-publish')).toBe(0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      auctionId: 'rt-publish',
      revision: 0,
      reason: 'PUBLISHED',
      summary: { status: 'ACTIVE', currentBidCredits: null, bidCount: 0 },
    })
    expect(notices[0]?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('cada puja confirmada sube la revision en 1 y avisa BID_ACCEPTED con resumen', async () => {
    await new PostgresAuctionRepository(db).publish(watchlistAuction('rt-bids'))
    await waitForNotices(1)
    notices.length = 0

    await placeBid('rt-bids', 'rt-bids-1', 10)
    await placeBid('rt-bids', 'rt-bids-2', 25)
    await waitForNotices(2)

    expect(await revisionOf('rt-bids')).toBe(2)
    expect(notices.map((n) => [n.reason, n.revision])).toEqual([
      ['BID_ACCEPTED', 1],
      ['BID_ACCEPTED', 2],
    ])
    expect(notices[1]?.summary).toEqual({ status: 'ACTIVE', currentBidCredits: 25, bidCount: 2 })
  })

  it('una transaccion revertida no avisa ni cambia la revision', async () => {
    await new PostgresAuctionRepository(db).publish(watchlistAuction('rt-rollback'))
    await waitForNotices(1)
    notices.length = 0

    await expect(
      db.transaction().execute(async (tx) => {
        await sql`select id from auctions where id = 'rt-rollback' for update`.execute(tx)
        await sql`
          insert into auction_bids (id, auction_id, bidder_id, amount_credits, placed_at, is_leader)
          values ('rt-rollback-1', 'rt-rollback', 'bidder-1', 10, now(), true)
        `.execute(tx)
        throw new Error('revertir')
      }),
    ).rejects.toThrow('revertir')
    // Un aviso posterior prueba que el canal sigue vivo y que el revertido no llego.
    await placeBid('rt-rollback', 'rt-rollback-2', 12)
    await waitForNotices(1)

    expect(await revisionOf('rt-rollback')).toBe(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ revision: 1, reason: 'BID_ACCEPTED' })
  })

  it.each([
    ['FINISHED', 'SETTLED'],
    ['SOLD', 'BOUGHT_NOW'],
    ['CANCELLED', 'CANCELLED'],
  ])('el cambio de estado a %s sube la revision y avisa %s', async (status, reason) => {
    const id = `rt-status-${status.toLowerCase()}`
    await new PostgresAuctionRepository(db).publish(watchlistAuction(id))
    await waitForNotices(1)
    await placeBid(id, `${id}-1`, 10)
    await waitForNotices(2)
    notices.length = 0

    await sql`
      update auctions
      set status = ${status},
          finished_at = case when ${status} = 'FINISHED' then now() else finished_at end,
          cancelled_at = case when ${status} = 'CANCELLED' then now() else cancelled_at end
      where id = ${id}
    `
      .execute(db)
      .catch((error: unknown) => {
        // Si una restriccion de la tabla exige mas columnas para este estado, el
        // fallo debe verse en la prueba y no silenciarse.
        throw error
      })
    await waitForNotices(1)

    expect(await revisionOf(id)).toBe(2)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      auctionId: id,
      revision: 2,
      reason,
      summary: { status, currentBidCredits: 10, bidCount: 1 },
    })
  })

  it('actualizar columnas distintas de status no cambia la revision ni avisa', async () => {
    await new PostgresAuctionRepository(db).publish(watchlistAuction('rt-noop'))
    await waitForNotices(1)
    notices.length = 0

    await sql`update auctions set finished_at = null where id = 'rt-noop'`.execute(db)
    await placeBid('rt-noop', 'rt-noop-1', 10)
    await waitForNotices(1)

    expect(await revisionOf('rt-noop')).toBe(1)
    expect(notices).toHaveLength(1)
  })

  it('la senal no contiene datos personales', async () => {
    await new PostgresAuctionRepository(db).publish(watchlistAuction('rt-privacy'))
    await placeBid('rt-privacy', 'rt-privacy-1', 10)
    await waitForNotices(2)

    const serialized = JSON.stringify(notices)
    expect(serialized).not.toContain('bidder-1')
    expect(serialized).not.toContain('seller-1')
    expect(Object.keys(notices[1] ?? {}).sort()).toEqual([
      'auctionId',
      'occurredAt',
      'reason',
      'revision',
      'summary',
    ])
  })

  it('la migracion es reversible y vuelve a aplicarse', async () => {
    const { down, up } =
      await import('../../src/adapters/outbound/persistence/migrations/021-add-auction-realtime-revision')
    await down(db as unknown as Kysely<unknown>)
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'auctions' and column_name = 'revision'
    `.execute(db)
    expect(columns.rows).toHaveLength(0)

    await up(db as unknown as Kysely<unknown>)
    expect(await revisionOf('rt-publish')).toBe(0)
  })
})
