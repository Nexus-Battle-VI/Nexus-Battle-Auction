import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import request from 'supertest'
import { AppModule, APP_CONFIG, DATABASE } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import {
  TOKEN_VERIFIER,
  Role,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK } from '../../src/application/ports/ClockPort'
import { AUCTION_REPOSITORY } from '../../src/application/ports/AuctionRepositoryPort'
import { WATCHLIST_REPOSITORY } from '../../src/application/ports/WatchlistRepositoryPort'
import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryWatchlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWatchlistRepository'
import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { watchlistAuction } from '../support/watchlist-auction'

const path = '/api/v1/auctions/watchlist'

/** Nest/Supertest con guards reales; solo se sustituye el proveedor JWT externo y los puertos. */
describe('TASK 68.2 API watchlist', () => {
  let app: INestApplication
  let auctions: InMemoryAuctionRepository
  let watchlist: InMemoryWatchlistRepository
  let now: Date
  const verifier: TokenVerifierPort = {
    verify: (token) =>
      ['player-1', 'player-2', 'admin'].includes(token)
        ? Promise.resolve({
            subject: token,
            email: null,
            roles: new Set([token === 'admin' ? Role.Administrator : Role.Player]),
          })
        : Promise.reject(new TokenVerificationError()),
  }
  /** Levanta el AppModule de produccion con puertos controlados y validacion global. */
  const setup = async (authMode = 'jwt'): Promise<INestApplication> => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(
        loadConfig({
          NODE_ENV: 'test',
          AUTH_MODE: authMode,
          COGNITO_USER_POOL_ID: 'us-east-1_Test',
          COGNITO_CLIENT_ID: 'test-client',
        }),
      )
      .overrideProvider(DATABASE)
      .useValue(null)
      .overrideProvider(AUCTION_REPOSITORY)
      .useValue(auctions)
      .overrideProvider(WATCHLIST_REPOSITORY)
      .useValue(watchlist)
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(CLOCK)
      .useValue({ now: () => new Date(now) })
      .compile()
    const instance = module.createNestApplication({ logger: false })
    instance.setGlobalPrefix('api')
    instance.useGlobalPipes(createValidationPipe())
    await instance.init()
    return instance
  }
  beforeEach(async () => {
    now = new Date('2026-09-21T12:00:00Z')
    auctions = new InMemoryAuctionRepository()
    await auctions.publish(watchlistAuction('auction-1'))
    watchlist = new InMemoryWatchlistRepository(auctions)
    app = await setup()
  })
  afterEach(async () => {
    await app.close()
  })

  it('recorre alta, listado enriquecido, aislamiento y baja idempotente', async () => {
    const api = request(app.getHttpServer())
    const created = await api
      .post(path)
      .auth('player-1', { type: 'bearer' })
      .send({ auctionId: 'auction-1' })
      .expect(201)
    expect(created.body).toEqual({ auctionId: 'auction-1', followedAt: now.toISOString() })
    const own = await api.get(path).auth('player-1', { type: 'bearer' }).expect(200)
    expect(own.body.items).toHaveLength(1)
    expect(own.body.items[0]).toMatchObject({
      auctionId: 'auction-1',
      auction: { productId: 'product-auction-1', status: 'ACTIVE' },
    })
    expect(JSON.stringify(own.body)).not.toContain('feeChargeId')
    await api.get(path).auth('player-2', { type: 'bearer' }).expect(200, { items: [] })
    await api.delete(`${path}/auction-1`).auth('player-2', { type: 'bearer' }).expect(204)
    expect(await watchlist.find('player-1', 'auction-1')).not.toBeNull()
    await api.delete(`${path}/auction-1`).auth('player-1', { type: 'bearer' }).expect(204, '')
    await api.delete(`${path}/auction-1`).auth('player-1', { type: 'bearer' }).expect(204)
    await api.get(path).auth('player-1', { type: 'bearer' }).expect(200, { items: [] })
  })
  it.each(['get', 'post', 'delete'] as const)(
    'rechaza %s sin token o con token invalido',
    async (method) => {
      const url = method === 'delete' ? `${path}/auction-1` : path
      await request(app.getHttpServer())[method](url).expect(401)
      await request(app.getHttpServer())
        [method](url)
        .auth('invalid', { type: 'bearer' })
        .expect(401)
    },
  )
  it.each(['get', 'post', 'delete'] as const)('rechaza %s sin rol PLAYER', async (method) => {
    await request(app.getHttpServer())
      [method](method === 'delete' ? `${path}/auction-1` : path)
      .auth('admin', { type: 'bearer' })
      .expect(403)
  })
  it.each([
    {},
    { auctionId: 123 },
    { auctionId: '' },
    { auctionId: ' a ' },
    { auctionId: 'bad/id' },
    { auctionId: 'x'.repeat(129) },
    { auctionId: 'auction-1', playerId: 'player-2' },
  ])('rechaza cuerpo fuera del contrato %p', async (body) => {
    const result = await request(app.getHttpServer())
      .post(path)
      .auth('player-1', { type: 'bearer' })
      .send(body)
      .expect(400)
    expect(result.body.code).toBe('INVALID_REQUEST')
    expect(await watchlist.listByPlayer('player-1')).toEqual([])
    expect(await watchlist.listByPlayer('player-2')).toEqual([])
  })
  it.each(['get', 'post', 'delete'] as const)(
    'rechaza selector playerId en query para %s',
    async (method) => {
      const url = method === 'delete' ? `${path}/auction-1` : path
      const call = request(app.getHttpServer())
        [method](url)
        .query({ playerId: 'player-2' })
        .auth('player-1', { type: 'bearer' })
      if (method === 'post') call.send({ auctionId: 'auction-1' })
      await call.expect(400)
    },
  )
  it('rechaza identidad en cuerpo DELETE y path invalido', async () => {
    await request(app.getHttpServer())
      .delete(`${path}/auction-1`)
      .auth('player-1', { type: 'bearer' })
      .send({ playerId: 'player-2' })
      .expect(400)
    await request(app.getHttpServer())
      .delete(`${path}/bad%20id`)
      .auth('player-1', { type: 'bearer' })
      .expect(400)
  })
  it('devuelve 404 al seguir una subasta inexistente', async () => {
    const result = await request(app.getHttpServer())
      .post(path)
      .auth('player-1', { type: 'bearer' })
      .send({ auctionId: 'missing' })
      .expect(404)
    expect(result.body.code).toBe('AUCTION_NOT_FOUND')
  })
  it('devuelve 422 en el instante exacto de cierre', async () => {
    now = (await auctions.findById('auction-1'))!.closesAt
    const result = await request(app.getHttpServer())
      .post(path)
      .auth('player-1', { type: 'bearer' })
      .send({ auctionId: 'auction-1' })
      .expect(422)
    expect(result.body.code).toBe('AUCTION_NOT_FOLLOWABLE')
  })
  it('devuelve un alta y un conflicto ante solicitudes concurrentes', async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post(path)
          .auth('player-1', { type: 'bearer' })
          .send({ auctionId: 'auction-1' }),
      ),
    )
    expect(results.map((result) => result.status).sort()).toEqual([201, 409])
    expect(results.find((result) => result.status === 409)!.body.code).toBe(
      'WATCHLIST_ALREADY_EXISTS',
    )
  })
  it.each(['create', 'listByPlayer', 'delete'] as const)(
    'no filtra errores internos de %s',
    async (operation) => {
      jest.spyOn(watchlist, operation).mockRejectedValue(new Error('postgres password=private'))
      const api = request(app.getHttpServer())
      const call =
        operation === 'create'
          ? api.post(path).send({ auctionId: 'auction-1' })
          : operation === 'delete'
            ? api.delete(`${path}/auction-1`)
            : api.get(path)
      const result = await call.auth('player-1', { type: 'bearer' }).expect(503)
      expect(result.body.code).toBe('WATCHLIST_UNAVAILABLE')
      expect(JSON.stringify(result.body)).not.toContain('private')
    },
  )
  it('no permite watchlist anonima aunque AUTH_MODE sea disabled', async () => {
    const disabled = await setup('disabled')
    try {
      await request(disabled.getHttpServer()).get(path).expect(401)
      await request(disabled.getHttpServer())
        .post(path)
        .send({ auctionId: 'auction-1' })
        .expect(401)
      await request(disabled.getHttpServer()).delete(`${path}/auction-1`).expect(401)
    } finally {
      await disabled.close()
    }
  })
  it('documenta operaciones, bearerAuth, DTO y errores en OpenAPI', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    )
    expect(document.paths[path]?.post).toMatchObject({ security: [{ bearer: [] }] })
    expect(document.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
    expect(Object.keys(document.paths[path]!.post!.responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
      '422',
      '503',
    ])
    expect(document.paths[path]?.get?.responses).toHaveProperty('200')
    expect(document.paths[`${path}/{auctionId}`]?.delete?.responses).toHaveProperty('204')
    expect(document.components?.schemas).toHaveProperty('FollowAuctionRequestDto')
    expect(document.components?.schemas).toHaveProperty('FollowedAuctionsResponseDto')
  })
})
