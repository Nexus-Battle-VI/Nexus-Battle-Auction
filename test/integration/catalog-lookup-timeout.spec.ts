import 'reflect-metadata'

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { CatalogProductLookupClient } from '../../src/adapters/outbound/http/CatalogProductLookupClient'
import { InMemoryAuctionMetricsRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { AUCTION_METRICS_REPOSITORY } from '../../src/application/ports/AuctionMetricsRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  type TokenVerifierPort,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * HU-91.3. El nombre de producto es enriquecimiento: si Catalog se CUELGA (no
 * cae ni responde 503, simplemente no contesta), el ranking no puede quedarse
 * esperando. El cliente de lookup corta a los 3 s (`timeoutMs: 3_000` en
 * `app.module.ts`), no reintenta, y el caso de uso responde `UNAVAILABLE` con
 * los conteos de Auction intactos.
 *
 * Dos niveles, a proposito:
 * - Cliente con un timeout CORTO (150 ms): demuestra el mecanismo en los dos modos
 *   de cuelgue sin sumar segundos a la suite.
 * - Aplicacion real con el timeout de PRODUCCION: un solo caso de ~3 s que fija el
 *   valor real; no se sustituye por un valor de prueba.
 */
type HangMode = 'never-responds' | 'partial-body'

const hangingCatalog = (mode: HangMode): { server: Server; requests: () => number } => {
  let received = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    received += 1
    if (mode === 'partial-body') {
      // Cabeceras 200 y la mitad del JSON: el cuerpo nunca termina.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"items":[')
    }
    // En ambos modos NUNCA se llama a `res.end()`.
    void req
  })
  return { server, requests: () => received }
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

const shutdown = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })

describe('cliente de lookup de Catalog con timeout corto (mecanismo)', () => {
  it.each<[string, HangMode]>([
    ['Catalog acepta la conexion y nunca responde', 'never-responds'],
    ['Catalog envia cabeceras y deja el cuerpo a medias', 'partial-body'],
  ])(
    '%s -> ExternalDependencyUnavailableError al agotarse, sin reintentos',
    async (_name, mode) => {
      const { server, requests } = hangingCatalog(mode)
      const baseUrl = await listen(server)
      const warn = jest.fn()
      const client = new CatalogProductLookupClient({ baseUrl, timeoutMs: 150, logger: { warn } })

      const started = Date.now()
      await expect(client.findProducts(['p-1'])).rejects.toBeInstanceOf(
        ExternalDependencyUnavailableError,
      )
      const elapsed = Date.now() - started

      // Espera el timeout (no falla antes) y no se queda colgado (no espera al servidor).
      expect(elapsed).toBeGreaterThanOrEqual(140)
      expect(elapsed).toBeLessThan(2_000)
      // Sin reintentos: una sola llamada a Catalog.
      expect(requests()).toBe(1)
      expect(warn).toHaveBeenCalledWith('catalog_product_lookup_no_disponible', expect.anything())
      await shutdown(server)
    },
  )
})

describe('ranking HTTP con Catalog colgado y el timeout de produccion (3 s)', () => {
  const verifier: TokenVerifierPort = {
    verify: () =>
      Promise.resolve({
        subject: 'admin-1',
        email: null,
        roles: new Set([Role.Administrator]),
      }),
  }
  const previousEnv = { ...process.env }
  let app: INestApplication
  let catalog: { server: Server; requests: () => number }

  beforeAll(async () => {
    catalog = hangingCatalog('never-responds')
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
      PERSISTENCE_DRIVER: 'memory',
      CATALOG_BASE_URL: await listen(catalog.server),
    })
    const repository = new InMemoryAuctionMetricsRepository()
    repository.seed({
      id: 'auction-1',
      productId: 'p-1',
      priceKind: 'CREDITS',
      status: 'FINISHED',
      publishedAt: new Date('2026-09-28T10:00:00Z'),
      closesAt: new Date('2026-09-29T10:00:00Z'),
      finishedAt: new Date('2026-09-29T10:00:30Z'),
      closingResultType: 'WITH_WINNER',
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(AUCTION_METRICS_REPOSITORY)
      .useValue(repository)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    await shutdown(catalog.server)
    process.env = previousEnv
  })

  it('responde 200 UNAVAILABLE a los ~3 s con los conteos intactos y una sola llamada a Catalog', async () => {
    const started = Date.now()

    const response = await request(app.getHttpServer())
      .get(
        '/api/v1/admin/auction-metrics/product-rankings?from=2026-09-28T00:00:00Z&to=2026-10-04T00:00:00Z',
      )
      .set('Authorization', 'Bearer token-admin')
      .timeout({ response: 20_000, deadline: 20_000 })
    const elapsed = Date.now() - started

    expect(response.status).toBe(200)
    expect(response.body.enrichment.status).toBe('UNAVAILABLE')
    expect(response.body.mostAuctioned[0]).toMatchObject({
      productId: 'p-1',
      product: null,
      auctions: { total: 1 },
    })
    expect(response.body.mostSold[0]).toMatchObject({
      productId: 'p-1',
      product: null,
      sales: { total: 1 },
    })
    expect(catalog.requests()).toBe(1)
    // Fija el valor de produccion: no antes de ~3 s (no es un fallo inmediato) y
    // no mucho despues (no se queda esperando). El margen superior absorbe un CI lento.
    expect(elapsed).toBeGreaterThanOrEqual(2_900)
    expect(elapsed).toBeLessThan(10_000)
  }, 30_000)
})
