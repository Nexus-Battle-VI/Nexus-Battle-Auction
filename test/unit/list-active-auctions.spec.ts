import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { PriceSortRequiresCreditsError } from '../../src/application/errors/MarketplaceQueryError'
import type { ActiveAuctionList } from '../../src/application/ports/AuctionRepositoryPort'
import { ListActiveAuctions } from '../../src/application/use-cases/ListActiveAuctions'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { Auction } from '../../src/domain/entities/Auction'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import { Bid } from '../../src/domain/entities/Bid'
import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
} from '../../src/domain/entities/OfficialAuction'
import { AuctionPriceKind } from '../../src/domain/value-objects/AuctionPublicationPricing'
import { FakeCatalogProductLookup } from '../support/fake-catalog-product-lookup'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }
const newList = (repository: InMemoryAuctionRepository, catalog = new FakeCatalogProductLookup()) =>
  new ListActiveAuctions(repository, clock, catalog)

interface PublishOptions {
  readonly durationHours?: 24 | 48
  readonly minimumBidCredits?: number
  readonly buyNowCredits?: number | null
}

const publish = async (
  repository: InMemoryAuctionRepository,
  id: string,
  closesAt: Date,
  { durationHours = 24, minimumBidCredits = 10, buyNowCredits = null }: PublishOptions = {},
) => {
  const publishedAt = new Date(closesAt.getTime() - durationHours * 60 * 60 * 1000)
  await repository.publish({
    operationId: `publish-${id}`,
    auction: Auction.publish({
      auctionId: id,
      sellerId: `seller-${id}`,
      productId: `product-${id}`,
      durationHours,
      minimumBidCredits,
      buyNowCredits,
      publishedAt,
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    }),
    inventoryCommitmentId: `commitment-${id}`,
    feeChargeId: `fee-${id}`,
  })
}

const bid = async (
  repository: InMemoryAuctionRepository,
  auctionId: string,
  amountCredits: number,
  bidId = `bid-${auctionId}`,
) =>
  repository.persistBid(
    Bid.register({
      bidId,
      auctionId,
      bidderId: 'bidder-1',
      amountCredits,
      placedAt: now,
      eligibility: {
        auctionStatus: 'ACTIVE',
        sellerId: `seller-${auctionId}`,
        currentBidCredits: null,
        minimumIncrementCredits: 1,
        lastBidAtByBidder: null,
        activeBidCount: 0,
      },
    }),
  )

const publishOfficial = async (
  repository: InMemoryAuctionRepository,
  id: string,
  closesAt: Date,
  mark = OfficialAuctionMark.Official,
  buyNowAmountMinor: number | null = 120_000,
) => {
  const publishedAt = new Date(closesAt.getTime() - 24 * 60 * 60 * 1000)
  await repository.publishOfficial({
    operationId: `publish-${id}`,
    auction: OfficialAuction.publish({
      auctionId: id,
      publisherId: 'upb-company',
      publisherType: AuctionPublisherType.GameMaster,
      productId: `product-${id}`,
      durationHours: 24,
      pricing: {
        kind: AuctionPriceKind.RealMoney,
        minimumBid: { amountMinor: 90_000, currency: 'COP' },
        buyNow:
          buyNowAmountMinor === null ? null : { amountMinor: buyNowAmountMinor, currency: 'COP' },
      },
      mark,
      publishedAt,
    }),
  })
}

describe('ListActiveAuctions', () => {
  it('devuelve una pagina vacia cuando no hay activas disponibles', async () => {
    await expect(
      newList(new InMemoryAuctionRepository()).execute({
        page: 1,
        pageSize: 16,
      }),
    ).resolves.toEqual({ items: [], total: 0 })
  })

  it('filtra, ordena, pagina y expone solo el importe de la puja lider', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = newList(repository)
    await publish(repository, 'same-b', new Date(now.getTime() + 2_000))
    await publish(repository, 'expired', now)
    await publish(repository, 'first', new Date(now.getTime() + 1_000))
    await publish(repository, 'same-a', new Date(now.getTime() + 2_000))
    await bid(repository, 'same-a', 30)
    await repository.finishAuction({
      auctionId: 'same-b',
      finishedAt: now,
      closingResult: AuctionClosingResult.withoutBids(now),
    })

    await expect(useCase.execute({ page: 1, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'first', currentBidAmount: null, bidCount: 0 }],
    })
    await expect(useCase.execute({ page: 2, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'same-a', currentBidAmount: 30, status: 'ACTIVE', bidCount: 1 }],
    })
  })

  it('prioriza GAME_MASTER y mantiene cierre e id como desempates antes de paginar', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = newList(repository)
    await publish(repository, 'player-first-closing', new Date(now.getTime() + 1_000))
    await publishOfficial(repository, 'official-b', new Date(now.getTime() + 3_000))
    await publishOfficial(
      repository,
      'official-a',
      new Date(now.getTime() + 3_000),
      OfficialAuctionMark.Premium,
    )

    await expect(useCase.execute({ page: 1, pageSize: 2 })).resolves.toMatchObject({
      total: 3,
      items: [
        {
          id: 'official-a',
          publisherType: 'GAME_MASTER',
          priceKind: 'REAL_MONEY',
          currency: 'COP',
          officialMark: 'PREMIUM',
          minimumBidAmountMinor: 90_000,
          bidCount: 0,
        },
        {
          id: 'official-b',
          publisherType: 'GAME_MASTER',
          officialMark: 'OFFICIAL',
          bidCount: 0,
        },
      ],
    })
    await expect(useCase.execute({ page: 2, pageSize: 2 })).resolves.toMatchObject({
      total: 3,
      items: [
        {
          id: 'player-first-closing',
          publisherType: 'PLAYER',
          priceKind: 'CREDITS',
          minimumBidCredits: 10,
          officialMark: null,
        },
      ],
    })
  })

  it('devuelve el total real de pujas persistidas de cada subasta del listado', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = newList(repository)
    await publish(repository, 'no-bids', new Date(now.getTime() + 1_000))
    await publish(repository, 'one-bid', new Date(now.getTime() + 2_000))
    await publish(repository, 'many-bids', new Date(now.getTime() + 3_000))
    await bid(repository, 'one-bid', 15)
    await bid(repository, 'many-bids', 20, 'many-bids-1')
    await bid(repository, 'many-bids', 30, 'many-bids-2')
    await bid(repository, 'many-bids', 40, 'many-bids-3')

    await expect(useCase.execute({ page: 1, pageSize: 16 })).resolves.toMatchObject({
      total: 3,
      items: [
        { id: 'no-bids', bidCount: 0, currentBidAmount: null },
        { id: 'one-bid', bidCount: 1, currentBidAmount: 15 },
        { id: 'many-bids', bidCount: 3, currentBidAmount: 40 },
      ],
    })
    await expect(repository.countBids('no-bids')).resolves.toBe(0)
    await expect(repository.countBids('one-bid')).resolves.toBe(1)
    await expect(repository.countBids('many-bids')).resolves.toBe(3)
  })
})

const HOUR = 60 * 60 * 1000
const at = (hours: number): Date => new Date(now.getTime() + hours * HOUR)
const ids = (list: ActiveAuctionList): string[] => list.items.map((item) => item.id)

/**
 * Escenario mixto donde cierre, publicacion, pujas y precio dan ordenes
 * distintos entre si (publicado = cierre - duracion):
 *
 * | id   | tipo   | cierre | publicado | buy-now | pujas | precio efectivo |
 * | o-a  | GM     | +4h    | -20h      | si      | 0     | -               |
 * | o-b  | GM     | +5h    | -19h      | no      | 0     | -               |
 * | p-c  | PLAYER | +1h    | -47h      | si      | 0     | 5 (minimo)      |
 * | p-a  | PLAYER | +2h    | -22h      | si      | 1     | 50 (lider)      |
 * | p-b  | PLAYER | +3h    | -45h      | no      | 3     | 100 (lider)     |
 */
const seedMarketplace = async (): Promise<InMemoryAuctionRepository> => {
  const repository = new InMemoryAuctionRepository()
  await publishOfficial(repository, 'o-a', at(4))
  await publishOfficial(repository, 'o-b', at(5), OfficialAuctionMark.Premium, null)
  await publish(repository, 'p-c', at(1), {
    durationHours: 48,
    minimumBidCredits: 5,
    buyNowCredits: 8,
  })
  await publish(repository, 'p-a', at(2), { minimumBidCredits: 10, buyNowCredits: 100 })
  await publish(repository, 'p-b', at(3), { durationHours: 48, minimumBidCredits: 30 })
  await bid(repository, 'p-a', 50, 'p-a-1')
  await bid(repository, 'p-b', 40, 'p-b-1')
  await bid(repository, 'p-b', 70, 'p-b-2')
  await bid(repository, 'p-b', 100, 'p-b-3')
  return repository
}

describe('ListActiveAuctions: filtros y orden', () => {
  const list = async (input: Parameters<ListActiveAuctions['execute']>[0]) =>
    newList(await seedMarketplace()).execute(input)

  it('sin filtros ni sort conserva GAME_MASTER primero, cierre e id', async () => {
    const result = await list({ page: 1, pageSize: 16 })

    expect(ids(result)).toEqual(['o-a', 'o-b', 'p-c', 'p-a', 'p-b'])
    expect(result.total).toBe(5)
  })

  it.each([
    [{ publisherType: 'PLAYER' as const }, ['p-c', 'p-a', 'p-b']],
    [{ publisherType: 'GAME_MASTER' as const }, ['o-a', 'o-b']],
    [{ priceKind: 'CREDITS' as const }, ['p-c', 'p-a', 'p-b']],
    [{ priceKind: 'REAL_MONEY' as const }, ['o-a', 'o-b']],
    [{ hasBuyNow: true }, ['o-a', 'p-c', 'p-a']],
    [{ hasBuyNow: false }, ['o-b', 'p-b']],
    [{ publisherType: 'PLAYER' as const, hasBuyNow: true }, ['p-c', 'p-a']],
    [{ publisherType: 'PLAYER' as const, priceKind: 'REAL_MONEY' as const }, []],
  ])('filtra %j y el total cuenta solo lo filtrado', async (filters, expected) => {
    const result = await list({ page: 1, pageSize: 16, filters })

    expect(ids(result)).toEqual(expected)
    expect(result.total).toBe(expected.length)
  })

  it.each([
    ['closingSoon' as const, {}, ['p-c', 'p-a', 'p-b', 'o-a', 'o-b']],
    ['newest' as const, {}, ['o-b', 'o-a', 'p-a', 'p-b', 'p-c']],
    ['mostBids' as const, {}, ['p-b', 'p-a', 'p-c', 'o-a', 'o-b']],
    ['priceAsc' as const, { priceKind: 'CREDITS' as const }, ['p-c', 'p-a', 'p-b']],
    ['priceDesc' as const, { priceKind: 'CREDITS' as const }, ['p-b', 'p-a', 'p-c']],
  ])('sort=%s manda sobre la prioridad de GAME_MASTER', async (sort, filters, expected) => {
    const result = await list({ page: 1, pageSize: 16, filters, sort })

    expect(ids(result)).toEqual(expected)
    expect(result.total).toBe(expected.length)
  })

  it('pagina despues de filtrar y ordenar', async () => {
    const input = {
      pageSize: 2,
      filters: { priceKind: 'CREDITS' as const },
      sort: 'priceDesc' as const,
    }

    await expect(list({ ...input, page: 1 }).then(ids)).resolves.toEqual(['p-b', 'p-a'])
    await expect(list({ ...input, page: 2 })).resolves.toMatchObject({
      total: 3,
      items: [{ id: 'p-c' }],
    })
  })

  it('una pagina posterior al ultimo resultado viene vacia con el total real', async () => {
    await expect(
      list({ page: 3, pageSize: 2, filters: { publisherType: 'PLAYER' } }),
    ).resolves.toEqual({ items: [], total: 3 })
  })

  it('desempata por id cuando precio, pujas o cierre coinciden', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = newList(repository)
    await publish(repository, 'tie-b', at(1))
    await publish(repository, 'tie-a', at(1))
    await publish(repository, 'tie-c', at(1))

    for (const sort of ['closingSoon', 'newest', 'mostBids', 'priceAsc', 'priceDesc'] as const) {
      const result = await useCase.execute({
        page: 1,
        pageSize: 16,
        filters: { priceKind: 'CREDITS' },
        sort,
      })
      expect(ids(result)).toEqual(['tie-a', 'tie-b', 'tie-c'])
    }
  })

  it.each([
    ['priceAsc' as const, {}],
    ['priceDesc' as const, {}],
    ['priceAsc' as const, { priceKind: 'REAL_MONEY' as const }],
    ['priceDesc' as const, { publisherType: 'PLAYER' as const }],
  ])('%s sin priceKind=CREDITS (%j) se rechaza sin consultar', async (sort, filters) => {
    const repository = { listActive: jest.fn(), listActiveProductIds: jest.fn() }

    await expect(
      new ListActiveAuctions(repository, clock, new FakeCatalogProductLookup()).execute({
        page: 1,
        pageSize: 16,
        filters,
        sort,
      }),
    ).rejects.toBeInstanceOf(PriceSortRequiresCreditsError)
    expect(repository.listActive).not.toHaveBeenCalled()
  })

  it('pasa filtros, orden y el instante del reloj al repositorio', async () => {
    const repository = {
      listActive: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listActiveProductIds: jest.fn(),
    }
    const filters = { priceKind: 'CREDITS' as const, hasBuyNow: false }

    await new ListActiveAuctions(repository, clock, new FakeCatalogProductLookup()).execute({
      page: 2,
      pageSize: 8,
      filters,
      sort: 'priceAsc',
    })

    expect(repository.listActive).toHaveBeenCalledWith({
      page: 2,
      pageSize: 8,
      filters,
      sort: 'priceAsc',
      now,
    })
  })
})

describe('ListActiveAuctions: busqueda global por Catalog', () => {
  it('sin search conserva el listado y no consulta Catalog', async () => {
    const repository = new InMemoryAuctionRepository()
    const catalog = new FakeCatalogProductLookup()
    await publish(repository, 'one', at(1))

    await expect(
      newList(repository, catalog).execute({ page: 1, pageSize: 16 }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ id: 'one' }],
    })
    expect(catalog.calls).toEqual([])
  })

  it('resuelve el universo filtrado en Catalog y pagina solo los ids coincidentes', async () => {
    const repository = await seedMarketplace()
    const catalog = new FakeCatalogProductLookup()
    catalog.matching = new Set(['product-p-a'])

    await expect(
      newList(repository, catalog).execute({
        page: 1,
        pageSize: 16,
        search: ' espada ',
        filters: { publisherType: 'PLAYER', priceKind: 'CREDITS', hasBuyNow: true },
        sort: 'priceDesc',
      }),
    ).resolves.toMatchObject({ total: 1, items: [{ id: 'p-a' }] })
    expect(catalog.calls).toEqual([
      {
        references: ['product-p-c', 'product-p-a'],
        query: ' espada ',
      },
    ])
  })

  it('devuelve cero sin listado final cuando Catalog no encuentra coincidencias', async () => {
    const repository = {
      listActiveProductIds: jest.fn().mockResolvedValue(['product-1']),
      listActive: jest.fn(),
    }
    const catalog = new FakeCatalogProductLookup()

    await expect(
      new ListActiveAuctions(repository, clock, catalog).execute({
        page: 1,
        pageSize: 16,
        search: 'ninguno',
      }),
    ).resolves.toEqual({ items: [], total: 0 })
    expect(repository.listActive).not.toHaveBeenCalled()
  })

  it('propaga la indisponibilidad de Catalog', async () => {
    const repository = new InMemoryAuctionRepository()
    const catalog = new FakeCatalogProductLookup()
    catalog.error = new ExternalDependencyUnavailableError('catalog')
    await publish(repository, 'one', at(1))

    await expect(
      newList(repository, catalog).execute({ page: 1, pageSize: 16, search: 'espada' }),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })
})
