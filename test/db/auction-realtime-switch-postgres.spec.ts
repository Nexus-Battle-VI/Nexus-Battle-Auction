import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import WebSocket from 'ws'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

import type * as NestTesting from '@nestjs/testing'
import type * as NestPlatformWs from '@nestjs/platform-ws'

/**
 * EN-034, TASK 34.6. Reversion del realtime: `AUCTION_REALTIME_ENABLED` puede apagarse sin tocar
 * reglas ni estados persistidos, y las consultas HTTP siguen siendo la recuperacion funcional.
 *
 * Se arranca la aplicacion REAL tres veces sobre la MISMA base (apagado -> encendido -> apagado) y
 * se comparan huellas de todas las tablas entre cada arranque.
 */
describe('Interruptor de reversion del realtime (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>

  const now = new Date('2026-10-07T12:00:00.000Z')

  /** Arranca la app real con el interruptor indicado. Devuelve la app y sus URLs. */
  const boot = async (
    realtime: boolean,
  ): Promise<{ app: INestApplication; http: string; ws: string }> => {
    const previous = { ...process.env }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: container?.getConnectionUri() ?? '',
      AUTH_MODE: 'disabled',
    })
    if (realtime) process.env.AUCTION_REALTIME_ENABLED = 'true'
    else delete process.env.AUCTION_REALTIME_ENABLED

    let created: INestApplication | undefined
    try {
      // `@Module` es estatico y lee el interruptor al cargar: cada arranque carga el modulo con el
      // entorno ya fijado y aislado. Nest tambien se carga dentro, para compartir `Reflector`.
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { AppModule } = require('../../src/infrastructure/bootstrap/app.module') as {
            AppModule: new () => unknown
          }
          const { Test } = require('@nestjs/testing') as typeof NestTesting
          const { WsAdapter } = require('@nestjs/platform-ws') as typeof NestPlatformWs
          /* eslint-enable @typescript-eslint/no-require-imports */
          Test.createTestingModule({ imports: [AppModule] })
            .compile()
            .then(async (module) => {
              created = module.createNestApplication()
              created.setGlobalPrefix('api')
              if (realtime) created.useWebSocketAdapter(new WsAdapter(created))
              await created.listen(0)
              resolve()
            })
            .catch(reject)
        })
      })
    } finally {
      process.env = previous
    }
    if (created === undefined) throw new Error('La aplicacion no arranco')
    const address = created.getHttpServer().address() as { port: number }
    const host = `127.0.0.1:${String(address.port)}`
    return {
      app: created,
      http: `http://${host}`,
      ws: `ws://${host}/api/v1/auctions/realtime`,
    }
  }

  /** Huella (filas + md5 del contenido) de TODAS las tablas del esquema publico. */
  const fingerprint = async (): Promise<Record<string, string>> => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `.execute(db)
    const result: Record<string, string> = {}
    for (const { table_name: table } of tables.rows) {
      const row = await sql<{ n: string; digest: string }>`
        select count(*)::text as n,
               coalesce(md5(string_agg(t::text, ',' order by t::text)), '') as digest
        from ${sql.table(table)} t
      `.execute(db)
      result[table] = `${row.rows[0]?.n ?? '?'}:${row.rows[0]?.digest ?? '?'}`
    }
    return result
  }

  const wsOutcome = (url: string): Promise<'open' | 'refused'> =>
    new Promise((resolve) => {
      const socket = new WebSocket(url)
      socket.once('open', () => {
        socket.close()
        resolve('open')
      })
      socket.once('error', () => {
        resolve('refused')
      })
      socket.once('unexpected-response', () => {
        resolve('refused')
      })
    })

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri(), maxConnections: 10 })
    expect((await migrateToLatest(db)).error).toBeUndefined()

    const repository = new PostgresAuctionRepository(db)
    await repository.publish({
      operationId: 'publish:switch-1',
      auction: Auction.publish({
        auctionId: 'switch-1',
        sellerId: 'seller-switch',
        productId: 'product:switch-1',
        durationHours: 24,
        minimumBidCredits: 10,
        publishedAt: new Date(),
        eligibility: {
          productOwnedBySeller: true,
          productInUse: false,
          productTradable: true,
          sellerHasActiveSanctions: false,
          activeAuctionCount: 0,
        },
      }),
      inventoryCommitmentId: 'commitment:switch-1',
      feeChargeId: 'charge:switch-1',
    })
  }, 180_000)

  afterAll(async () => {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    await db?.destroy()
    await container?.stop()
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  })

  it('apagado: no hay tickets ni WebSocket, y las consultas HTTP siguen respondiendo', async () => {
    const { app, http, ws } = await boot(false)
    try {
      const ticket = await fetch(`${http}/api/v1/auctions/realtime/tickets`, { method: 'POST' })
      expect(ticket.status).toBe(404)
      expect(await wsOutcome(ws)).toBe('refused')

      // La recuperacion funcional es la consulta HTTP vigente: marketplace y detalle.
      const list = await fetch(`${http}/api/v1/auctions`)
      expect(list.status).toBe(200)
      const listBody = (await list.json()) as { items: { id: string }[] }
      expect(listBody.items.map((item) => item.id)).toContain('switch-1')

      const detail = await fetch(`${http}/api/v1/auctions/switch-1`)
      expect(detail.status).toBe(200)
      expect(((await detail.json()) as { id: string }).id).toBe('switch-1')
    } finally {
      await app.close()
    }
  })

  it('apagado: las escrituras siguen funcionando y la revision sigue avanzando', async () => {
    const repository = new PostgresAuctionRepository(db)
    await repository.persistBid(
      Bid.restore({
        id: 'switch-bid-1',
        auctionId: 'switch-1',
        bidderId: 'bidder-1',
        amountCredits: 10,
        placedAt: now,
      }),
    )

    const row = await db
      .selectFrom('auctions')
      .select('revision')
      .where('id', '=', 'switch-1')
      .executeTakeFirstOrThrow()
    // Los triggers son de la base, no de la funcion: apagar el interruptor no los desactiva.
    expect(Number(row.revision)).toBe(1)
  })

  it('encender y apagar el interruptor no cambia ningun dato persistido', async () => {
    const before = await fingerprint()

    const on = await boot(true)
    try {
      const ticket = await fetch(`${on.http}/api/v1/auctions/realtime/tickets`, { method: 'POST' })
      expect(ticket.status).toBe(201)
      expect(await wsOutcome(on.ws)).toBe('open')
    } finally {
      await on.app.close()
    }
    const afterOn = await fingerprint()

    const off = await boot(false)
    try {
      expect((await fetch(`${off.http}/api/v1/auctions`)).status).toBe(200)
    } finally {
      await off.app.close()
    }
    const afterOff = await fingerprint()

    expect(afterOn).toEqual(before)
    expect(afterOff).toEqual(before)
    expect(Object.keys(before).length).toBeGreaterThan(10)
  })

  it('al volver a encenderlo las senales se reanudan con la revision correcta', async () => {
    const on = await boot(true)
    try {
      const ticketResponse = await fetch(`${on.http}/api/v1/auctions/realtime/tickets`, {
        method: 'POST',
      })
      const { ticket } = (await ticketResponse.json()) as { ticket: string }

      const frames: { type: string; signal?: { revision: number; reason: string } }[] = []
      const socket = new WebSocket(on.ws)
      socket.on('message', (data) => {
        frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as (typeof frames)[0])
      })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve()
        })
        socket.once('error', reject)
      })
      socket.send(JSON.stringify({ type: 'auth', ticket }))
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'auctions/switch-1' }))
      await waitUntil(() => frames.some((frame) => frame.type === 'subscribed'))

      const repository = new PostgresAuctionRepository(db)
      await repository.persistBid(
        Bid.restore({
          id: 'switch-bid-2',
          auctionId: 'switch-1',
          bidderId: 'bidder-2',
          amountCredits: 30,
          placedAt: now,
        }),
      )
      await waitUntil(() => frames.some((frame) => frame.type === 'signal'))

      // La revision 1 la consumio la puja hecha con el interruptor apagado; esta es la 2.
      expect(frames.find((frame) => frame.type === 'signal')?.signal).toMatchObject({
        revision: 2,
        reason: 'BID_ACCEPTED',
      })
      socket.close()
    } finally {
      await on.app.close()
    }
  })
})

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Tiempo agotado esperando la condicion')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
