import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import WebSocket, { type RawData } from 'ws'

import type * as NestTesting from '@nestjs/testing'
import type * as NestPlatformWs from '@nestjs/platform-ws'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { watchlistAuction } from '../support/watchlist-auction'

interface Frame {
  readonly type: string
  readonly channel?: string
  readonly code?: string
  readonly signal?: { auctionId: string; revision: number; reason: string; summary?: unknown }
}

/** Cliente de prueba: acumula los mensajes recibidos y permite esperar por uno concreto. */
class Session {
  readonly frames: Frame[] = []
  closeCode: number | null = null
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData) =>
      this.frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Frame),
    )
    socket.on('close', (code) => {
      this.closeCode = code
    })
  }

  static async open(url: string): Promise<Session> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve()
      })
      socket.once('error', reject)
    })
    return new Session(socket)
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  close(): void {
    this.socket.close()
  }

  async waitFor(predicate: (frame: Frame) => boolean, what: string): Promise<Frame> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const found = this.frames.find(predicate)
      if (found !== undefined) return found
      if (Date.now() > deadline) {
        throw new Error(
          `Tiempo agotado esperando: ${what}. Recibido: ${JSON.stringify(this.frames)}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  async waitForClose(): Promise<number> {
    const deadline = Date.now() + 5_000
    while (this.closeCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (this.closeCode === null) throw new Error('La conexion no se cerro')
    return this.closeCode
  }
}

/**
 * EN-034 / TASK 34.2 de extremo a extremo: la aplicacion REAL (Nest + WsAdapter), PostgreSQL real
 * con la migracion 021 y clientes `ws` reales. Cubre los criterios CA-01 a CA-06 del Enabler en
 * lo que corresponde al backend.
 */
describe('Realtime de Subasta de extremo a extremo (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let app: INestApplication
  let baseUrl: string
  let wsUrl: string
  const sessions: Session[] = []

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

  const issueTicket = async (): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/v1/auctions/realtime/tickets`, { method: 'POST' })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { ticket: string; expiresInSeconds: number }
    expect(body.expiresInSeconds).toBe(30)
    return body.ticket
  }

  /** Abre una sesion ya autenticada. */
  const connect = async (): Promise<Session> => {
    const session = await Session.open(wsUrl)
    sessions.push(session)
    session.send({ type: 'auth', ticket: await issueTicket() })
    await session.waitFor((frame) => frame.type === 'authenticated', 'authenticated')
    return session
  }

  const bootApp = async (realtime: boolean): Promise<INestApplication> => {
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: container?.getConnectionUri() ?? '',
      AUTH_MODE: 'disabled',
      ...(realtime ? { AUCTION_REALTIME_ENABLED: 'true' } : {}),
    }
    const previous = { ...process.env }
    Object.assign(process.env, env)
    if (!realtime) delete process.env.AUCTION_REALTIME_ENABLED

    let created: INestApplication | undefined
    try {
      // `@Module` es estatico y lee el interruptor al cargar: se carga el modulo con el entorno ya
      // fijado, aislado de las demas pruebas.
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          // Nest se carga DENTRO del aislamiento: dos copias de @nestjs/core no comparten
          // la identidad de `Reflector` y el contenedor no resolveria los guards.
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
    return created
  }

  const urlsOf = (instance: INestApplication): { http: string; ws: string } => {
    const address = instance.getHttpServer().address() as { port: number }
    return {
      http: `http://127.0.0.1:${String(address.port)}`,
      ws: `ws://127.0.0.1:${String(address.port)}/api/v1/auctions/realtime`,
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    const repository = new PostgresAuctionRepository(db)
    for (const id of ['rt-a', 'rt-b', 'rt-c']) await repository.publish(watchlistAuction(id))

    app = await bootApp(true)
    const urls = urlsOf(app)
    baseUrl = urls.http
    wsUrl = urls.ws
  }, 180_000)

  afterEach(() => {
    for (const session of sessions.splice(0)) session.close()
  })

  afterAll(async () => {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    await app?.close()
    await db?.destroy()
    await container?.stop()
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  })

  it('CA-01: dos sesiones observando la misma subasta reciben la puja con su resumen', async () => {
    const first = await connect()
    const second = await connect()
    for (const session of [first, second]) {
      session.send({ type: 'subscribe', channel: 'auctions/rt-a' })
      await session.waitFor((frame) => frame.type === 'subscribed', 'subscribed')
    }

    await placeBid('rt-a', 'rt-a-1', 10)
    await placeBid('rt-a', 'rt-a-2', 30)

    for (const session of [first, second]) {
      const latest = await session.waitFor(
        (frame) => frame.signal?.revision === 2,
        'senal con revision 2',
      )
      expect(latest).toMatchObject({
        type: 'signal',
        channel: 'auctions/rt-a',
        signal: {
          auctionId: 'rt-a',
          reason: 'BID_ACCEPTED',
          summary: { status: 'ACTIVE', currentBidCredits: 30, bidCount: 2 },
        },
      })
    }
  })

  it('CA-02: eventos de dos subastas solo llegan a quien observa cada una', async () => {
    const watchingB = await connect()
    const watchingC = await connect()
    watchingB.send({ type: 'subscribe', channel: 'auctions/rt-b' })
    watchingC.send({ type: 'subscribe', channel: 'auctions/rt-c' })
    await watchingB.waitFor((frame) => frame.type === 'subscribed', 'subscribed')
    await watchingC.waitFor((frame) => frame.type === 'subscribed', 'subscribed')

    await Promise.all([placeBid('rt-b', 'rt-b-1', 10), placeBid('rt-c', 'rt-c-1', 20)])

    await watchingB.waitFor((frame) => frame.signal?.auctionId === 'rt-b', 'senal de rt-b')
    await watchingC.waitFor((frame) => frame.signal?.auctionId === 'rt-c', 'senal de rt-c')
    const onlyOwn = (session: Session, auctionId: string): boolean =>
      session.frames
        .filter((frame) => frame.type === 'signal')
        .every((frame) => frame.signal?.auctionId === auctionId)
    expect(onlyOwn(watchingB, 'rt-b')).toBe(true)
    expect(onlyOwn(watchingC, 'rt-c')).toBe(true)
  })

  it('el canal agregado de Marketplace recibe senales de todas las subastas, sin resumen', async () => {
    const market = await connect()
    market.send({ type: 'subscribe', channel: 'auctions' })
    await market.waitFor((frame) => frame.type === 'subscribed', 'subscribed')

    await placeBid('rt-a', 'rt-a-3', 40)
    await placeBid('rt-b', 'rt-b-2', 50)

    const fromA = await market.waitFor((frame) => frame.signal?.revision === 3, 'senal de rt-a')
    await market.waitFor(
      (frame) => frame.signal?.auctionId === 'rt-b' && frame.signal.revision === 2,
      'senal de rt-b',
    )
    expect(fromA.channel).toBe('auctions')
    expect(fromA.signal).not.toHaveProperty('summary')
  })

  it('CA-04: un cambio de estado se difunde con el nuevo estado', async () => {
    const watcher = await connect()
    watcher.send({ type: 'subscribe', channel: 'auctions/rt-c' })
    await watcher.waitFor((frame) => frame.type === 'subscribed', 'subscribed')

    await sql`update auctions set status = 'CANCELLED', cancelled_at = now() where id = 'rt-c'`.execute(
      db,
    )

    const frame = await watcher.waitFor((frame) => frame.signal?.reason === 'CANCELLED', 'cierre')
    expect(frame.signal?.summary).toMatchObject({ status: 'CANCELLED' })
  })

  it('un ticket usado, desconocido o ausente cierra con 4401', async () => {
    const ticket = await issueTicket()
    const first = await Session.open(wsUrl)
    sessions.push(first)
    first.send({ type: 'auth', ticket })
    await first.waitFor((frame) => frame.type === 'authenticated', 'authenticated')

    const reused = await Session.open(wsUrl)
    sessions.push(reused)
    reused.send({ type: 'auth', ticket })
    const unknown = await Session.open(wsUrl)
    sessions.push(unknown)
    unknown.send({ type: 'auth', ticket: 'desconocido' })
    const silent = await Session.open(wsUrl)
    sessions.push(silent)
    silent.send({ type: 'subscribe', channel: 'auctions' })

    expect(await reused.waitForClose()).toBe(4401)
    expect(await unknown.waitForClose()).toBe(4401)
    expect(await silent.waitForClose()).toBe(4401)
  })

  it('un mensaje de mas de 1 KiB cierra la conexion', async () => {
    const session = await connect()
    session.send({ type: 'subscribe', channel: 'auctions', padding: 'x'.repeat(2048) })

    expect(await session.waitForClose()).toBe(1009)
  })

  it('limita a 3 las conexiones por usuario con 4429', async () => {
    await connect()
    await connect()
    await connect()
    const extra = await Session.open(wsUrl)
    sessions.push(extra)
    extra.send({ type: 'auth', ticket: await issueTicket() })

    expect(await extra.waitForClose()).toBe(4429)
  })

  it('CA-06: la senal no contiene datos personales', async () => {
    const watcher = await connect()
    watcher.send({ type: 'subscribe', channel: 'auctions/rt-b' })
    await watcher.waitFor((frame) => frame.type === 'subscribed', 'subscribed')

    await placeBid('rt-b', 'rt-b-3', 60)
    await watcher.waitFor((frame) => frame.signal?.revision === 3, 'senal')

    const serialized = JSON.stringify(watcher.frames)
    expect(serialized).not.toContain('bidder-1')
    expect(serialized).not.toContain('seller-1')
  })

  it('CA-03: si se cae la conexion de escucha, avisa resync y las senales se reanudan', async () => {
    const watcher = await connect()
    watcher.send({ type: 'subscribe', channel: 'auctions/rt-a' })
    await watcher.waitFor((frame) => frame.type === 'subscribed', 'subscribed')

    // Mata SOLO la conexion que esta en LISTEN; el pool de consultas no se toca.
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where query like 'LISTEN auction_realtime%' and pid <> pg_backend_pid()
    `.execute(db)

    await watcher.waitFor((frame) => frame.type === 'resync', 'resync tras reconectar')
    await placeBid('rt-a', 'rt-a-after-resync', 99)
    await watcher.waitFor(
      (frame) =>
        frame.signal?.auctionId === 'rt-a' &&
        (frame.signal.summary as { currentBidCredits: number } | undefined)?.currentBidCredits ===
          99,
      'senal posterior a la reconexion',
    )
  })

  it('con el interruptor apagado no hay endpoint de tickets ni WebSocket', async () => {
    const disabled = await bootApp(false)
    try {
      const urls = urlsOf(disabled)
      const response = await fetch(`${urls.http}/api/v1/auctions/realtime/tickets`, {
        method: 'POST',
      })
      expect(response.status).toBe(404)

      const refused = new WebSocket(urls.ws)
      const outcome = await new Promise<string>((resolve) => {
        refused.once('open', () => {
          resolve('open')
        })
        refused.once('error', () => {
          resolve('refused')
        })
        refused.once('unexpected-response', () => {
          resolve('refused')
        })
      })
      expect(outcome).toBe('refused')
    } finally {
      await disabled.close()
    }
  })
})
