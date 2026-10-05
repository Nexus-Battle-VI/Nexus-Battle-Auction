import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { GetAuctionBidHistory } from '../../src/application/use-cases/GetAuctionBidHistory'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'

const items = [
  { id: 'bid-1', amountCredits: 10, placedAt: new Date('2026-09-22T12:00:10.000Z') },
  { id: 'bid-2', amountCredits: 20, placedAt: new Date('2026-09-22T12:00:20.000Z') },
]

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  'token-player': {
    subject: 'player-1',
    email: null,
    roles: new Set([Role.Player]),
  },
  'token-admin': {
    subject: 'admin-1',
    email: null,
    roles: new Set([Role.Administrator]),
  },
}

const verifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = identities[token]
    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const getAuctionBidHistoryStub = {
  execute: jest.fn((query: { auctionId: string; page: number; pageSize: number }) => {
    if (query.auctionId === 'auction-missing') {
      return Promise.resolve(null)
    }

    if (query.auctionId === 'auction-empty-history') {
      return Promise.resolve({ items: [], total: 0 })
    }

    return Promise.resolve({ items, total: items.length })
  }),
}

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('GET historial de pujas de una subasta HU-88', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
      PERSISTENCE_DRIVER: 'memory',
    })

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(GetAuctionBidHistory)
      .useValue(getAuctionBidHistoryStub)
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  beforeEach(() => {
    getAuctionBidHistoryStub.execute.mockClear()
  })

  it('responde 200 con multiples items, total y page/pageSize por defecto', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      items: [
        { id: 'bid-1', amountCredits: 10 },
        { id: 'bid-2', amountCredits: 20 },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    })
    expect(getAuctionBidHistoryStub.execute).toHaveBeenCalledWith({
      auctionId: 'auction-with-bids',
      page: 1,
      pageSize: 20,
    })
  })

  it('la respuesta nunca incluye bidderId', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids')
      .set('Authorization', 'Bearer token-player')

    for (const item of response.body.items) {
      expect(item).not.toHaveProperty('bidderId')
    }
  })

  it('subasta existente sin pujas: 200 con items vacio y total 0', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-empty-history/bids')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 })
  })

  it('respeta page y pageSize explicitos', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids?page=2&pageSize=5')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ page: 2, pageSize: 5 })
    expect(getAuctionBidHistoryStub.execute).toHaveBeenCalledWith({
      auctionId: 'auction-with-bids',
      page: 2,
      pageSize: 5,
    })
  })

  it('subasta inexistente: 404 AUCTION_NOT_FOUND', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-missing/bids')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ statusCode: 404, code: 'AUCTION_NOT_FOUND' })
  })

  it('page invalido responde 400 sin llegar al caso de uso', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids?page=0')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(400)
    expect(getAuctionBidHistoryStub.execute).not.toHaveBeenCalled()
  })

  it('pageSize invalido (fuera de 1-100) responde 400 sin llegar al caso de uso', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids?pageSize=101')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(400)
    expect(getAuctionBidHistoryStub.execute).not.toHaveBeenCalled()
  })

  it('un parametro desconocido responde 400 (forbidNonWhitelisted)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids?unknown=1')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(400)
    expect(getAuctionBidHistoryStub.execute).not.toHaveBeenCalled()
  })

  it('responde 401 sin autenticacion', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/auctions/auction-with-bids/bids',
    )

    expect(response.status).toBe(401)
    expect(getAuctionBidHistoryStub.execute).not.toHaveBeenCalled()
  })

  it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-with-bids/bids')
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(403)
    expect(getAuctionBidHistoryStub.execute).not.toHaveBeenCalled()
  })
})
