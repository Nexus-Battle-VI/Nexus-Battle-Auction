import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import {
  AUCTION_METRICS_REPOSITORY,
  type AuctionMetricsRepositoryPort,
} from '../../src/application/ports/AuctionMetricsRepositoryPort'
import {
  CATALOG_PRODUCT_DETAILS,
  type CatalogProductDetailsPort,
} from '../../src/application/ports/CatalogProductDetailsPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const identity = (subject: string, ...roles: Role[]): VerifiedIdentity => ({
  subject,
  email: null,
  roles: new Set(roles),
})
const identities: Readonly<Record<string, VerifiedIdentity>> = {
  'token-admin': identity('admin-1', Role.Administrator),
  'token-super': identity('super-1', Role.SuperAdministrator),
  'token-player': identity('player-1', Role.Player),
  'token-moderator': identity('moderator-1', Role.Moderator),
  'token-no-roles': identity('nobody-1'),
}
const verifier: TokenVerifierPort = {
  verify: (token) => {
    const found = identities[token]
    return found === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(found)
  },
}

const PATH = '/api/v1/admin/auction-metrics/summary'
const PERIOD = 'from=2026-09-28T00:00:00Z&to=2026-10-04T00:00:00Z&granularity=WEEK'
const SECTIONS = [
  'averagePrices',
  'closingTimeAndTrends',
  'productRankings',
  'usersAndCommissions',
  'volumeAndSuccess',
]
const at = (iso: string): Date => new Date(iso)

const seeded = (): InMemoryAuctionMetricsRepository => {
  const repository = new InMemoryAuctionMetricsRepository()
  const fact = (
    id: string,
    publishedAt: string,
    overrides: Partial<MetricsAuctionFact>,
  ): MetricsAuctionFact => ({
    id,
    priceKind: 'CREDITS',
    status: 'ACTIVE',
    publishedAt: at(publishedAt),
    closesAt: new Date(at(publishedAt).getTime() + 24 * 3_600_000),
    durationHours: 24,
    publicationFeeCredits: 1,
    sellerId: `S-${id}`,
    ...overrides,
  })
  repository.seed(
    fact('a', '2026-09-28T10:00:00Z', {
      status: 'FINISHED',
      closingResultType: 'WITH_WINNER',
      finishedAt: at('2026-09-29T10:00:30Z'),
      finalAmountCredits: 120,
      bids: [{ bidderId: 'B1', placedAt: at('2026-09-28T11:00:00Z') }],
    }),
    fact('b', '2026-09-29T10:00:00Z', {
      status: 'FINISHED',
      closingResultType: 'WITHOUT_BIDS',
      finishedAt: at('2026-09-30T10:00:30Z'),
    }),
  )
  return repository
}

/** Repositorio cuyos metodos listados fallan; el resto delega en el adaptador en memoria. */
const failingOn = (
  methods: readonly (keyof AuctionMetricsRepositoryPort)[],
): AuctionMetricsRepositoryPort => {
  const inner = seeded()
  const wrapped: Record<string, unknown> = {}
  for (const name of [
    'getUsersAndCommissions',
    'getAveragePrices',
    'getVolumeAndSuccess',
    'getProductRankings',
    'getClosingTime',
    'getTrendPoints',
  ] as const) {
    wrapped[name] = methods.includes(name)
      ? () => Promise.reject(new Error(`fallo interno ${name} postgres://u:p@host/db`))
      : (...args: unknown[]) =>
          (inner[name] as (...parameters: unknown[]) => Promise<unknown>)(...args)
  }
  return wrapped as unknown as AuctionMetricsRepositoryPort
}

const catalogDown: CatalogProductDetailsPort = {
  findProducts: () => Promise.reject(new ExternalDependencyUnavailableError('catalog')),
}

interface Overrides {
  readonly repository?: AuctionMetricsRepositoryPort
  readonly catalog?: CatalogProductDetailsPort
}

const createApp = async ({ repository, catalog }: Overrides = {}): Promise<INestApplication> => {
  Object.assign(process.env, {
    INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
    PERSISTENCE_DRIVER: 'memory',
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
    COGNITO_CLIENT_ID: 'cliente-pruebas',
  })
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(verifier)
    .overrideProvider(AUCTION_METRICS_REPOSITORY)
    .useValue(repository ?? seeded())
  if (catalog !== undefined) {
    builder = builder.overrideProvider(CATALOG_PRODUCT_DETAILS).useValue(catalog)
  }
  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()
  return app
}

// El arranque del modulo Nest completo supera los 5 s por defecto de Jest.
jest.setTimeout(30_000)

describe('HTTP consolidado de metricas HU-91.6 (GET /summary)', () => {
  const previousEnv = { ...process.env }
  let app: INestApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })
  afterAll(() => {
    process.env = previousEnv
  })

  const get = async (query = PERIOD, token = 'token-admin', overrides: Overrides = {}) => {
    app = await createApp(overrides)
    return request(app.getHttpServer())
      .get(`${PATH}?${query}`)
      .set('Authorization', `Bearer ${token}`)
  }

  it('flujo normal: cinco secciones AVAILABLE con el periodo y la granularidad pedidos', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual([
      'asOf',
      'definitionsVersion',
      'granularity',
      'limit',
      'period',
      'sections',
    ])
    expect(response.body).toMatchObject({
      definitionsVersion: 'hu-91.v1',
      granularity: 'WEEK',
      limit: 10,
      period: { from: '2026-09-28T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' },
    })
    expect(Object.keys(response.body.sections).sort()).toEqual(SECTIONS)
    for (const name of SECTIONS) {
      expect(response.body.sections[name].status).toBe('AVAILABLE')
      expect(response.body.sections[name].data.period).toEqual(response.body.period)
    }
    expect(response.body.sections.volumeAndSuccess.data.playerAuctions.published).toBe(2)
  })

  it('Catalog caido: el consolidado responde 200, rankings sigue AVAILABLE con enrichment UNAVAILABLE', async () => {
    const response = await get(PERIOD, 'token-admin', { catalog: catalogDown })

    expect(response.status).toBe(200)
    expect(response.body.sections.productRankings.status).toBe('AVAILABLE')
    expect(response.body.sections.productRankings.data.enrichment.status).toBe('UNAVAILABLE')
    // Los conteos siguen siendo correctos y el resto de secciones no se ve afectado.
    expect(response.body.sections.productRankings.data.mostAuctioned.length).toBeGreaterThan(0)
    for (const name of SECTIONS) expect(response.body.sections[name].status).toBe('AVAILABLE')
  })

  it('una seccion que falla queda DEGRADED, sin filtrar el detalle, y las demas siguen', async () => {
    const response = await get(PERIOD, 'token-admin', {
      repository: failingOn(['getAveragePrices']),
    })

    expect(response.status).toBe(200)
    expect(response.body.sections.averagePrices).toEqual({
      status: 'DEGRADED',
      reason: 'SECTION_COMPUTATION_FAILED',
    })
    expect(JSON.stringify(response.body)).not.toMatch(/postgres:|fallo interno/)
    for (const name of SECTIONS.filter((section) => section !== 'averagePrices')) {
      expect(response.body.sections[name].status).toBe('AVAILABLE')
    }
  })

  it('si fallan las cinco secciones responde 503 METRICS_UNAVAILABLE, nunca 500', async () => {
    const response = await get(PERIOD, 'token-admin', {
      repository: failingOn([
        'getUsersAndCommissions',
        'getAveragePrices',
        'getVolumeAndSuccess',
        'getProductRankings',
        'getClosingTime',
        'getTrendPoints',
      ]),
    })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      statusCode: 503,
      code: 'METRICS_UNAVAILABLE',
      message: expect.any(String) as string,
    })
    expect(JSON.stringify(response.body)).not.toMatch(/postgres:|fallo interno/)
  })

  describe('validacion de parametros', () => {
    it.each([
      [
        'from sin zona horaria',
        'from=2026-09-28T00:00:00&to=2026-10-04T00:00:00Z',
        'INVALID_PERIOD',
      ],
      [
        'from posterior a to',
        'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
        'INVALID_PERIOD',
      ],
      [
        'periodo de mas de 366 dias',
        'from=2025-01-01T00:00:00Z&to=2026-10-04T00:00:00Z',
        'INVALID_PERIOD',
      ],
      ['limit 0', `${PERIOD}&limit=0`, 'INVALID_PARAMETER'],
      ['limit 51', `${PERIOD}&limit=51`, 'INVALID_PARAMETER'],
      ['granularity desconocida', 'granularity=YEAR', 'INVALID_PARAMETER'],
      [
        'DAY con mas de 92 dias',
        'from=2026-06-01T00:00:00Z&to=2026-10-04T00:00:00Z&granularity=DAY',
        'INVALID_PARAMETER',
      ],
    ])('%s -> 400 %s', async (_name, query, code) => {
      const response = await get(query)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        statusCode: 400,
        code,
        message: expect.any(String) as string,
      })
    })

    it('un parametro no declarado se rechaza con 400 INVALID_REQUEST', async () => {
      const response = await get(`${PERIOD}&playerId=otro`)

      expect(response.status).toBe(400)
      expect(response.body.code).toBe('INVALID_REQUEST')
    })
  })

  describe('autorizacion (CA-06)', () => {
    it.each(['token-admin', 'token-super'])('permite %s', async (token) => {
      expect((await get(PERIOD, token)).status).toBe(200)
    })

    it.each(['token-player', 'token-moderator', 'token-no-roles'])(
      'rechaza con 403 a %s sin datos agregados',
      async (token) => {
        const response = await get(PERIOD, token)

        expect(response.status).toBe(403)
        expect(JSON.stringify(response.body)).not.toMatch(/sections|published|playerId/)
      },
    )

    it('sin token responde 401', async () => {
      app = await createApp()

      const response = await request(app.getHttpServer()).get(`${PATH}?${PERIOD}`)

      expect(response.status).toBe(401)
    })
  })
})
