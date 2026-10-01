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
import type { ActiveAuctionList } from '../../src/application/ports/AuctionRepositoryPort'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { ListActiveAuctions } from '../../src/application/use-cases/ListActiveAuctions'
import { FakeCatalogProductLookup } from '../support/fake-catalog-product-lookup'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  player: { subject: 'player-1', email: null, roles: new Set([Role.Player]) },
  admin: { subject: 'admin-1', email: null, roles: new Set([Role.Administrator]) },
  gameMaster: { subject: 'upb-company', email: null, roles: new Set([Role.GameMaster]) },
}
const verifier: TokenVerifierPort = {
  verify: (token) =>
    identities[token] === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identities[token]),
}
const page: ActiveAuctionList = {
  items: [
    {
      id: 'auction-1',
      sellerId: 'seller-1',
      publisherType: 'PLAYER' as const,
      productId: 'product-1',
      priceKind: 'CREDITS' as const,
      minimumBidCredits: 10,
      buyNowCredits: null,
      currency: null,
      minimumBidAmountMinor: null,
      buyNowAmountMinor: null,
      officialMark: null,
      status: 'ACTIVE' as const,
      publishedAt: new Date('2026-09-22T12:00:00.000Z'),
      closesAt: new Date('2026-09-24T12:00:00.000Z'),
      currentBidAmount: 20,
      bidCount: 3,
    },
    {
      id: 'auction-2',
      sellerId: 'seller-2',
      publisherType: 'PLAYER' as const,
      productId: 'product-2',
      priceKind: 'CREDITS' as const,
      minimumBidCredits: 10,
      buyNowCredits: null,
      currency: null,
      minimumBidAmountMinor: null,
      buyNowAmountMinor: null,
      officialMark: null,
      status: 'ACTIVE' as const,
      publishedAt: new Date('2026-09-22T12:00:00.000Z'),
      closesAt: new Date('2026-09-25T12:00:00.000Z'),
      currentBidAmount: null,
      bidCount: 0,
    },
  ],
  total: 2,
}
/*
 * Caso de uso real (sin IO: solo valida y delega) sobre un repositorio fijo.
 * Asi el 400 PRICE_SORT_REQUIRES_CREDITS se prueba por HTTP sin duplicar la
 * regla en el stub; la semantica de filtros y orden se prueba en unit y DB.
 */
const useCase = new ListActiveAuctions(
  { listActive: () => Promise.resolve(page), listActiveProductIds: () => Promise.resolve([]) },
  { now: () => new Date('2026-09-23T12:00:00.000Z') },
  new FakeCatalogProductLookup(),
)
const list = {
  execute: jest.fn((input: Parameters<ListActiveAuctions['execute']>[0]) => useCase.execute(input)),
}
const NO_FILTERS = { publisherType: undefined, priceKind: undefined, hasBuyNow: undefined }

describe('GET /v1/auctions marketplace', () => {
  let app: INestApplication
  const saved = { ...process.env }

  beforeAll(async () => {
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'pool',
      COGNITO_CLIENT_ID: 'client',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret',
      GAME_MASTER_SUBJECT: 'upb-company',
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
      total: 2,
      items: [
        { id: 'auction-1', currentBidAmount: 20, bidCount: 3 },
        { id: 'auction-2', currentBidAmount: null, bidCount: 0 },
      ],
    })
    expect(response.body.items[0]).not.toHaveProperty('bidderId')
    expect(list.execute).toHaveBeenCalledWith({
      page: 1,
      pageSize: 16,
      filters: NO_FILTERS,
      sort: undefined,
    })
  })

  it('acepta paginacion y rechaza autenticacion, rol y query invalidos', async () => {
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions?page=2&pageSize=100')
        .set('Authorization', 'Bearer player'),
    ).resolves.toMatchObject({ status: 200 })
    expect(list.execute).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 100,
      filters: NO_FILTERS,
      sort: undefined,
    })
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions')
        .set('Authorization', 'Bearer gameMaster'),
    ).resolves.toMatchObject({ status: 200 })
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

  describe('filtros y orden', () => {
    const get = (query: string) =>
      request(app.getHttpServer())
        .get(`/api/v1/auctions${query}`)
        .set('Authorization', 'Bearer player')

    it('entrega filtros y orden tipados al caso de uso', async () => {
      const response = await get(
        '?publisherType=PLAYER&priceKind=CREDITS&hasBuyNow=true&sort=priceAsc&page=2&pageSize=8',
      )

      expect(response.status).toBe(200)
      expect(list.execute).toHaveBeenLastCalledWith({
        page: 2,
        pageSize: 8,
        filters: { publisherType: 'PLAYER', priceKind: 'CREDITS', hasBuyNow: true },
        sort: 'priceAsc',
      })
    })

    it('hasBuyNow=false llega como false, no como texto verdadero', async () => {
      await expect(get('?hasBuyNow=false&sort=mostBids')).resolves.toMatchObject({ status: 200 })

      const [input] = list.execute.mock.lastCall ?? []
      expect(input?.filters?.hasBuyNow).toBe(false)
      expect(input?.sort).toBe('mostBids')
    })

    it('acepta search, lo recorta y conserva filtros y sort', async () => {
      await expect(
        get('?search=%20espada%20&publisherType=PLAYER&priceKind=CREDITS&sort=priceAsc'),
      ).resolves.toMatchObject({ status: 200 })
      expect(list.execute).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 16,
        filters: { publisherType: 'PLAYER', priceKind: 'CREDITS', hasBuyNow: undefined },
        sort: 'priceAsc',
        search: 'espada',
      })
    })

    it('acepta la longitud maxima de search', async () => {
      await expect(get(`?search=${'a'.repeat(80)}`)).resolves.toMatchObject({ status: 200 })
    })

    it.each(['?search=', '?search=%20%20%20', `?search=${'a'.repeat(81)}`, '?search=x&search=y'])(
      '%s responde 400 sin llegar al caso de uso',
      async (query) => {
        const response = await get(query)
        expect(response.status).toBe(400)
        expect(list.execute).not.toHaveBeenCalled()
      },
    )

    it.each([
      '?sort=closingSoon',
      '?sort=newest',
      '?sort=mostBids',
      '?sort=priceAsc&priceKind=CREDITS',
      '?sort=priceDesc&priceKind=CREDITS',
    ])('%s responde 200', async (query) => {
      await expect(get(query)).resolves.toMatchObject({ status: 200 })
    })

    it.each([
      ['?sort=priceAsc'],
      ['?sort=priceDesc'],
      ['?sort=priceAsc&priceKind=REAL_MONEY'],
      ['?sort=priceDesc&priceKind=REAL_MONEY'],
      // PLAYER implica creditos en el modelo, pero la regla exige priceKind explicito.
      ['?sort=priceDesc&publisherType=PLAYER'],
    ])('%s sin priceKind=CREDITS responde 400 PRICE_SORT_REQUIRES_CREDITS', async (query) => {
      const response = await get(query)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ statusCode: 400, code: 'PRICE_SORT_REQUIRES_CREDITS' })
    })

    it.each([
      ['?publisherType=ADMIN', 'publisherType'],
      ['?publisherType=player', 'publisherType'],
      ['?priceKind=GOLD', 'priceKind'],
      ['?hasBuyNow=yes', 'hasBuyNow'],
      ['?hasBuyNow=1', 'hasBuyNow'],
      ['?hasBuyNow=FALSE', 'hasBuyNow'],
      ['?hasBuyNow=', 'hasBuyNow'],
      ['?hasBuyNow=random', 'hasBuyNow'],
      ['?hasBuyNow=true&hasBuyNow=false', 'hasBuyNow'],
      ['?sort=price', 'sort'],
      ['?sort=priceasc', 'sort'],
      ['?sort=closes_at%20desc', 'sort'],
      ['?sort=newest&sort=mostBids', 'sort'],
    ])('%s responde 400 sin llegar al caso de uso', async (query, field) => {
      const response = await get(query)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        code: 'INVALID_REQUEST',
        errors: [expect.objectContaining({ field })],
      })
      expect(list.execute).not.toHaveBeenCalled()
    })

    it('cualquier otro fallo del listado se propaga como antes (500), no como 503', async () => {
      list.execute.mockRejectedValueOnce(new Error('base de datos caida'))

      await expect(get('')).resolves.toMatchObject({ status: 500 })
    })

    it('traduce la indisponibilidad de Catalog a 503', async () => {
      list.execute.mockRejectedValueOnce(new ExternalDependencyUnavailableError('catalog'))

      const response = await get('?search=espada')
      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
    })
  })
})
