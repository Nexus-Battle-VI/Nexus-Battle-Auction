import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import { GetAuctionDetail } from '../../src/application/use-cases/GetAuctionDetail'

const auction = {
  id: 'auction-63-6',

  sellerId: 'seller-1',

  productId: 'product-1',

  durationHours: 24 as const,

  publicationFeeCredits: 1,

  minimumBidCredits: 10,

  buyNowCredits: null,

  status: 'ACTIVE' as const,

  publishedAt: new Date('2026-09-22T12:00:00.000Z'),

  closesAt: new Date('2026-09-23T12:00:00.000Z'),
}

const currentBid = {
  id: 'bid-current',

  auctionId: auction.id,

  bidderId: 'bidder-current',

  amountCredits: 50,

  placedAt: new Date('2026-09-22T12:10:00.000Z'),
}

describe('GetAuctionDetail HU-63.6', () => {
  it('devuelve la subasta con su oferta lider actual', async () => {
    const repository = {
      findById: jest.fn().mockResolvedValue(auction),

      findLeadingBid: jest.fn().mockResolvedValue(currentBid),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute(auction.id)).resolves.toEqual({
      auction,
      currentBid,
    })

    expect(repository.findById).toHaveBeenCalledWith(auction.id)

    expect(repository.findLeadingBid).toHaveBeenCalledWith(auction.id)
  })

  it('devuelve currentBid null cuando aun no existen pujas', async () => {
    const repository = {
      findById: jest.fn().mockResolvedValue(auction),

      findLeadingBid: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute(auction.id)).resolves.toEqual({
      auction,
      currentBid: null,
    })
  })

  it('devuelve null cuando la subasta no existe y no consulta lider', async () => {
    const repository = {
      findById: jest.fn().mockResolvedValue(null),

      findLeadingBid: jest.fn(),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute('auction-missing')).resolves.toBeNull()

    expect(repository.findLeadingBid).not.toHaveBeenCalled()
  })
})
