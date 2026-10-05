import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import { AUCTION_METRICS_REPOSITORY } from '../../src/application/ports/AuctionMetricsRepositoryPort'
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
  'token-game-master': identity('gm-1', Role.GameMaster),
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

const PATH = '/api/v1/admin/auction-metrics/average-prices'
const PERIOD = 'from=2026-09-28T00:00:00Z&to=2026-10-04T00:00:00Z'
const at = (iso: string): Date => new Date(iso)

const seeded = (): InMemoryAuctionMetricsRepository => {
  const repository = new InMemoryAuctionMetricsRepository()
  const facts: MetricsAuctionFact[] = [
    {
      id: 'sale-close',
      priceKind: 'CREDITS',
      status: 'FINISHED',
      publishedAt: at('2026-09-28T10:00:00Z'),
      closesAt: at('2026-09-29T10:00:00Z'),
      finishedAt: at('2026-09-29T10:00:30Z'),
      closingResultType: 'WITH_WINNER',
      finalAmountCredits: 100,
      minimumBidCredits: 20,
    },
    {
      id: 'sale-buy-now',
      priceKind: 'CREDITS',
      status: 'SOLD',
      publishedAt: at('2026-09-30T10:00:00Z'),
      closesAt: at('2026-10-01T10:00:00Z'),
      buyNowCompletedAt: at('2026-09-30T12:00:00Z'),
      buyNowPriceCredits: 51,
      minimumBidCredits: 10,
    },
    {
      id: 'official-cop',
      priceKind: 'REAL_MONEY',
      status: 'ACTIVE',
      publishedAt: at('2026-09-29T10:00:00Z'),
      closesAt: at('2026-09-30T10:00:00Z'),
      officialMark: 'OFFICIAL',
      currency: 'COP',
      minimumBidAmountMinor: 90_000,
      buyNowAmountMinor: 120_000,
    },
    {
      id: 'official-usd',
      priceKind: 'REAL_MONEY',
      status: 'ACTIVE',
      publishedAt: at('2026-09-30T10:00:00Z'),
      closesAt: at('2026-10-01T10:00:00Z'),
      officialMark: 'PREMIUM',
      currency: 'USD',
      minimumBidAmountMinor: 2_500,
    },
  ]
  repository.seed(...facts)
  return repository
}

const createApp = async (env: Record<string, string>): Promise<INestApplication> => {
  Object.assign(process.env, {
    INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
    PERSISTENCE_DRIVER: 'memory',
    ...env,
  })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(verifier)
    .overrideProvider(AUCTION_METRICS_REPOSITORY)
    .useValue(seeded())
    .compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()
  return app
}

describe('HTTP precios promedio HU-91.4 con AUTH_MODE=jwt', () => {
  let app: INestApplication
  const previousEnv = { ...process.env }

  beforeAll(async () => {
    app = await createApp({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-pruebas',
    })
  })

  afterAll(async () => {
    await app.close()
    process.env = previousEnv
  })

  const get = (query = PERIOD, token = 'token-admin') =>
    request(app.getHttpServer()).get(`${PATH}?${query}`).set('Authorization', `Bearer ${token}`)

  it('devuelve exactamente la forma del contrato §4.3', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual([
      'asOf',
      'credits',
      'definitionsVersion',
      'period',
      'realMoney',
    ])
    expect(response.body.definitionsVersion).toBe('hu-91.v1')
    expect(response.body.period).toEqual({
      from: '2026-09-28T00:00:00.000Z',
      to: '2026-10-04T00:00:00.000Z',
      timezone: 'UTC',
      bounds: '[from,to)',
    })
    expect(Object.keys(response.body.credits).sort()).toEqual([
      'average',
      'basis',
      'byChannel',
      'listedMinimumBid',
      'max',
      'median',
      'min',
      'salesCount',
    ])
    expect(Object.keys(response.body.realMoney).sort()).toEqual([
      'basis',
      'byCurrency',
      'finalSalePrice',
      'note',
    ])
  })

  it('creditos: precio final de venta con cierre y compra inmediata, y precio de lista', async () => {
    const { credits } = (await get()).body

    expect(credits).toEqual({
      basis: 'FINAL_SALE_PRICE',
      salesCount: 2,
      average: { unit: 'CREDITS', amount: 75.5 }, // (100 + 51) / 2
      median: { unit: 'CREDITS', amount: 75.5 },
      min: { unit: 'CREDITS', amount: 51 },
      max: { unit: 'CREDITS', amount: 100 },
      byChannel: {
        AUCTION_CLOSE: { salesCount: 1, average: { unit: 'CREDITS', amount: 100 } },
        BUY_NOW: { salesCount: 1, average: { unit: 'CREDITS', amount: 51 } },
      },
      listedMinimumBid: { auctionsCount: 2, average: { unit: 'CREDITS', amount: 15 } },
    })
  })

  it('dinero real: solo precio de lista, por moneda en orden ASC, y precio final UNAVAILABLE', async () => {
    const { realMoney } = (await get()).body

    expect(realMoney.basis).toBe('LISTED_PRICE')
    expect(realMoney.finalSalePrice).toEqual({
      availability: 'UNAVAILABLE',
      reason: 'OFFICIAL_AUCTION_HAS_NO_SALE_FLOW',
    })
    expect(realMoney.byCurrency).toEqual([
      {
        currency: 'COP',
        publishedCount: 1,
        listedMinimumBid: {
          average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 90_000 },
          min: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 90_000 },
          max: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 90_000 },
        },
        listedBuyNow: {
          count: 1,
          average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 120_000 },
        },
      },
      {
        currency: 'USD',
        publishedCount: 1,
        listedMinimumBid: {
          average: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 2_500 },
          min: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 2_500 },
          max: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 2_500 },
        },
        listedBuyNow: { count: 0, average: null },
      },
    ])
  })

  it('un periodo sin datos devuelve null (no 0) y monedas vacias', async () => {
    const response = await get('from=2025-01-01T00:00:00Z&to=2025-01-08T00:00:00Z')

    expect(response.status).toBe(200)
    expect(response.body.credits).toMatchObject({
      salesCount: 0,
      average: null,
      median: null,
      min: null,
      max: null,
    })
    expect(response.body.realMoney.byCurrency).toEqual([])
  })

  it('sin parametros usa el periodo por defecto (ultimos 30 dias)', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(200)
    const span = Date.parse(response.body.period.to) - Date.parse(response.body.period.from)
    expect(span).toBe(30 * 24 * 60 * 60 * 1000)
  })

  describe('validacion de parametros', () => {
    it.each([
      ['from sin zona horaria', 'from=2026-09-28T00:00:00&to=2026-10-04T00:00:00Z'],
      ['from igual a to', 'from=2026-09-28T00:00:00Z&to=2026-09-28T00:00:00Z'],
      ['from posterior a to', 'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z'],
      ['periodo de mas de 366 dias', 'from=2025-01-01T00:00:00Z&to=2026-10-04T00:00:00Z'],
      ['fecha imposible', 'from=2026-02-30T00:00:00Z&to=2026-10-04T00:00:00Z'],
      ['to futuro', 'to=2099-01-01T00:00:00Z'],
    ])('rechaza %s con 400 INVALID_PERIOD', async (_name, query) => {
      const response = await get(query)

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        statusCode: 400,
        code: 'INVALID_PERIOD',
        message: expect.any(String) as string,
      })
    })

    it.each(['limit=5', 'granularity=DAY', 'currency=COP', 'playerId=otro'])(
      'un parametro no declarado (%s) se rechaza con 400 INVALID_REQUEST',
      async (query) => {
        const response = await get(`${PERIOD}&${query}`)

        expect(response.status).toBe(400)
        expect(response.body.code).toBe('INVALID_REQUEST')
      },
    )
  })

  describe('autorizacion (CA-06)', () => {
    it.each(['token-admin', 'token-super'])('permite %s', async (token) => {
      expect((await get(PERIOD, token)).status).toBe(200)
    })

    it.each(['token-player', 'token-moderator', 'token-game-master', 'token-no-roles'])(
      'rechaza con 403 a %s sin datos agregados',
      async (token) => {
        const response = await get(PERIOD, token)

        expect(response.status).toBe(403)
        expect(Object.keys(response.body).sort()).toEqual(['error', 'message', 'statusCode'])
        const text = JSON.stringify(response.body)
        for (const leaked of ['credits', 'realMoney', 'definitionsVersion', 'amount']) {
          expect(text).not.toContain(leaked)
        }
      },
    )

    it('rechaza con 401 sin token, con token invalido o con esquema distinto de Bearer', async () => {
      expect((await request(app.getHttpServer()).get(`${PATH}?${PERIOD}`)).status).toBe(401)
      expect((await get(PERIOD, 'inventado')).status).toBe(401)
      expect(
        (
          await request(app.getHttpServer())
            .get(`${PATH}?${PERIOD}`)
            .set('Authorization', 'Basic token-admin')
        ).status,
      ).toBe(401)
    })

    it('la autorizacion se evalua antes que la validacion: un jugador con periodo invalido recibe 403', async () => {
      expect((await get('from=basura', 'token-player')).status).toBe(403)
    })
  })

  it('la ruta no la captura GET v1/auctions/:auctionId (controlador propio)', async () => {
    const response = await get()

    expect(response.body.credits).toBeDefined()
  })
})

describe('HTTP precios promedio HU-91.4 con AUTH_MODE=disabled', () => {
  let app: INestApplication
  const previousEnv = { ...process.env }

  beforeAll(async () => {
    app = await createApp({ AUTH_MODE: 'disabled' })
  })

  afterAll(async () => {
    await app.close()
    process.env = previousEnv
  })

  it('responde 401 aunque la identidad anonima tenga todos los roles (@AuthenticationRequired)', async () => {
    const response = await request(app.getHttpServer()).get(`${PATH}?${PERIOD}`)

    expect(response.status).toBe(401)
    expect(JSON.stringify(response.body)).not.toContain('credits')
  })
})
