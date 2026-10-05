import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'
import type {
  CatalogProductDetails,
  CatalogProductDetailsPort,
} from '../../src/application/ports/CatalogProductDetailsPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { GetAuctionProductRankings } from '../../src/application/use-cases/GetAuctionProductRankings'

const asOf = new Date('2026-10-04T12:00:00.000Z')
const clock: ClockPort = { now: () => asOf }
const query = { from: '2026-09-28T00:00:00Z', to: '2026-10-04T00:00:00Z' }
const HOUR = 3_600_000
const at = (iso: string): Date => new Date(iso)
let sequence = 0

type Build = Partial<MetricsAuctionFact> & { readonly productId: string }

const publishedAt = (iso: string, build: Build): MetricsAuctionFact => ({
  id: `auction-${String(++sequence)}`,
  priceKind: 'CREDITS',
  status: 'ACTIVE',
  publishedAt: at(iso),
  closesAt: new Date(at(iso).getTime() + 24 * HOUR),
  ...build,
})

const sale = (iso: string, productId: string): MetricsAuctionFact =>
  publishedAt(iso, {
    productId,
    status: 'FINISHED',
    closingResultType: 'WITH_WINNER',
    finishedAt: new Date(at(iso).getTime() + 24 * HOUR + 30_000),
  })

const noBids = (iso: string, productId: string): MetricsAuctionFact =>
  publishedAt(iso, {
    productId,
    status: 'FINISHED',
    closingResultType: 'WITHOUT_BIDS',
    finishedAt: new Date(at(iso).getTime() + 24 * HOUR + 30_000),
  })

const buyNow = (iso: string, productId: string): MetricsAuctionFact =>
  publishedAt(iso, {
    productId,
    status: 'SOLD',
    buyNowCompletedAt: new Date(at(iso).getTime() + 2 * HOUR),
  })

const cancelled = (iso: string, productId: string): MetricsAuctionFact =>
  publishedAt(iso, {
    productId,
    status: 'CANCELLED',
    cancelledAt: new Date(at(iso).getTime() + HOUR),
  })

const official = (iso: string, productId: string): MetricsAuctionFact =>
  publishedAt(iso, { productId, priceKind: 'REAL_MONEY', officialMark: 'OFFICIAL' })

const details = (
  productId: string,
  extra: Record<string, unknown> = {},
): CatalogProductDetails => ({
  productId,
  sku: `sku-${productId}`,
  name: `Producto ${productId}`,
  type: 'ARMA',
  imageUrl: `https://img/${productId}.png`,
  ...extra,
})

class FakeCatalog implements CatalogProductDetailsPort {
  readonly calls: (readonly string[])[] = []
  products: readonly CatalogProductDetails[] = []
  error: Error | undefined

  findProducts(references: readonly string[]): Promise<readonly CatalogProductDetails[]> {
    this.calls.push([...references])
    if (this.error !== undefined) return Promise.reject(this.error)
    return Promise.resolve(this.products)
  }
}

describe('HU-91.3 ranking de productos (contrato hu-91.v1 §3.4 / §4.2)', () => {
  let repository: InMemoryAuctionMetricsRepository
  let catalog: FakeCatalog
  let rankings: GetAuctionProductRankings

  beforeEach(() => {
    sequence = 0
    repository = new InMemoryAuctionMetricsRepository()
    catalog = new FakeCatalog()
    rankings = new GetAuctionProductRankings(repository, catalog, clock)
  })

  describe('conteo (autoritativo de Auction)', () => {
    it('mas subastados: cuenta publicaciones por producto, ordena por total DESC y numera el rank', async () => {
      repository.seed(
        publishedAt('2026-09-28T10:00:00Z', { productId: 'p-b' }),
        publishedAt('2026-09-29T10:00:00Z', { productId: 'p-a' }),
        publishedAt('2026-09-30T10:00:00Z', { productId: 'p-a' }),
        publishedAt('2026-10-01T10:00:00Z', { productId: 'p-a' }),
        publishedAt('2026-10-02T10:00:00Z', { productId: 'p-c' }),
        publishedAt('2026-10-02T11:00:00Z', { productId: 'p-c' }),
      )

      const result = await rankings.execute(query)

      expect(
        result.mostAuctioned.map((item) => [item.rank, item.productId, item.auctions.total]),
      ).toEqual([
        [1, 'p-a', 3],
        [2, 'p-c', 2],
        [3, 'p-b', 1],
      ])
    })

    it('EMPATE: desempata por productId ASC y es estable sin importar el orden de insercion', async () => {
      const facts = [
        publishedAt('2026-09-28T10:00:00Z', { productId: 'zeta' }),
        publishedAt('2026-09-28T11:00:00Z', { productId: 'alfa' }),
        publishedAt('2026-09-28T12:00:00Z', { productId: 'mu' }),
        publishedAt('2026-09-28T13:00:00Z', { productId: 'Beta' }),
      ]
      repository.seed(...facts)
      const first = await rankings.execute(query)

      const reversed = new InMemoryAuctionMetricsRepository()
      reversed.seed(...[...facts].reverse())
      const second = await new GetAuctionProductRankings(reversed, catalog, clock).execute(query)

      // Orden por bytes (`collate "C"` en PostgreSQL): las mayusculas preceden a las minusculas.
      expect(first.mostAuctioned.map((item) => item.productId)).toEqual([
        'Beta',
        'alfa',
        'mu',
        'zeta',
      ])
      expect(second.mostAuctioned).toEqual(first.mostAuctioned)
    })

    it('REPUBLICADOS: el mismo producto publicado de nuevo cuenta una vez por publicacion, sin duplicar', async () => {
      // No existe un flujo de relistado: republicar crea otra fila de `auctions`.
      repository.seed(
        cancelled('2026-09-28T10:00:00Z', 'p-1'), // 1.a publicacion: cancelada
        noBids('2026-09-29T10:00:00Z', 'p-1'), // 2.a: sin pujas
        sale('2026-09-30T10:00:00Z', 'p-1'), // 3.a: vendida
        publishedAt('2026-10-01T10:00:00Z', { productId: 'p-2' }),
      )

      const result = await rankings.execute(query)

      expect(result.mostAuctioned[0]).toMatchObject({
        productId: 'p-1',
        auctions: { total: 3, playerCredits: 3, officialRealMoney: 0 },
      })
      expect(result.mostSold).toEqual([
        expect.objectContaining({ productId: 'p-1', sales: expect.objectContaining({ total: 1 }) }),
      ])
    })

    it('CANCELADAS: se publicaron (cuentan en mas subastados) pero nunca son una venta', async () => {
      repository.seed(
        cancelled('2026-09-28T10:00:00Z', 'p-1'),
        cancelled('2026-09-29T10:00:00Z', 'p-1'),
        sale('2026-09-30T10:00:00Z', 'p-2'),
      )

      const result = await rankings.execute(query)

      expect(result.mostAuctioned.find((item) => item.productId === 'p-1')?.auctions.total).toBe(2)
      expect(result.mostSold.map((item) => item.productId)).toEqual(['p-2'])
    })

    it('mas vendidos: separa cierre por subasta y compra inmediata, y excluye las sin pujas', async () => {
      repository.seed(
        sale('2026-09-28T10:00:00Z', 'p-1'),
        sale('2026-09-29T10:00:00Z', 'p-1'),
        buyNow('2026-09-30T10:00:00Z', 'p-1'),
        noBids('2026-09-30T11:00:00Z', 'p-1'),
        buyNow('2026-10-01T10:00:00Z', 'p-2'),
      )

      const result = await rankings.execute(query)

      expect(result.mostSold).toEqual([
        expect.objectContaining({
          rank: 1,
          productId: 'p-1',
          sales: { total: 3, byAuctionClose: 2, byBuyNow: 1, unit: 'CREDITS' },
        }),
        expect.objectContaining({
          rank: 2,
          productId: 'p-2',
          sales: { total: 1, byAuctionClose: 0, byBuyNow: 1, unit: 'CREDITS' },
        }),
      ])
    })

    it('separa jugador (creditos) y oficial (dinero real) y las oficiales nunca venden', async () => {
      repository.seed(
        publishedAt('2026-09-28T10:00:00Z', { productId: 'p-1' }),
        publishedAt('2026-09-29T10:00:00Z', { productId: 'p-1' }),
        official('2026-09-30T10:00:00Z', 'p-1'),
        official('2026-09-30T11:00:00Z', 'p-only-official'),
      )

      const result = await rankings.execute(query)

      expect(result.mostAuctioned[0]).toMatchObject({
        productId: 'p-1',
        auctions: { total: 3, playerCredits: 2, officialRealMoney: 1 },
      })
      expect(result.mostAuctioned[1]).toMatchObject({
        productId: 'p-only-official',
        auctions: { total: 1, playerCredits: 0, officialRealMoney: 1 },
      })
      expect(result.mostSold).toEqual([])
    })

    it('cada ranking se ancla a su timestamp: publicacion para subastados, cierre para vendidos', async () => {
      repository.seed(
        // Publicada ANTES del periodo, vendida DENTRO: solo cuenta en vendidos.
        buyNow('2026-09-27T23:00:00Z', 'p-sold-in'),
        // Publicada DENTRO, cierra FUERA (despues de `to`): solo cuenta en subastados.
        publishedAt('2026-10-03T23:00:00Z', {
          productId: 'p-listed-in',
          status: 'FINISHED',
          closingResultType: 'WITH_WINNER',
          finishedAt: at('2026-10-04T23:00:30Z'),
        }),
      )

      const result = await rankings.execute(query)

      expect(result.mostAuctioned.map((item) => item.productId)).toEqual(['p-listed-in'])
      expect(result.mostSold.map((item) => item.productId)).toEqual(['p-sold-in'])
    })

    it('limit recorta cada ranking de forma independiente (defecto 10)', async () => {
      repository.seed(
        ...Array.from({ length: 12 }, (_, index) =>
          sale(
            `2026-09-28T${String(index).padStart(2, '0')}:00:00Z`,
            `p-${String(index).padStart(2, '0')}`,
          ),
        ),
      )

      const byDefault = await rankings.execute(query)
      const three = await rankings.execute({ ...query, limit: '3' })

      expect(byDefault.limit).toBe(10)
      expect(byDefault.mostAuctioned).toHaveLength(10)
      expect(byDefault.mostSold).toHaveLength(10)
      expect(three.limit).toBe(3)
      expect(three.mostAuctioned.map((item) => item.productId)).toEqual(['p-00', 'p-01', 'p-02'])
      expect(three.mostSold).toHaveLength(3)
    })

    it('sembrar dos veces la misma subasta (reintento idempotente) no duplica el conteo', async () => {
      const auction = sale('2026-09-28T10:00:00Z', 'p-1')
      repository.seed(auction)
      const once = await rankings.execute(query)

      repository.seed(auction, auction)

      expect(await rankings.execute(query)).toEqual(once)
    })

    it('rechaza limit fuera de 1..50 o no entero con INVALID_PARAMETER', async () => {
      for (const limit of ['0', '51', '-1', '1.5', 'abc', '', '1e1', ' 5', '0010x']) {
        await expect(rankings.execute({ ...query, limit })).rejects.toMatchObject({
          code: 'INVALID_PARAMETER',
        })
      }
      for (const limit of ['1', '50', '007']) {
        await expect(rankings.execute({ ...query, limit })).resolves.toMatchObject({
          limit: Number(limit),
        })
      }
    })

    it('un periodo invalido propaga INVALID_PERIOD', async () => {
      await expect(rankings.execute({ from: 'x' })).rejects.toMatchObject({
        code: 'INVALID_PERIOD',
      })
    })
  })

  describe('enriquecimiento con Catalog', () => {
    beforeEach(() => {
      repository.seed(
        sale('2026-09-28T10:00:00Z', 'p-1'),
        sale('2026-09-29T10:00:00Z', 'p-2'),
        publishedAt('2026-09-30T10:00:00Z', { productId: 'p-3' }),
      )
    })

    it('COMPLETE: Catalog conoce todos los productos; consulta UNA vez con los productId unicos', async () => {
      catalog.products = [details('p-1'), details('p-2'), details('p-3')]

      const result = await rankings.execute(query)

      expect(result.enrichment).toEqual({
        source: 'catalog:POST /api/v1/catalog/products/lookup',
        status: 'COMPLETE',
      })
      expect(catalog.calls).toHaveLength(1)
      expect([...(catalog.calls[0] ?? [])].sort()).toEqual(['p-1', 'p-2', 'p-3'])
      expect(result.mostAuctioned.every((item) => item.product !== null)).toBe(true)
      expect(result.mostSold[0]?.product).toEqual({
        name: 'Producto p-1',
        sku: 'sku-p-1',
        type: 'ARMA',
        imageUrl: 'https://img/p-1.png',
      })
    })

    it('expone EXACTAMENTE name, sku, type e imageUrl: ningun otro campo de Catalog se filtra', async () => {
      catalog.products = [
        details('p-1', { description: 'x', creditsPrice: 9, premium: true, brand: 'ACME' }),
        details('p-2'),
        details('p-3'),
      ]

      const result = await rankings.execute(query)

      expect(Object.keys(result.mostSold[0]?.product ?? {}).sort()).toEqual([
        'imageUrl',
        'name',
        'sku',
        'type',
      ])
    })

    it('UNAVAILABLE: Catalog no responde -> 200 con product null en TODOS los items y los conteos intactos', async () => {
      catalog.error = new ExternalDependencyUnavailableError('catalog')

      const result = await rankings.execute(query)

      expect(result.enrichment.status).toBe('UNAVAILABLE')
      expect(result.mostAuctioned.every((item) => item.product === null)).toBe(true)
      expect(result.mostSold.every((item) => item.product === null)).toBe(true)
      expect(result.mostAuctioned).toHaveLength(3)
      expect(result.mostAuctioned[0]?.auctions.total).toBe(1)
    })

    it('UNAVAILABLE tambien cuando Catalog rompe su contrato (items ininteligibles)', async () => {
      catalog.error = new ExternalContractError('catalog', 'lookup ininteligible')

      const result = await rankings.execute(query)

      expect(result.enrichment.status).toBe('UNAVAILABLE')
      expect(result.mostSold[0]?.product).toBeNull()
    })

    it('PARTIAL: Catalog omite un productId -> product null SOLO en ese item', async () => {
      catalog.products = [details('p-1'), details('p-3')] // omite p-2

      const result = await rankings.execute(query)

      expect(result.enrichment.status).toBe('PARTIAL')
      const byId = Object.fromEntries(
        [...result.mostAuctioned, ...result.mostSold].map((item) => [item.productId, item.product]),
      )
      expect(byId['p-1']).not.toBeNull()
      expect(byId['p-2']).toBeNull()
      expect(byId['p-3']).not.toBeNull()
    })

    it('PARTIAL con una lista vacia de Catalog (todos desconocidos): product null en todos, conteos intactos', async () => {
      catalog.products = []

      const result = await rankings.execute(query)

      expect(result.enrichment.status).toBe('PARTIAL')
      expect(result.mostAuctioned.every((item) => item.product === null)).toBe(true)
    })

    it('resuelve por productId o por el alias sku que devuelve Catalog', async () => {
      catalog.products = [
        { productId: 'uuid-1', sku: 'p-1', name: 'Por sku', type: 'ITEM', imageUrl: 'u' },
        details('p-2'),
        details('p-3'),
      ]

      const result = await rankings.execute(query)

      expect(result.enrichment.status).toBe('COMPLETE')
      // El `productId` del item es el de Auction, tal cual se guardo.
      expect(result.mostSold.find((item) => item.productId === 'p-1')?.product?.name).toBe(
        'Por sku',
      )
    })

    it('sin productos que nombrar NO consulta Catalog y reporta COMPLETE', async () => {
      const empty = await new GetAuctionProductRankings(
        new InMemoryAuctionMetricsRepository(),
        catalog,
        clock,
      ).execute(query)

      expect(empty.mostAuctioned).toEqual([])
      expect(empty.mostSold).toEqual([])
      expect(empty.enrichment.status).toBe('COMPLETE')
      expect(catalog.calls).toHaveLength(0)
    })

    it('un error que NO es de dependencia externa se propaga: no se esconde como Catalog caido', async () => {
      catalog.error = new TypeError('defecto propio')

      await expect(rankings.execute(query)).rejects.toThrow('defecto propio')
    })

    it('envoltorio del contrato: definitionsVersion, periodo UTC, asOf y limit', async () => {
      catalog.products = [details('p-1'), details('p-2'), details('p-3')]

      const result = await rankings.execute(query)

      expect(result).toMatchObject({
        definitionsVersion: 'hu-91.v1',
        period: {
          from: '2026-09-28T00:00:00.000Z',
          to: '2026-10-04T00:00:00.000Z',
          timezone: 'UTC',
          bounds: '[from,to)',
        },
        asOf: '2026-10-04T12:00:00.000Z',
        limit: 10,
      })
    })
  })
})
