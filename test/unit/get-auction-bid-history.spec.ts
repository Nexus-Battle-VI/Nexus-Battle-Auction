import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import { GetAuctionBidHistory } from '../../src/application/use-cases/GetAuctionBidHistory'

const auction = {
  id: 'auction-hu88',
  sellerId: 'seller-1',
  productId: 'product-1',
  publisherType: 'PLAYER' as const,
  priceKind: 'CREDITS' as const,
  durationHours: 24 as const,
  publicationFeeCredits: 1,
  minimumBidCredits: 10,
  buyNowCredits: null,
  currency: null,
  minimumBidAmountMinor: null,
  buyNowAmountMinor: null,
  officialMark: null,
  status: 'ACTIVE' as const,
  publishedAt: new Date('2026-09-22T12:00:00.000Z'),
  closesAt: new Date('2026-09-23T12:00:00.000Z'),
}

const page = {
  items: [
    { id: 'bid-1', amountCredits: 10, placedAt: new Date('2026-09-22T12:01:00.000Z') },
    { id: 'bid-2', amountCredits: 20, placedAt: new Date('2026-09-22T12:02:00.000Z') },
  ],
  total: 2,
}

describe('GetAuctionBidHistory HU-88', () => {
  it('subasta existente sin pujas: pagina vacia con total 0', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(auction),
      listBidHistoryPage: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionBidHistory(repository)

    await expect(
      useCase.execute({ auctionId: auction.id, page: 1, pageSize: 20 }),
    ).resolves.toEqual({ items: [], total: 0 })
  })

  it('subasta inexistente: devuelve null -no una pagina vacia- y no consulta el historial', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(null),
      listBidHistoryPage: jest.fn(),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionBidHistory(repository)

    await expect(
      useCase.execute({ auctionId: 'auction-missing', page: 1, pageSize: 20 }),
    ).resolves.toBeNull()

    expect(repository.listBidHistoryPage).not.toHaveBeenCalled()
  })

  it('una puja: la devuelve en items', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(auction),
      listBidHistoryPage: jest.fn().mockResolvedValue({ items: [page.items[0]], total: 1 }),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionBidHistory(repository)

    await expect(
      useCase.execute({ auctionId: auction.id, page: 1, pageSize: 20 }),
    ).resolves.toEqual({ items: [page.items[0]], total: 1 })
  })

  it('multiples pujas: las devuelve todas en una sola pagina si entran', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(auction),
      listBidHistoryPage: jest.fn().mockResolvedValue(page),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionBidHistory(repository)

    await expect(
      useCase.execute({ auctionId: auction.id, page: 1, pageSize: 20 }),
    ).resolves.toEqual(page)
  })

  it('propaga page/pageSize exactos al repositorio -la paginacion ocurre en el repositorio-', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(auction),
      listBidHistoryPage: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionBidHistory(repository)
    await useCase.execute({ auctionId: auction.id, page: 2, pageSize: 5 })

    expect(repository.listBidHistoryPage).toHaveBeenCalledWith({
      auctionId: auction.id,
      page: 2,
      pageSize: 5,
    })
  })

  it('nunca incluye bidderId en los items devueltos', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(auction),
      listBidHistoryPage: jest.fn().mockResolvedValue(page),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionBidHistory(repository)
    const result = await useCase.execute({ auctionId: auction.id, page: 1, pageSize: 20 })

    for (const item of result?.items ?? []) {
      expect(item).not.toHaveProperty('bidderId')
    }
  })
})
