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

const PATH = '/api/v1/admin/auction-metrics/users-and-commissions'
const PERIOD = 'from=2026-09-28T00:00:00Z&to=2026-10-04T00:00:00Z'
const at = (iso: string): Date => new Date(iso)

const base = (
  id: string,
  publishedAt: string,
  hours: 24 | 48,
): Pick<
  MetricsAuctionFact,
  'id' | 'priceKind' | 'publishedAt' | 'closesAt' | 'durationHours' | 'publicationFeeCredits'
> => ({
  id,
  priceKind: 'CREDITS',
  publishedAt: at(publishedAt),
  closesAt: new Date(at(publishedAt).getTime() + hours * 3_600_000),
  durationHours: hours,
  publicationFeeCredits: hours === 24 ? 1 : 3,
})

const seeded = (): InMemoryAuctionMetricsRepository => {
  const repository = new InMemoryAuctionMetricsRepository()
  repository.seed(
    {
      ...base('a', '2026-09-28T10:00:00Z', 24),
      status: 'FINISHED',
      sellerId: 'S1',
      bids: [
        { bidderId: 'B1', placedAt: at('2026-09-28T10:10:00Z') },
        { bidderId: 'B1', placedAt: at('2026-09-28T10:20:00Z') },
      ],
    },
    {
      ...base('b', '2026-09-29T10:00:00Z', 48),
      status: 'SOLD',
      sellerId: 'S1',
      buyerId: 'B1',
      buyNowCompletedAt: at('2026-09-29T12:00:00Z'),
    },
    {
      ...base('c', '2026-09-30T10:00:00Z', 24),
      status: 'CANCELLED',
      sellerId: 'S2',
      cancelledAt: at('2026-09-30T11:00:00Z'),
      cancellation: { refundAmountCredits: 0.5, walletRefundStatus: 'CONFIRMED' },
    },
    {
      ...base('d', '2026-10-01T10:00:00Z', 48),
      status: 'CANCELLED',
      sellerId: 'S3',
      cancelledAt: at('2026-10-01T12:00:00Z'),
      cancellation: { refundAmountCredits: 0, walletRefundStatus: 'NOT_REQUIRED' },
      bids: [{ bidderId: 'B2', placedAt: at('2026-10-01T10:30:00Z') }],
    },
  )
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

describe('HTTP usuarios activos y comisiones HU-91.5 con AUTH_MODE=jwt', () => {
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

  it('devuelve exactamente la forma del contrato §4.4', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual([
      'activeUsers',
      'asOf',
      'commissions',
      'definitionsVersion',
      'limit',
      'period',
    ])
    expect(Object.keys(response.body.activeUsers).sort()).toEqual([
      'byRole',
      'definition',
      'top',
      'totalActiveUsers',
    ])
    expect(Object.keys(response.body.commissions).sort()).toEqual([
      'byDuration',
      'gross',
      'net',
      'pendingRefunds',
      'realMoneyCommission',
      'refunded',
      'salesCommission',
      'scope',
      'source',
      'unit',
      'walletReconciliation',
    ])
    expect(response.body.definitionsVersion).toBe('hu-91.v1')
    expect(response.body.limit).toBe(10)
  })

  it('usuarios activos: subastas distintas, orden y desempate, y solo el sub opaco', async () => {
    const { activeUsers } = (await get()).body

    expect(activeUsers.totalActiveUsers).toBe(5) // S1 S2 S3 B1 B2
    expect(activeUsers.byRole).toEqual({ sellers: 3, bidders: 2, buyers: 1 })
    expect(activeUsers.top).toEqual([
      // B1 puja DOS veces en `a` y compra `b`: dos subastas, no tres filas.
      { rank: 1, playerId: 'B1', activeAuctions: 2, asSeller: 0, asBidder: 1, asBuyer: 1 },
      { rank: 2, playerId: 'S1', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
      { rank: 3, playerId: 'B2', activeAuctions: 1, asSeller: 0, asBidder: 1, asBuyer: 0 },
      { rank: 4, playerId: 'S2', activeAuctions: 1, asSeller: 1, asBidder: 0, asBuyer: 0 },
      { rank: 5, playerId: 'S3', activeAuctions: 1, asSeller: 1, asBidder: 0, asBuyer: 0 },
    ])
    for (const user of activeUsers.top) {
      expect(Object.keys(user).sort()).toEqual([
        'activeAuctions',
        'asBidder',
        'asBuyer',
        'asSeller',
        'playerId',
        'rank',
      ])
    }
    expect(JSON.stringify(activeUsers)).not.toMatch(/email|name|nombre|balance|saldo/i)
  })

  it('comisiones: bruto - reembolsado = neto, por duracion, con las razones UNAVAILABLE exactas', async () => {
    const { commissions } = (await get()).body

    expect(commissions).toEqual({
      scope: 'PUBLICATION_FEE_ONLY',
      unit: 'CREDITS',
      source: 'AUCTION_LOCAL',
      gross: { unit: 'CREDITS', amount: 8 }, // 1 + 3 + 1 + 3
      refunded: { unit: 'CREDITS', amount: 0.5 }, // c; d es automatica (NOT_REQUIRED)
      net: { unit: 'CREDITS', amount: 7.5 },
      pendingRefunds: { count: 0, amount: { unit: 'CREDITS', amount: 0 } },
      byDuration: [
        { durationHours: 24, auctions: 2, feePerAuction: 1, gross: { unit: 'CREDITS', amount: 2 } },
        { durationHours: 48, auctions: 2, feePerAuction: 3, gross: { unit: 'CREDITS', amount: 6 } },
      ],
      salesCommission: { availability: 'UNAVAILABLE', reason: 'NO_SALE_COMMISSION_DEFINED' },
      realMoneyCommission: {
        availability: 'UNAVAILABLE',
        reason: 'OFFICIAL_AUCTION_HAS_NO_FEES',
      },
      walletReconciliation: {
        availability: 'UNAVAILABLE',
        reason: 'WALLET_READ_ENDPOINT_NOT_AVAILABLE',
      },
    })
  })

  it('un periodo sin datos devuelve sumas en 0, listas vacias y ambas duraciones', async () => {
    const response = await get('from=2025-01-01T00:00:00Z&to=2025-01-08T00:00:00Z')

    expect(response.status).toBe(200)
    expect(response.body.activeUsers).toMatchObject({
      totalActiveUsers: 0,
      byRole: { sellers: 0, bidders: 0, buyers: 0 },
      top: [],
    })
    expect(response.body.commissions.gross.amount).toBe(0)
    expect(response.body.commissions.net.amount).toBe(0)
    expect(
      response.body.commissions.byDuration.map(
        (row: { durationHours: number }) => row.durationHours,
      ),
    ).toEqual([24, 48])
  })

  it('limit recorta el ranking pero no el total de usuarios', async () => {
    const response = await get(`${PERIOD}&limit=2`)

    expect(response.body.limit).toBe(2)
    expect(response.body.activeUsers.top).toHaveLength(2)
    expect(response.body.activeUsers.totalActiveUsers).toBe(5)
  })

  describe('validacion de parametros', () => {
    it.each(['0', '51', 'abc', '1.5', '-3'])('limit=%s -> 400 INVALID_PARAMETER', async (limit) => {
      const response = await get(`${PERIOD}&limit=${limit}`)

      expect(response.status).toBe(400)
      expect(response.body.code).toBe('INVALID_PARAMETER')
    })

    it.each([
      ['from sin zona horaria', 'from=2026-09-28T00:00:00&to=2026-10-04T00:00:00Z'],
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

    it.each(['granularity=DAY', 'currency=COP', 'playerId=otro', 'foo=bar'])(
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
      'rechaza con 403 a %s sin datos ni identificadores',
      async (token) => {
        const response = await get(PERIOD, token)

        expect(response.status).toBe(403)
        expect(Object.keys(response.body).sort()).toEqual(['error', 'message', 'statusCode'])
        const text = JSON.stringify(response.body)
        for (const leaked of [
          'activeUsers',
          'commissions',
          'playerId',
          'B1',
          'S1',
          'definitionsVersion',
        ]) {
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

    it('la autorizacion se evalua antes que la validacion: un jugador con parametros invalidos recibe 403', async () => {
      expect((await get('from=basura&limit=999', 'token-player')).status).toBe(403)
    })
  })
})

describe('HTTP usuarios activos y comisiones HU-91.5 con AUTH_MODE=disabled', () => {
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
    expect(JSON.stringify(response.body)).not.toContain('activeUsers')
  })
})
