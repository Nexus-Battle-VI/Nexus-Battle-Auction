import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
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

const VOLUME = '/api/v1/admin/auction-metrics/volume-and-success'
const TRENDS = '/api/v1/admin/auction-metrics/closing-time-and-trends'

const createApp = async (env: Record<string, string>): Promise<INestApplication> => {
  Object.assign(process.env, {
    INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
    PERSISTENCE_DRIVER: 'memory',
    ...env,
  })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(verifier)
    .compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()
  return app
}

describe('HTTP metricas de Subasta HU-91.2 con AUTH_MODE=jwt (CA-06)', () => {
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

  describe.each([
    ['volume-and-success', VOLUME],
    ['closing-time-and-trends', TRENDS],
  ])('GET %s', (_name, path) => {
    it.each(['token-admin', 'token-super'])(
      'permite %s (ADMINISTRATOR y SUPER_ADMINISTRATOR)',
      async (token) => {
        const response = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`)

        expect(response.status).toBe(200)
        expect(response.body.definitionsVersion).toBe('hu-91.v1')
        expect(response.body.period.timezone).toBe('UTC')
      },
    )

    it.each(['token-player', 'token-moderator', 'token-game-master', 'token-no-roles'])(
      'rechaza con 403 a %s sin exponer datos agregados ni identificadores',
      async (token) => {
        const response = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`)

        expect(response.status).toBe(403)
        expect(Object.keys(response.body).sort()).toEqual(['error', 'message', 'statusCode'])
        const text = JSON.stringify(response.body)
        expect(text).not.toContain('playerAuctions')
        expect(text).not.toContain('officialAuctions')
        expect(text).not.toContain('definitionsVersion')
      },
    )

    it('rechaza con 401 sin token', async () => {
      const response = await request(app.getHttpServer()).get(path)

      expect(response.status).toBe(401)
      expect(JSON.stringify(response.body)).not.toContain('playerAuctions')
    })

    it('rechaza con 401 un token invalido', async () => {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer token-inventado')

      expect(response.status).toBe(401)
    })

    it('rechaza con 401 un esquema distinto de Bearer', async () => {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Basic token-admin')

      expect(response.status).toBe(401)
    })

    it('un administrador con periodo invalido recibe 400 INVALID_PERIOD', async () => {
      const response = await request(app.getHttpServer())
        .get(`${path}?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z`)
        .set('Authorization', 'Bearer token-admin')

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        statusCode: 400,
        code: 'INVALID_PERIOD',
        message: expect.any(String) as string,
      })
    })

    it('un parametro no declarado se rechaza con 400 (forbidNonWhitelisted)', async () => {
      const response = await request(app.getHttpServer())
        .get(`${path}?playerId=otro`)
        .set('Authorization', 'Bearer token-admin')

      expect(response.status).toBe(400)
      expect(response.body.code).toBe('INVALID_REQUEST')
    })

    it('la autorizacion se evalua antes que la validacion: un jugador con periodo invalido recibe 403, no 400', async () => {
      const response = await request(app.getHttpServer())
        .get(`${path}?from=basura`)
        .set('Authorization', 'Bearer token-player')

      expect(response.status).toBe(403)
    })
  })

  it('granularity invalida y DAY sobre mas de 92 dias devuelven 400 INVALID_PARAMETER', async () => {
    const invalid = await request(app.getHttpServer())
      .get(`${TRENDS}?granularity=HOUR`)
      .set('Authorization', 'Bearer token-admin')
    const tooLong = await request(app.getHttpServer())
      .get(`${TRENDS}?from=2026-01-01T00:00:00Z&to=2026-04-30T00:00:00Z&granularity=DAY`)
      .set('Authorization', 'Bearer token-admin')

    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('INVALID_PARAMETER')
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.code).toBe('INVALID_PARAMETER')
  })

  it('devuelve la forma del contrato §4.1 con datos vacios', async () => {
    const response = await request(app.getHttpServer())
      .get(`${VOLUME}?from=2026-09-28T00:00:00Z&to=2026-10-04T00:00:00Z`)
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(200)
    expect(response.body.playerAuctions.successRate).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
      formula: '(withWinner + soldByBuyNow) / closed.total',
      excludes: ['CANCELLED', 'ACTIVE'],
    })
    expect(response.body.officialAuctions.successRate).toEqual({
      availability: 'UNAVAILABLE',
      reason: 'OFFICIAL_AUCTION_HAS_NO_CLOSING_FLOW',
    })
  })

  it('devuelve una serie continua con buckets WEEK (contrato §4.5)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${TRENDS}?from=2026-09-14T00:00:00Z&to=2026-10-04T00:00:00Z&granularity=WEEK`)
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(200)
    expect(response.body.granularity).toBe('WEEK')
    expect(response.body.trends.buckets.map((b: { bucketStart: string }) => b.bucketStart)).toEqual(
      ['2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z'],
    )
  })

  it('no captura la ruta el GET :auctionId de v1/auctions (R-12)', async () => {
    const response = await request(app.getHttpServer())
      .get(VOLUME)
      .set('Authorization', 'Bearer token-admin')

    expect(response.body.playerAuctions).toBeDefined()
  })
})

describe('HTTP metricas de Subasta HU-91.2 con AUTH_MODE=disabled', () => {
  let app: INestApplication
  const previousEnv = { ...process.env }

  beforeAll(async () => {
    app = await createApp({ AUTH_MODE: 'disabled' })
  })

  afterAll(async () => {
    await app.close()
    process.env = previousEnv
  })

  it.each([VOLUME, TRENDS])(
    'responde 401 en %s aunque la identidad anonima tenga todos los roles (@AuthenticationRequired)',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path)

      expect(response.status).toBe(401)
      expect(JSON.stringify(response.body)).not.toContain('playerAuctions')
    },
  )
})
