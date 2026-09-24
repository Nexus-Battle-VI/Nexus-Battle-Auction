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
import { ListActiveAuctions } from '../../src/application/use-cases/ListActiveAuctions'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  player: { subject: 'player-1', email: null, roles: new Set([Role.Player]) },
  admin: { subject: 'admin-1', email: null, roles: new Set([Role.Administrator]) },
}
const verifier: TokenVerifierPort = {
  verify: (token) =>
    identities[token] === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identities[token]),
}
const list = {
  execute: jest.fn(() =>
    Promise.resolve({
      items: [
        {
          id: 'auction-1',
          sellerId: 'seller-1',
          productId: 'product-1',
          minimumBidCredits: 10,
          buyNowCredits: null,
          status: 'ACTIVE' as const,
          publishedAt: new Date('2026-09-22T12:00:00.000Z'),
          closesAt: new Date('2026-09-24T12:00:00.000Z'),
          currentBidAmount: 20,
        },
      ],
      total: 1,
    }),
  ),
}

describe('GET /v1/auctions marketplace', () => {
  let app: INestApplication
  const saved = { ...process.env }

  beforeAll(async () => {
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'pool',
      COGNITO_CLIENT_ID: 'client',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret',
      PERSISTENCE_DRIVER: 'memory',
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(ListActiveAuctions)
      .useValue(list)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    for (const key of Object.keys(process.env))
      if (!(key in saved)) Reflect.deleteProperty(process.env, key)
    Object.assign(process.env, saved)
  })

  beforeEach(() => list.execute.mockClear())

  it('aplica defaults, serializa el summary y no confunde la ruta con el detalle', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions')
      .set('Authorization', 'Bearer player')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      page: 1,
      pageSize: 16,
      total: 1,
      items: [{ id: 'auction-1', currentBidAmount: 20 }],
    })
    expect(response.body.items[0]).not.toHaveProperty('bidderId')
    expect(list.execute).toHaveBeenCalledWith({ page: 1, pageSize: 16 })
  })

  it('acepta paginacion y rechaza autenticacion, rol y query invalidos', async () => {
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions?page=2&pageSize=100')
        .set('Authorization', 'Bearer player'),
    ).resolves.toMatchObject({ status: 200 })
    expect(list.execute).toHaveBeenLastCalledWith({ page: 2, pageSize: 100 })
    await expect(request(app.getHttpServer()).get('/api/v1/auctions')).resolves.toMatchObject({
      status: 401,
    })
    await expect(
      request(app.getHttpServer()).get('/api/v1/auctions').set('Authorization', 'Bearer admin'),
    ).resolves.toMatchObject({ status: 403 })
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions?page=0')
        .set('Authorization', 'Bearer player'),
    ).resolves.toMatchObject({ status: 400 })
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions?pageSize=101')
        .set('Authorization', 'Bearer player'),
    ).resolves.toMatchObject({ status: 400 })
  })
})
