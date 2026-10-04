import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { GetMyAuctionActivity } from '../../src/application/use-cases/GetMyAuctionActivity'
import { GetMyAuctionTransactions } from '../../src/application/use-cases/GetMyAuctionTransactions'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  'token-a': { subject: 'player-a', email: null, roles: new Set([Role.Player]) },
  'token-b': { subject: 'player-b', email: null, roles: new Set([Role.Player]) },
  'token-admin': { subject: 'admin', email: null, roles: new Set([Role.Administrator]) },
}
const verifier: TokenVerifierPort = {
  verify: (token) => {
    const identity = identities[token]
    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}
const activity = {
  listOwned: jest.fn(({ playerId }: { playerId: string }) =>
    Promise.resolve({ items: [{ auctionId: `owned-${playerId}` }], total: 1 }),
  ),
  listBids: jest.fn(({ playerId }: { playerId: string }) =>
    Promise.resolve({ items: [{ auctionId: `bid-${playerId}` }], total: 1 }),
  ),
}
const transactions = {
  execute: jest.fn(({ playerId }: { playerId: string }) =>
    Promise.resolve({ items: [{ id: `transaction-${playerId}` }], total: 1 }),
  ),
}

describe('HTTP actividad personal HU-89', () => {
  let app: INestApplication
  const previousEnv = { ...process.env }

  beforeAll(async () => {
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
      PERSISTENCE_DRIVER: 'memory',
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(GetMyAuctionActivity)
      .useValue(activity)
      .overrideProvider(GetMyAuctionTransactions)
      .useValue(transactions)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    process.env = previousEnv
  })

  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['/api/v1/auctions/me/owned', activity.listOwned, 'owned-player-a'],
    ['/api/v1/auctions/me/bids', activity.listBids, 'bid-player-a'],
    ['/api/v1/auctions/me/transactions', transactions.execute, 'transaction-player-a'],
  ] as const)('aísla %s con el subject del JWT', async (path, handler, expectedId) => {
    const response = await request(app.getHttpServer())
      .get(`${path}?page=2&pageSize=5`)
      .set('Authorization', 'Bearer token-a')

    expect(response.status).toBe(200)
    expect(response.body.items[0]).toEqual(
      expect.objectContaining({
        [expectedId.startsWith('transaction') ? 'id' : 'auctionId']: expectedId,
      }),
    )
    expect(handler).toHaveBeenCalledWith({ playerId: 'player-a', page: 2, pageSize: 5 })
  })

  it('rechaza un userId arbitrario en vez de permitir cambiar el propietario', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/me/owned?playerId=player-b')
      .set('Authorization', 'Bearer token-a')
    expect(response.status).toBe(400)
    expect(activity.listOwned).not.toHaveBeenCalled()
  })

  it.each(['/me/owned', '/me/bids', '/me/transactions', '/me/view-statistics'])(
    'rechaza sin autenticacion %s',
    async (path) => {
      expect((await request(app.getHttpServer()).get(`/api/v1/auctions${path}`)).status).toBe(401)
    },
  )

  it('rechaza roles ajenos a PLAYER', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/me/owned')
      .set('Authorization', 'Bearer token-admin')
    expect(response.status).toBe(403)
  })

  it('declara las visualizaciones como no disponibles sin contador cero', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/me/view-statistics')
      .set('Authorization', 'Bearer token-b')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      availability: 'UNAVAILABLE',
      reason: 'AUTHORITATIVE_SOURCE_NOT_CONFIGURED',
      metrics: [],
    })
  })

  it('publica los cuatro contratos privados en OpenAPI', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    )
    for (const path of ['owned', 'bids', 'transactions', 'view-statistics']) {
      const operation = document.paths[`/api/v1/auctions/me/${path}`]?.get
      expect(operation).toBeDefined()
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '401', '403']),
      )
    }
  })
})
