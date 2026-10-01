import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { GetAuctionSuggestions } from '../../src/application/use-cases/GetAuctionSuggestions'
import { FakeCatalogProductLookup } from '../support/fake-catalog-product-lookup'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }

describe('GetAuctionSuggestions', () => {
  it('sin candidatos activos no consulta Catalog y responde vacio', async () => {
    const auctions = { listActiveProductIds: jest.fn().mockResolvedValue([]) }
    const catalog = new FakeCatalogProductLookup()

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'dragon', limit: 8 }),
    ).resolves.toEqual({ items: [] })
    expect(catalog.suggestionCalls).toEqual([])
  })

  it('pasa el universo filtrado y el texto a Catalog', async () => {
    const auctions = {
      listActiveProductIds: jest.fn().mockResolvedValue(['product-1', 'product-2']),
    }
    const catalog = new FakeCatalogProductLookup()
    catalog.suggestions = [{ productId: 'product-1', name: 'Dragon de fuego', type: 'EPICA' }]
    const filters = {
      publisherType: 'PLAYER' as const,
      priceKind: 'CREDITS' as const,
      hasBuyNow: true,
    }

    await new GetAuctionSuggestions(auctions, clock, catalog).execute({
      q: 'dragon',
      limit: 8,
      filters,
    })

    expect(auctions.listActiveProductIds).toHaveBeenCalledWith({ now, filters })
    expect(catalog.suggestionCalls).toEqual([
      { references: ['product-1', 'product-2'], query: 'dragon' },
    ])
  })

  it('sin coincidencias en Catalog responde vacio', async () => {
    const auctions = { listActiveProductIds: jest.fn().mockResolvedValue(['product-1']) }
    const catalog = new FakeCatalogProductLookup()
    catalog.suggestions = []

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'ninguno', limit: 8 }),
    ).resolves.toEqual({ items: [] })
  })

  it('devuelve productId, name y type; nada mas', async () => {
    const auctions = { listActiveProductIds: jest.fn().mockResolvedValue(['product-1']) }
    const catalog = new FakeCatalogProductLookup()
    catalog.suggestions = [{ productId: 'product-1', name: 'Espada de dragon', type: 'ARMA' }]

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'dragon', limit: 8 }),
    ).resolves.toEqual({
      items: [{ productId: 'product-1', name: 'Espada de dragon', type: 'ARMA' }],
    })
  })

  it('limita la cantidad de sugerencias a `limit`, conservando el orden de Catalog', async () => {
    const auctions = {
      listActiveProductIds: jest.fn().mockResolvedValue(['p-1', 'p-2', 'p-3']),
    }
    const catalog = new FakeCatalogProductLookup()
    catalog.suggestions = [
      { productId: 'p-1', name: 'Dragon alfa', type: 'HEROE' },
      { productId: 'p-2', name: 'Dragon beta', type: 'HEROE' },
      { productId: 'p-3', name: 'Dragon gamma', type: 'HEROE' },
    ]

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'dragon', limit: 2 }),
    ).resolves.toEqual({
      items: [
        { productId: 'p-1', name: 'Dragon alfa', type: 'HEROE' },
        { productId: 'p-2', name: 'Dragon beta', type: 'HEROE' },
      ],
    })
  })

  it('deduplica por productId aunque Catalog repita un match', async () => {
    const auctions = { listActiveProductIds: jest.fn().mockResolvedValue(['p-1']) }
    const catalog = new FakeCatalogProductLookup()
    catalog.suggestions = [
      { productId: 'p-1', name: 'Dragon', type: 'HEROE' },
      { productId: 'p-1', name: 'Dragon', type: 'HEROE' },
    ]

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'dragon', limit: 8 }),
    ).resolves.toEqual({ items: [{ productId: 'p-1', name: 'Dragon', type: 'HEROE' }] })
  })

  it('la deduplicacion ocurre antes de aplicar `limit`', async () => {
    const auctions = { listActiveProductIds: jest.fn().mockResolvedValue(['p-1', 'p-2']) }
    const catalog = new FakeCatalogProductLookup()
    catalog.suggestions = [
      { productId: 'p-1', name: 'Dragon alfa', type: 'HEROE' },
      { productId: 'p-1', name: 'Dragon alfa', type: 'HEROE' },
      { productId: 'p-2', name: 'Dragon beta', type: 'HEROE' },
    ]

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'dragon', limit: 2 }),
    ).resolves.toEqual({
      items: [
        { productId: 'p-1', name: 'Dragon alfa', type: 'HEROE' },
        { productId: 'p-2', name: 'Dragon beta', type: 'HEROE' },
      ],
    })
  })

  it('propaga la indisponibilidad de Catalog', async () => {
    const auctions = { listActiveProductIds: jest.fn().mockResolvedValue(['p-1']) }
    const catalog = new FakeCatalogProductLookup()
    catalog.error = new ExternalDependencyUnavailableError('catalog')

    await expect(
      new GetAuctionSuggestions(auctions, clock, catalog).execute({ q: 'dragon', limit: 8 }),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })
})
