import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import WebSocket, { type RawData } from 'ws'

import type * as NestPlatformWs from '@nestjs/platform-ws'
import type * as NestTesting from '@nestjs/testing'
import type {
  TokenVerifierPort,
  VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * EN-034, TASK 34.2: autenticacion y roles del endpoint de tickets y del WebSocket con
 * `AUTH_MODE=jwt` (el modo de produccion). Las demas pruebas de realtime corren con
 * `AUTH_MODE=disabled`, donde todas las identidades son `anonymous` y todos los roles se conceden,
 * asi que no pueden ver un 401 ni un 403.
 *
 * El verificador de Cognito se sustituye por uno que reconoce unos testimonios fijos; el resto
 * (guard global, `RolesGuard`, el controlador y el gateway) es el real.
 */

const GAME_MASTER_SUBJECT = 'upb-company'

type RoleName = 'PLAYER' | 'MODERATOR' | 'ADMINISTRATOR' | 'SUPER_ADMINISTRATOR' | 'GAME_MASTER'

const identity = (subject: string, roles: readonly RoleName[]): VerifiedIdentity => ({
  subject,
  email: null,
  roles: new Set(roles),
})

/** Testimonios que entiende el verificador simulado. Cualquier otro es invalido. */
const TOKENS: Readonly<Record<string, VerifiedIdentity>> = {
  'jwt-player-1': identity('player-1', ['PLAYER']),
  'jwt-player-2': identity('player-2', ['PLAYER']),
  'jwt-game-master': identity(GAME_MASTER_SUBJECT, ['GAME_MASTER']),
  'jwt-game-master-impostor': identity('otra-persona', ['GAME_MASTER']),
  'jwt-moderator': identity('moderator-1', ['MODERATOR']),
  'jwt-administrator': identity('admin-1', ['ADMINISTRATOR']),
  'jwt-super-administrator': identity('root-1', ['SUPER_ADMINISTRATOR']),
  'jwt-sin-roles': identity('nobody-1', []),
}

describe('Realtime de Subasta con JWT: autenticacion y roles (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let app: INestApplication
  let http: string
  let wsUrl: string
  const sockets: WebSocket[] = []

  const bootApp = async (): Promise<INestApplication> => {
    const previous = { ...process.env }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: container?.getConnectionUri() ?? '',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'pool-de-prueba',
      COGNITO_CLIENT_ID: 'cliente-de-prueba',
      GAME_MASTER_SUBJECT,
      AUCTION_REALTIME_ENABLED: 'true',
    })

    let created: INestApplication | undefined
    try {
      // `@Module` es estatico y lee el interruptor al cargar: el entorno se fija antes de cargar el
      // modulo, y Nest se carga dentro del mismo aislamiento para compartir `Reflector`.
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { AppModule } = require('../../src/infrastructure/bootstrap/app.module') as {
            AppModule: new () => unknown
          }
          const { TOKEN_VERIFIER, TokenVerificationError } =
            require('../../src/application/ports/TokenVerifierPort') as {
              TOKEN_VERIFIER: symbol
              TokenVerificationError: new () => Error
            }
          const { Test } = require('@nestjs/testing') as typeof NestTesting
          const { WsAdapter } = require('@nestjs/platform-ws') as typeof NestPlatformWs
          /* eslint-enable @typescript-eslint/no-require-imports */

          const verifier: TokenVerifierPort = {
            verify: (token) => {
              const found = TOKENS[token]
              return found === undefined
                ? Promise.reject(new TokenVerificationError())
                : Promise.resolve(found)
            },
          }

          Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(TOKEN_VERIFIER)
            .useValue(verifier)
            .compile()
            .then(async (module) => {
              created = module.createNestApplication()
              created.setGlobalPrefix('api')
              created.useWebSocketAdapter(new WsAdapter(created))
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

  const requestTicket = (authorization?: string): Promise<Response> =>
    fetch(`${http}/api/v1/auctions/realtime/tickets`, {
      method: 'POST',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    })

  const ticketFor = async (token: string): Promise<string> => {
    const response = await requestTicket(`Bearer ${token}`)
    expect(response.status).toBe(201)
    return ((await response.json()) as { ticket: string }).ticket
  }

  /** Abre un socket y deja registrados sus mensajes y su codigo de cierre. */
  const open = async (
    url = wsUrl,
  ): Promise<{ socket: WebSocket; frames: { type: string }[]; closed: () => number | null }> => {
    const socket = new WebSocket(url)
    sockets.push(socket)
    const frames: { type: string }[] = []
    let closeCode: number | null = null
    socket.on('message', (data: RawData) => {
      frames.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { type: string })
    })
    socket.on('close', (code) => {
      closeCode = code
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve()
      })
      socket.once('error', reject)
    })
    return { socket, frames, closed: () => closeCode }
  }

  const waitUntil = async (condition: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Tiempo agotado esperando: ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    const db = createDatabase({ connectionString: container.getConnectionUri() })
    try {
      expect((await migrateToLatest(db)).error).toBeUndefined()
    } finally {
      await db.destroy()
    }

    app = await bootApp()
    const address = app.getHttpServer().address() as { port: number }
    http = `http://127.0.0.1:${String(address.port)}`
    wsUrl = `ws://127.0.0.1:${String(address.port)}/api/v1/auctions/realtime`
  }, 180_000)

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close()
  })

  afterAll(async () => {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    await app?.close()
    await container?.stop()
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  })

  describe('POST /v1/auctions/realtime/tickets', () => {
    it.each([
      ['sin cabecera Authorization', undefined],
      ['con un testimonio invalido', 'Bearer jwt-que-no-existe'],
      ['con un esquema que no es Bearer', 'Basic jwt-player-1'],
      ['con una cabecera con campos de mas', 'Bearer jwt-player-1 sobra'],
      ['sin el testimonio', 'Bearer'],
    ])('401 %s', async (_name, authorization) => {
      const response = await requestTicket(authorization)

      expect(response.status).toBe(401)
    })

    it('201 para un jugador, con un ticket opaco de 30 s', async () => {
      const response = await requestTicket('Bearer jwt-player-1')

      expect(response.status).toBe(201)
      const body = (await response.json()) as { ticket: string; expiresInSeconds: number }
      expect(body.expiresInSeconds).toBe(30)
      expect(body.ticket.length).toBeGreaterThan(30)
      // Es opaco: no contiene ni el testimonio ni el sujeto.
      expect(body.ticket).not.toContain('jwt-player-1')
      expect(body.ticket).not.toContain('player-1')
    })

    it('201 para el Maestro de Juego configurado (rol GAME_MASTER y sujeto GAME_MASTER_SUBJECT)', async () => {
      const response = await requestTicket('Bearer jwt-game-master')

      expect(response.status).toBe(201)
    })

    it.each([
      ['un GAME_MASTER con un sujeto distinto del configurado', 'jwt-game-master-impostor'],
      ['un moderador', 'jwt-moderator'],
      ['un administrador', 'jwt-administrator'],
      ['un super administrador sin rol de jugador', 'jwt-super-administrator'],
      ['una identidad sin roles', 'jwt-sin-roles'],
    ])('403 para %s', async (_name, token) => {
      const response = await requestTicket(`Bearer ${token}`)

      expect(response.status).toBe(403)
    })
  })

  describe('WebSocket /v1/auctions/realtime', () => {
    it('acepta un ticket valido y confirma', async () => {
      const { socket, frames } = await open()

      socket.send(JSON.stringify({ type: 'auth', ticket: await ticketFor('jwt-player-1') }))

      await waitUntil(() => frames.some((frame) => frame.type === 'authenticated'), 'authenticated')
    })

    it('el JWT NO sirve como ticket: se cierra con 4401', async () => {
      const { socket, closed } = await open()

      socket.send(JSON.stringify({ type: 'auth', ticket: 'jwt-player-1' }))

      await waitUntil(() => closed() !== null, 'cierre')
      expect(closed()).toBe(4401)
    })

    it('un JWT en la URL se ignora: sin ticket en el primer mensaje se cierra con 4401', async () => {
      const { socket, closed } = await open(`${wsUrl}?token=jwt-player-1&access_token=jwt-player-1`)

      socket.send(JSON.stringify({ type: 'subscribe', channel: 'auctions' }))

      await waitUntil(() => closed() !== null, 'cierre')
      expect(closed()).toBe(4401)
    })

    it('un ticket solo sirve una vez', async () => {
      const ticket = await ticketFor('jwt-player-1')
      const first = await open()
      first.socket.send(JSON.stringify({ type: 'auth', ticket }))
      await waitUntil(() => first.frames.some((frame) => frame.type === 'authenticated'), 'primero')

      const second = await open()
      second.socket.send(JSON.stringify({ type: 'auth', ticket }))

      await waitUntil(() => second.closed() !== null, 'cierre del segundo')
      expect(second.closed()).toBe(4401)
    })

    it('la identidad de la conexion sale del JWT con el que se pidio el ticket: el limite de 3 es por persona', async () => {
      // Tres conexiones de player-1 caben; la cuarta es 4429. player-2 no se ve afectado.
      const player1 = []
      for (let index = 0; index < 3; index += 1) {
        const connection = await open()
        connection.socket.send(
          JSON.stringify({ type: 'auth', ticket: await ticketFor('jwt-player-1') }),
        )
        await waitUntil(
          () => connection.frames.some((frame) => frame.type === 'authenticated'),
          `conexion ${String(index + 1)} de player-1`,
        )
        player1.push(connection)
      }

      const fourth = await open()
      fourth.socket.send(JSON.stringify({ type: 'auth', ticket: await ticketFor('jwt-player-1') }))
      await waitUntil(() => fourth.closed() !== null, 'cierre de la cuarta')
      expect(fourth.closed()).toBe(4429)

      const other = await open()
      other.socket.send(JSON.stringify({ type: 'auth', ticket: await ticketFor('jwt-player-2') }))
      await waitUntil(
        () => other.frames.some((frame) => frame.type === 'authenticated'),
        'conexion de player-2',
      )
      expect(other.closed()).toBeNull()
      expect(player1.every((connection) => connection.closed() === null)).toBe(true)
    })
  })
})
