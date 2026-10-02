import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import { GetAuctionDetail } from '../../src/application/use-cases/GetAuctionDetail'

const playerAuction = {
  id: 'auction-63-6',
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

const officialAuction = {
  id: 'auction-hu88-official',
  sellerId: 'game-master-1',
  productId: 'product-official-1',
  publisherType: 'GAME_MASTER' as const,
  priceKind: 'REAL_MONEY' as const,
  durationHours: 48 as const,
  publicationFeeCredits: 0,
  minimumBidCredits: null,
  buyNowCredits: null,
  currency: 'COP',
  minimumBidAmountMinor: 90_000,
  buyNowAmountMinor: 120_000,
  officialMark: 'PREMIUM' as const,
  status: 'ACTIVE' as const,
  publishedAt: new Date('2026-09-24T12:00:00.000Z'),
  closesAt: new Date('2026-09-26T12:00:00.000Z'),
}

const currentBid = {
  id: 'bid-current',
  auctionId: playerAuction.id,
  bidderId: 'bidder-current',
  amountCredits: 50,
  placedAt: new Date('2026-09-22T12:10:00.000Z'),
}

describe('GetAuctionDetail HU-63.6 / HU-88', () => {
  it('PLAYER/CREDITS: devuelve la subasta con su oferta lider actual', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(playerAuction),
      findLeadingBid: jest.fn().mockResolvedValue(currentBid),
      countBids: jest.fn().mockResolvedValue(3),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute(playerAuction.id)).resolves.toEqual({
      auction: playerAuction,
      currentBid,
      bidCount: 3,
    })

    expect(repository.findDetailById).toHaveBeenCalledWith(playerAuction.id)
    expect(repository.findLeadingBid).toHaveBeenCalledWith(playerAuction.id)
    expect(repository.countBids).toHaveBeenCalledWith(playerAuction.id)
  })

  it('devuelve currentBid null cuando aun no existen pujas', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(playerAuction),
      findLeadingBid: jest.fn().mockResolvedValue(null),
      countBids: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute(playerAuction.id)).resolves.toEqual({
      auction: playerAuction,
      currentBid: null,
      bidCount: 0,
    })
  })

  it('devuelve null cuando la subasta no existe y no consulta lider ni total', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(null),
      findLeadingBid: jest.fn(),
      countBids: jest.fn(),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute('auction-missing')).resolves.toBeNull()

    expect(repository.findLeadingBid).not.toHaveBeenCalled()
    expect(repository.countBids).not.toHaveBeenCalled()
  })

  it('usa el total persistido aunque la puja lider sea una sola', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(playerAuction),
      findLeadingBid: jest.fn().mockResolvedValue(currentBid),
      countBids: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute(playerAuction.id)).resolves.toMatchObject({ bidCount: 1 })
  })

  it('GAME_MASTER/REAL_MONEY: ya no devuelve null -el bug de toSnapshot esta corregido-', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(officialAuction),
      findLeadingBid: jest.fn().mockResolvedValue(null),
      countBids: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)
    const result = await useCase.execute(officialAuction.id)

    expect(result).not.toBeNull()
    expect(result?.auction).toEqual(officialAuction)
  })

  it('GAME_MASTER/REAL_MONEY: publisherType, priceKind, currency, officialMark y montos minor correctos', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(officialAuction),
      findLeadingBid: jest.fn().mockResolvedValue(null),
      countBids: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)
    const result = await useCase.execute(officialAuction.id)

    expect(result?.auction).toMatchObject({
      publisherType: 'GAME_MASTER',
      priceKind: 'REAL_MONEY',
      currency: 'COP',
      minimumBidAmountMinor: 90_000,
      buyNowAmountMinor: 120_000,
      officialMark: 'PREMIUM',
      minimumBidCredits: null,
      buyNowCredits: null,
    })
  })

  it('GAME_MASTER/REAL_MONEY: oficial sin pujas devuelve bidCount 0 y currentBid null -no admite pujas, solo compra inmediata-', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(officialAuction),
      findLeadingBid: jest.fn().mockResolvedValue(null),
      countBids: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)

    await expect(useCase.execute(officialAuction.id)).resolves.toMatchObject({
      currentBid: null,
      bidCount: 0,
    })
  })

  it('PLAYER/CREDITS: compatibilidad -campos previos (sellerId, minimumBidCredits, buyNowCredits, status) se conservan-', async () => {
    const repository = {
      findDetailById: jest.fn().mockResolvedValue(playerAuction),
      findLeadingBid: jest.fn().mockResolvedValue(null),
      countBids: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AuctionRepositoryPort>

    const useCase = new GetAuctionDetail(repository)
    const result = await useCase.execute(playerAuction.id)

    expect(result?.auction).toMatchObject({
      id: playerAuction.id,
      sellerId: playerAuction.sellerId,
      productId: playerAuction.productId,
      durationHours: playerAuction.durationHours,
      publicationFeeCredits: playerAuction.publicationFeeCredits,
      minimumBidCredits: playerAuction.minimumBidCredits,
      buyNowCredits: playerAuction.buyNowCredits,
      status: playerAuction.status,
    })
  })
})
