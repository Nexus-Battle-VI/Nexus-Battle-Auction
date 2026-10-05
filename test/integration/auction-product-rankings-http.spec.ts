import 'reflect-metadata'

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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
}
const verifier: TokenVerifierPort = {
  verify: (token) => {
    const found = identities[token]
    return found === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(found)
  },
}

const PATH = '/api/v1/admin/auction-metrics/product-rankings'
const PERIOD = 'from=2026-09-28T00:00:00Z&to=2026-10-04T00:00:00Z'
const HOUR = 3_600_000
const at = (iso: string): Date => new Date(iso)

const seeded = (): InMemoryAuctionMetricsRepository => {
  const repository = new InMemoryAuctionMetricsRepository()
  const facts: MetricsAuctionFact[] = [
    ...[1, 2, 3].map((n): MetricsAuctionFact => ({
      id: `sold-${String(n)}`,
      productId: '11111111-1111-4111-8111-111111111111',
      priceKind: 'CREDITS',
      status: 'FINISHED',
      publishedAt: at('2026-09-28T10:00:00Z'),
      closesAt: at('2026-09-29T10:00:00Z'),
      finishedAt: at('2026-09-29T10:00:30Z'),
      closingResultType: 'WITH_WINNER',
    })),
    {
      id: 'now-1',
      productId: '22222222-2222-4222-8222-222222222222',
      priceKind: 'CREDITS',
      status: 'SOLD',
      publishedAt: at('2026-09-30T10:00:00Z'),
      closesAt: new Date(at('2026-09-30T10:00:00Z').getTime() + 2 * HOUR),
      buyNowCompletedAt: new Date(at('2026-09-30T10:00:00Z').getTime() + 2 * HOUR),
    },
    {
      id: 'official-1',
      productId: '33333333-3333-4333-8333-333333333333',
      priceKind: 'REAL_MONEY',
      status: 'ACTIVE',
      publishedAt: at('2026-10-01T10:00:00Z'),
      closesAt: at('2026-10-02T10:00:00Z'),
      officialMark: 'PREMIUM',
    },
  ]
  repository.seed(...facts)
  return repository
}

const CATALOG: Readonly<Record<string, Record<string, unknown>>> = {
  '11111111-1111-4111-8111-111111111111': {
    productId: '11111111-1111-4111-8111-111111111111',
    sku: 'espada-de-hierro',
    name: 'Espada de hierro',
    type: 'ARMA',
    imageUrl: 'https://cdn/espada.png',
    // Campos reales del DTO canonico que el ranking NO debe exponer.
    description: 'Una espada',
    creditsPrice: 100,
    premium: false,
    attributes: { attack: 3 },
  },
  '22222222-2222-4222-8222-222222222222': {
    productId: '22222222-2222-4222-8222-222222222222',
    sku: 'escudo-de-madera',
    name: 'Escudo de madera',
    type: 'ARMADURA',
    imageUrl: 'https://cdn/escudo.png',
    description: 'Un escudo',
  },
  '33333333-3333-4333-8333-333333333333': {
    productId: '33333333-3333-4333-8333-333333333333',
    sku: 'pocion',
    name: 'Pocion',
    type: 'ITEM',
    imageUrl: 'https://cdn/pocion.png',
  },
}

type CatalogMode = 'complete' | 'partial' | 'http-503' | 'reset' | 'broken-contract'

/** Catalog simulado: mismo contrato que `POST /api/v1/catalog/products/lookup`. */
class FakeCatalogServer {
  mode: CatalogMode = 'complete'
  readonly received: { method: string | undefined; url: string | undefined; body: unknown }[] = []
  private readonly server: Server = createServer((req, res) => {
    void this.handle(req).then((outcome) => {
      if (outcome === 'reset') {
        req.socket.destroy()
        return
      }
      res.writeHead(outcome.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(outcome.body))
    })
  })

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
  }

  private async handle(req: IncomingMessage): Promise<'reset' | { status: number; body: unknown }> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      references?: string[]
    }
    this.received.push({ method: req.method, url: req.url, body })

    if (this.mode === 'reset') return 'reset'
    if (this.mode === 'http-503') return { status: 503, body: { message: 'caido' } }

    const references = body.references ?? []
    const known = references.flatMap((reference) => {
      const hit = CATALOG[reference]
      return hit === undefined ? [] : [hit]
    })
    if (this.mode === 'broken-contract') {
      const withoutImage = known.map((hit) => {
        const copy = { ...hit }
        delete copy.imageUrl
        return copy
      })
      return { status: 200, body: { items: withoutImage } }
    }
    const items =
      this.mode === 'partial'
        ? known.filter((hit) => hit.productId !== '22222222-2222-4222-8222-222222222222')
        : known
    return { status: 200, body: { items } }
  }
}

const createApp = async (catalogBaseUrl: string): Promise<INestApplication> => {
  Object.assign(process.env, {
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
    COGNITO_CLIENT_ID: 'cliente-pruebas',
    INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
    PERSISTENCE_DRIVER: 'memory',
    CATALOG_BASE_URL: catalogBaseUrl,
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

describe('HTTP ranking de productos HU-91.3 con Catalog simulado por HTTP', () => {
  let app: INestApplication
  const catalog = new FakeCatalogServer()
  const previousEnv = { ...process.env }

  beforeAll(async () => {
    app = await createApp(await catalog.start())
  })

  afterAll(async () => {
    await app.close()
    await catalog.stop()
    process.env = previousEnv
  })

  beforeEach(() => {
    catalog.mode = 'complete'
    catalog.received.length = 0
  })

  const get = (query = PERIOD, token = 'token-admin') =>
    request(app.getHttpServer()).get(`${PATH}?${query}`).set('Authorization', `Bearer ${token}`)

  it('COMPLETE: devuelve la forma del contrato §4.2 con nombres reales de Catalog', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      definitionsVersion: 'hu-91.v1',
      limit: 10,
      enrichment: { source: 'catalog:POST /api/v1/catalog/products/lookup', status: 'COMPLETE' },
    })
    expect(response.body.mostAuctioned[0]).toEqual({
      rank: 1,
      productId: '11111111-1111-4111-8111-111111111111',
      product: {
        name: 'Espada de hierro',
        sku: 'espada-de-hierro',
        type: 'ARMA',
        imageUrl: 'https://cdn/espada.png',
      },
      auctions: { total: 3, playerCredits: 3, officialRealMoney: 0 },
    })
    expect(response.body.mostSold).toEqual([
      expect.objectContaining({
        rank: 1,
        productId: '11111111-1111-4111-8111-111111111111',
        sales: { total: 3, byAuctionClose: 3, byBuyNow: 0, unit: 'CREDITS' },
      }),
      expect.objectContaining({
        rank: 2,
        productId: '22222222-2222-4222-8222-222222222222',
        sales: { total: 1, byAuctionClose: 0, byBuyNow: 1, unit: 'CREDITS' },
      }),
    ])
    const official = response.body.mostAuctioned.find(
      (item: { productId: string }) => item.productId === '33333333-3333-4333-8333-333333333333',
    )
    expect(official.auctions).toEqual({ total: 1, playerCredits: 0, officialRealMoney: 1 })
  })

  it('consulta a Catalog con POST al lookup publico, una vez, sin query y con los productId unicos', async () => {
    await get()

    expect(catalog.received).toHaveLength(1)
    const [call] = catalog.received
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe('/api/v1/catalog/products/lookup')
    const body = call?.body as { references: string[]; query?: string }
    expect(body.query).toBeUndefined()
    expect([...body.references].sort()).toEqual(Object.keys(CATALOG).sort())
  })

  it('no expone ningun campo de Catalog fuera de name, sku, type e imageUrl (ni brand)', async () => {
    const response = await get()

    for (const item of [...response.body.mostAuctioned, ...response.body.mostSold]) {
      expect(Object.keys(item.product).sort()).toEqual(['imageUrl', 'name', 'sku', 'type'])
    }
    expect(JSON.stringify(response.body)).not.toMatch(/brand|description|creditsPrice|premium/)
  })

  it('PARTIAL: Catalog omite un productId -> product null solo en ese producto', async () => {
    catalog.mode = 'partial'

    const response = await get()

    expect(response.status).toBe(200)
    expect(response.body.enrichment.status).toBe('PARTIAL')
    const items = [...response.body.mostAuctioned, ...response.body.mostSold] as {
      productId: string
      product: unknown
    }[]
    for (const item of items) {
      if (item.productId === '22222222-2222-4222-8222-222222222222') {
        expect(item.product).toBeNull()
      } else {
        expect(item.product).not.toBeNull()
      }
    }
  })

  it.each<[string, CatalogMode]>([
    ['responde HTTP 503', 'http-503'],
    ['corta la conexion', 'reset'],
    ['rompe su contrato (sin imageUrl)', 'broken-contract'],
  ])(
    'UNAVAILABLE: Catalog %s -> 200, product null en todos y conteos intactos',
    async (_name, mode) => {
      catalog.mode = mode

      const response = await get()

      expect(response.status).toBe(200)
      expect(response.body.enrichment.status).toBe('UNAVAILABLE')
      for (const item of [...response.body.mostAuctioned, ...response.body.mostSold]) {
        expect(item.product).toBeNull()
      }
      expect(response.body.mostAuctioned[0].auctions.total).toBe(3)
      expect(response.body.mostSold[0].sales.total).toBe(3)
    },
  )

  it('limit recorta las listas', async () => {
    const response = await get(`${PERIOD}&limit=1`)

    expect(response.body.limit).toBe(1)
    expect(response.body.mostAuctioned).toHaveLength(1)
    expect(response.body.mostSold).toHaveLength(1)
  })

  it.each(['0', '51', 'abc', '1.5', '-3'])('limit=%s -> 400 INVALID_PARAMETER', async (limit) => {
    const response = await get(`${PERIOD}&limit=${limit}`)

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('INVALID_PARAMETER')
    expect(catalog.received).toHaveLength(0)
  })

  it('periodo invalido -> 400 INVALID_PERIOD sin consultar a Catalog', async () => {
    const response = await get('from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('INVALID_PERIOD')
    expect(catalog.received).toHaveLength(0)
  })

  describe('autorizacion (CA-06): misma regla que el resto del controlador', () => {
    it.each(['token-admin', 'token-super'])('permite %s', async (token) => {
      expect((await get(PERIOD, token)).status).toBe(200)
    })

    it.each(['token-player', 'token-moderator', 'token-game-master'])(
      'rechaza con 403 a %s sin datos y sin consultar a Catalog',
      async (token) => {
        const response = await get(PERIOD, token)

        expect(response.status).toBe(403)
        expect(JSON.stringify(response.body)).not.toContain('mostAuctioned')
        expect(catalog.received).toHaveLength(0)
      },
    )

    it('rechaza con 401 sin token o con token invalido', async () => {
      expect((await request(app.getHttpServer()).get(`${PATH}?${PERIOD}`)).status).toBe(401)
      expect((await get(PERIOD, 'inventado')).status).toBe(401)
      expect(catalog.received).toHaveLength(0)
    })
  })
})

describe('HTTP ranking de productos HU-91.3 con Catalog inalcanzable (conexion rechazada)', () => {
  let app: INestApplication
  const previousEnv = { ...process.env }

  beforeAll(async () => {
    // Puerto cerrado: el servidor se levanta para reservarlo y se apaga antes de usarlo.
    const dead = new FakeCatalogServer()
    const url = await dead.start()
    await dead.stop()
    app = await createApp(url)
  })

  afterAll(async () => {
    await app.close()
    process.env = previousEnv
  })

  it('el endpoint NO falla: 200 con UNAVAILABLE y los conteos de Auction', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}?${PERIOD}`)
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(200)
    expect(response.body.enrichment.status).toBe('UNAVAILABLE')
    expect(response.body.mostAuctioned[0].auctions.total).toBe(3)
    expect(response.body.mostAuctioned[0].product).toBeNull()
  })
})
