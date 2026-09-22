import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import request from 'supertest'

import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { GetAuctionDetail } from '../../src/application/use-cases/GetAuctionDetail'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const auction = {
  id: 'auction-web',

  sellerId: 'seller-1',

  productId: 'product-1',

  durationHours: 24 as const,

  publicationFeeCredits: 1,

  minimumBidCredits: 10,

  buyNowCredits: null,

  status: 'ACTIVE' as const,

  publishedAt: new Date('2026-09-22T12:00:00.000Z'),

  closesAt: new Date('2026-09-23T12:00:00.000Z'),
}

const currentBid = {
  id: 'bid-web',

  auctionId: auction.id,

  bidderId: 'player-leading',

  amountCredits: 50,

  placedAt: new Date('2026-09-22T12:10:00.000Z'),
}

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

const getAuctionDetailStub = {
  execute: jest.fn((auctionId: string) => {
    if (auctionId === 'auction-missing') {
      return Promise.resolve(null)
    }

    if (auctionId === 'auction-empty') {
      return Promise.resolve({
        auction: {
          ...auction,

          id: auctionId,
        },

        currentBid: null,
      })
    }

    return Promise.resolve({
      auction: {
        ...auction,

        id: auctionId,
      },

      currentBid: {
        ...currentBid,

        auctionId,
      },
    })
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

describe('GET detalle de subasta HU-63.6', () => {
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
      .overrideProvider(GetAuctionDetail)
      .useValue(getAuctionDetailStub)
      .compile()

    app = moduleRef.createNestApplication()

    app.setGlobalPrefix('api')

    await app.init()
  })

  afterAll(async () => {
    await app.close()

    restore()
  })

  beforeEach(() => {
    getAuctionDetailStub.execute.mockClear()
  })

  it('responde 200 con oferta actual e incremento minimo', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-web')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(200)

    expect(response.body).toMatchObject({
      id: 'auction-web',

      minimumBidCredits: 10,

      status: 'ACTIVE',

      currentBid: {
        id: 'bid-web',

        bidderId: 'player-leading',

        amountCredits: 50,
      },
    })

    expect(getAuctionDetailStub.execute).toHaveBeenCalledWith('auction-web')
  })

  it('devuelve currentBid null cuando nadie ha pujado', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-empty')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(200)

    expect(response.body.currentBid).toBeNull()
  })

  it('responde 404 cuando la subasta no existe', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-missing')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(404)

    expect(response.body).toMatchObject({
      statusCode: 404,

      code: 'AUCTION_NOT_FOUND',
    })
  })

  it('responde 401 sin autenticacion', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/auctions/auction-web')

    expect(response.status).toBe(401)

    expect(getAuctionDetailStub.execute).not.toHaveBeenCalled()
  })

  it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/auction-web')
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(403)

    expect(getAuctionDetailStub.execute).not.toHaveBeenCalled()
  })

  it('publica el contrato GET en OpenAPI', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    )

    const operation = document.paths['/api/v1/auctions/{auctionId}']?.get

    expect(operation).toBeDefined()

    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'auctionId',

          in: 'path',

          required: true,
        }),
      ]),
    )

    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '403', '404']),
    )
  })
})
