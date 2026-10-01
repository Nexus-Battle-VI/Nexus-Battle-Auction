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
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import type { CatalogProductSuggestion } from '../../src/application/ports/CatalogProductLookupPort'
import { GetAuctionDetail } from '../../src/application/use-cases/GetAuctionDetail'
import { GetAuctionSuggestions } from '../../src/application/use-cases/GetAuctionSuggestions'
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

/*
 * Caso de uso real (sin IO) sobre un repositorio y un Catalog fijos, igual
 * que el HTTP de /v1/auctions: el 400 de validacion se prueba por HTTP sin
 * duplicar reglas en el stub; la semantica del universo y de Catalog se
 * prueba en unit y DB.
 */
const buildUseCase = (suggestions: readonly CatalogProductSuggestion[] = []) => {
  const catalog = new FakeCatalogProductLookup()
  catalog.suggestions = suggestions
  return new GetAuctionSuggestions(
    { listActiveProductIds: () => Promise.resolve(['product-1', 'product-2']) },
    { now: () => new Date('2026-09-23T12:00:00.000Z') },
    catalog,
  )
}

const useCase = buildUseCase([{ productId: 'product-1', name: 'Dragon de fuego', type: 'EPICA' }])
const suggestions = {
  execute: jest.fn((input: Parameters<GetAuctionSuggestions['execute']>[0]) =>
    useCase.execute(input),
  ),
}
const detail = { execute: jest.fn().mockResolvedValue(null) }

describe('GET /v1/auctions/suggestions', () => {
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
      .overrideProvider(GetAuctionSuggestions)
      .useValue(suggestions)
      .overrideProvider(GetAuctionDetail)
      .useValue(detail)
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

  beforeEach(() => {
    suggestions.execute.mockClear()
    detail.execute.mockClear()
  })

  const get = (query: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/auctions/suggestions${query}`)
      .set('Authorization', 'Bearer player')

  it('200 con q valido: aplica el default de limit y no confunde la ruta con el detalle', async () => {
    const response = await get('?q=dragon')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [{ productId: 'product-1', name: 'Dragon de fuego', type: 'EPICA' }],
    })
    expect(suggestions.execute).toHaveBeenCalledWith({
      q: 'dragon',
      limit: 8,
      filters: { publisherType: undefined, priceKind: undefined, hasBuyNow: undefined },
    })
    expect(detail.execute).not.toHaveBeenCalled()
  })

  it('recorta q y conserva filtros', async () => {
    await expect(
      get('?q=%20dragon%20&publisherType=PLAYER&priceKind=CREDITS&hasBuyNow=true&limit=5'),
    ).resolves.toMatchObject({ status: 200 })

    expect(suggestions.execute).toHaveBeenLastCalledWith({
      q: 'dragon',
      limit: 5,
      filters: { publisherType: 'PLAYER', priceKind: 'CREDITS', hasBuyNow: true },
    })
  })

  it('q obligatorio: ausente responde 400 sin llegar al caso de uso', async () => {
    const response = await get('')

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      code: 'INVALID_REQUEST',
      errors: [expect.objectContaining({ field: 'q' })],
    })
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it.each(['?q=ab', `?q=${'a'.repeat(2)}`])(
    'q de menos de 3 caracteres responde 400 (%s)',
    async (query) => {
      const response = await get(query)

      expect(response.status).toBe(400)
      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'q' })])
      expect(suggestions.execute).not.toHaveBeenCalled()
    },
  )

  it('q de mas de 80 caracteres responde 400', async () => {
    const response = await get(`?q=${'a'.repeat(81)}`)

    expect(response.status).toBe(400)
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it('q recortado a menos de 3 caracteres responde 400', async () => {
    const response = await get('?q=%20ab%20')

    expect(response.status).toBe(400)
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it('acepta la longitud maxima de q (80)', async () => {
    await expect(get(`?q=${'a'.repeat(80)}`)).resolves.toMatchObject({ status: 200 })
  })

  it.each([
    ['?q=dragon&limit=0', 'limit'],
    ['?q=dragon&limit=21', 'limit'],
    ['?q=dragon&limit=abc', 'limit'],
  ])('limit fuera de rango responde 400 (%s)', async (query) => {
    const response = await get(query)

    expect(response.status).toBe(400)
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'limit' })])
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it('acepta un limit personalizado dentro de rango', async () => {
    await get('?q=dragon&limit=20')
    expect(suggestions.execute).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }))
  })

  it.each([
    ['?q=dragon&publisherType=ADMIN', 'publisherType'],
    ['?q=dragon&priceKind=GOLD', 'priceKind'],
    ['?q=dragon&hasBuyNow=yes', 'hasBuyNow'],
  ])('filtro invalido responde 400 (%s)', async (query, field) => {
    const response = await get(query)

    expect(response.status).toBe(400)
    expect(response.body.errors).toEqual([expect.objectContaining({ field })])
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it('parametro desconocido responde 400 (forbidNonWhitelisted)', async () => {
    const response = await get('?q=dragon&sort=priceAsc')

    expect(response.status).toBe(400)
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it('no acepta page/pageSize: son desconocidos para este endpoint', async () => {
    const response = await get('?q=dragon&page=2&pageSize=10')

    expect(response.status).toBe(400)
    expect(suggestions.execute).not.toHaveBeenCalled()
  })

  it('cero resultados responde 200 con items: []', async () => {
    suggestions.execute.mockResolvedValueOnce({ items: [] })

    const response = await get('?q=inexistente')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ items: [] })
  })

  it('Catalog caido responde 503 DEPENDENCY_UNAVAILABLE', async () => {
    suggestions.execute.mockRejectedValueOnce(new ExternalDependencyUnavailableError('catalog'))

    const response = await get('?q=dragon')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
  })

  it('cualquier otro fallo se propaga como 500', async () => {
    suggestions.execute.mockRejectedValueOnce(new Error('base de datos caida'))

    await expect(get('?q=dragon')).resolves.toMatchObject({ status: 500 })
  })

  it('exige autenticacion y rol', async () => {
    await expect(
      request(app.getHttpServer()).get('/api/v1/auctions/suggestions?q=dragon'),
    ).resolves.toMatchObject({ status: 401 })
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions/suggestions?q=dragon')
        .set('Authorization', 'Bearer admin'),
    ).resolves.toMatchObject({ status: 403 })
    await expect(
      request(app.getHttpServer())
        .get('/api/v1/auctions/suggestions?q=dragon')
        .set('Authorization', 'Bearer gameMaster'),
    ).resolves.toMatchObject({ status: 200 })
  })

  it('"suggestions" no colisiona con GET /v1/auctions/:auctionId', async () => {
    await get('?q=dragon')

    expect(detail.execute).not.toHaveBeenCalled()
    expect(suggestions.execute).toHaveBeenCalled()
  })
})
