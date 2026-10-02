import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import type { SellerPublicProfilePort } from '../../src/application/ports/SellerPublicProfilePort'
import {
  GetAuctionDetail,
  type GetAuctionDetailLogger,
} from '../../src/application/use-cases/GetAuctionDetail'

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

const validProfile = {
  subject: playerAuction.sellerId,
  displayName: 'Ana Ramirez',
  avatarUrl: '/accounts/seller-1/avatar',
}

const makeRepository = (
  overrides: Partial<jest.Mocked<AuctionRepositoryPort>> = {},
): jest.Mocked<AuctionRepositoryPort> =>
  ({
    findDetailById: jest.fn().mockResolvedValue(playerAuction),
    findLeadingBid: jest.fn().mockResolvedValue(null),
    countBids: jest.fn().mockResolvedValue(0),
    ...overrides,
  }) as unknown as jest.Mocked<AuctionRepositoryPort>

const makeSellerProfile = (
  overrides: Partial<jest.Mocked<SellerPublicProfilePort>> = {},
): jest.Mocked<SellerPublicProfilePort> => ({
  getPublicProfile: jest.fn().mockResolvedValue(validProfile),
  ...overrides,
})

const makeLogger = (): jest.Mocked<GetAuctionDetailLogger> => ({ warn: jest.fn() })

describe('GetAuctionDetail HU-63.6 / HU-88', () => {
  it('PLAYER/CREDITS: devuelve la subasta con su oferta lider actual', async () => {
    const repository = makeRepository({
      findLeadingBid: jest.fn().mockResolvedValue(currentBid),
      countBids: jest.fn().mockResolvedValue(3),
    })
    const sellerProfile = makeSellerProfile()
    const logger = makeLogger()

    const useCase = new GetAuctionDetail(repository, sellerProfile, logger)

    await expect(useCase.execute(playerAuction.id)).resolves.toEqual({
      auction: playerAuction,
      currentBid,
      bidCount: 3,
      sellerDisplayName: validProfile.displayName,
      sellerAvatarUrl: validProfile.avatarUrl,
    })

    expect(repository.findDetailById).toHaveBeenCalledWith(playerAuction.id)
    expect(repository.findLeadingBid).toHaveBeenCalledWith(playerAuction.id)
    expect(repository.countBids).toHaveBeenCalledWith(playerAuction.id)
    expect(sellerProfile.getPublicProfile).toHaveBeenCalledWith(playerAuction.sellerId)
    expect(sellerProfile.getPublicProfile).toHaveBeenCalledTimes(1)
  })

  it('devuelve currentBid null cuando aun no existen pujas', async () => {
    const repository = makeRepository()
    const useCase = new GetAuctionDetail(repository, makeSellerProfile(), makeLogger())

    await expect(useCase.execute(playerAuction.id)).resolves.toEqual({
      auction: playerAuction,
      currentBid: null,
      bidCount: 0,
      sellerDisplayName: validProfile.displayName,
      sellerAvatarUrl: validProfile.avatarUrl,
    })
  })

  it('devuelve null cuando la subasta no existe y no consulta lider, total ni Account', async () => {
    const repository = makeRepository({ findDetailById: jest.fn().mockResolvedValue(null) })
    const sellerProfile = makeSellerProfile()

    const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())

    await expect(useCase.execute('auction-missing')).resolves.toBeNull()

    expect(repository.findLeadingBid).not.toHaveBeenCalled()
    expect(repository.countBids).not.toHaveBeenCalled()
    expect(sellerProfile.getPublicProfile).not.toHaveBeenCalled()
  })

  it('usa el total persistido aunque la puja lider sea una sola', async () => {
    const repository = makeRepository({
      findLeadingBid: jest.fn().mockResolvedValue(currentBid),
      countBids: jest.fn().mockResolvedValue(1),
    })

    const useCase = new GetAuctionDetail(repository, makeSellerProfile(), makeLogger())

    await expect(useCase.execute(playerAuction.id)).resolves.toMatchObject({ bidCount: 1 })
  })

  it('GAME_MASTER/REAL_MONEY: ya no devuelve null -el bug de toSnapshot esta corregido-', async () => {
    const repository = makeRepository({
      findDetailById: jest.fn().mockResolvedValue(officialAuction),
    })
    const useCase = new GetAuctionDetail(repository, makeSellerProfile(), makeLogger())
    const result = await useCase.execute(officialAuction.id)

    expect(result).not.toBeNull()
    expect(result?.auction).toEqual(officialAuction)
  })

  it('GAME_MASTER/REAL_MONEY: publisherType, priceKind, currency, officialMark y montos minor correctos', async () => {
    const repository = makeRepository({
      findDetailById: jest.fn().mockResolvedValue(officialAuction),
    })
    const useCase = new GetAuctionDetail(repository, makeSellerProfile(), makeLogger())
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
    const repository = makeRepository({
      findDetailById: jest.fn().mockResolvedValue(officialAuction),
    })

    const useCase = new GetAuctionDetail(repository, makeSellerProfile(), makeLogger())

    await expect(useCase.execute(officialAuction.id)).resolves.toMatchObject({
      currentBid: null,
      bidCount: 0,
    })
  })

  it('PLAYER/CREDITS: compatibilidad -campos previos (sellerId, minimumBidCredits, buyNowCredits, status) se conservan-', async () => {
    const repository = makeRepository()
    const useCase = new GetAuctionDetail(repository, makeSellerProfile(), makeLogger())
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

  describe('perfil publico del vendedor (HU-88)', () => {
    it('A. PLAYER + perfil valido: expone displayName y avatarUrl', async () => {
      const repository = makeRepository()
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest.fn().mockResolvedValue({
          subject: playerAuction.sellerId,
          displayName: 'Ana Ramirez',
          avatarUrl: '/accounts/seller-1/avatar',
        }),
      })

      const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())

      await expect(useCase.execute(playerAuction.id)).resolves.toMatchObject({
        sellerDisplayName: 'Ana Ramirez',
        sellerAvatarUrl: '/accounts/seller-1/avatar',
      })
    })

    it('B. PLAYER + avatar null: displayName presente, avatarUrl null', async () => {
      const repository = makeRepository()
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest.fn().mockResolvedValue({
          subject: playerAuction.sellerId,
          displayName: 'Ana Ramirez',
          avatarUrl: null,
        }),
      })

      const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())

      await expect(useCase.execute(playerAuction.id)).resolves.toMatchObject({
        sellerDisplayName: 'Ana Ramirez',
        sellerAvatarUrl: null,
      })
    })

    it('C. Account 404 (perfil ausente): detalle sigue en 200 con nulls y se registra el fallo', async () => {
      const repository = makeRepository()
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest
          .fn()
          .mockRejectedValue(new ExternalResourceNotFoundError('account', playerAuction.sellerId)),
      })
      const logger = makeLogger()

      const useCase = new GetAuctionDetail(repository, sellerProfile, logger)
      const result = await useCase.execute(playerAuction.id)

      expect(result).not.toBeNull()
      expect(result).toMatchObject({ sellerDisplayName: null, sellerAvatarUrl: null })
      expect(logger.warn).toHaveBeenCalledWith(
        'seller_public_profile_degradado',
        expect.objectContaining({ reason: 'ExternalResourceNotFoundError' }),
      )
    })

    it('D. Account 5xx / dependencia no disponible: detalle sigue en 200 con nulls', async () => {
      const repository = makeRepository()
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest
          .fn()
          .mockRejectedValue(new ExternalDependencyUnavailableError('account')),
      })
      const logger = makeLogger()

      const useCase = new GetAuctionDetail(repository, sellerProfile, logger)
      const result = await useCase.execute(playerAuction.id)

      expect(result).not.toBeNull()
      expect(result).toMatchObject({ sellerDisplayName: null, sellerAvatarUrl: null })
      expect(logger.warn).toHaveBeenCalledWith(
        'seller_public_profile_degradado',
        expect.objectContaining({ reason: 'ExternalDependencyUnavailableError' }),
      )
    })

    it('E. contrato invalido de Account: detalle sigue en 200 con nulls', async () => {
      const repository = makeRepository()
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest
          .fn()
          .mockRejectedValue(new ExternalContractError('account', 'perfil ininteligible')),
      })
      const logger = makeLogger()

      const useCase = new GetAuctionDetail(repository, sellerProfile, logger)
      const result = await useCase.execute(playerAuction.id)

      expect(result).not.toBeNull()
      expect(result).toMatchObject({ sellerDisplayName: null, sellerAvatarUrl: null })
      expect(logger.warn).toHaveBeenCalledWith(
        'seller_public_profile_degradado',
        expect.objectContaining({ reason: 'ExternalContractError' }),
      )
    })

    it('F. auction inexistente: sigue devolviendo null y no llama a Account', async () => {
      const repository = makeRepository({ findDetailById: jest.fn().mockResolvedValue(null) })
      const sellerProfile = makeSellerProfile()

      const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())

      await expect(useCase.execute('auction-missing')).resolves.toBeNull()
      expect(sellerProfile.getPublicProfile).not.toHaveBeenCalled()
    })

    it('G. GAME_MASTER con perfil resoluble: mapea displayName/avatarUrl igual que PLAYER', async () => {
      const repository = makeRepository({
        findDetailById: jest.fn().mockResolvedValue(officialAuction),
      })
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest.fn().mockResolvedValue({
          subject: officialAuction.sellerId,
          displayName: 'UPB Company',
          avatarUrl: null,
        }),
      })

      const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())

      await expect(useCase.execute(officialAuction.id)).resolves.toMatchObject({
        sellerDisplayName: 'UPB Company',
        sellerAvatarUrl: null,
      })
      expect(sellerProfile.getPublicProfile).toHaveBeenCalledWith(officialAuction.sellerId)
    })

    it('G. GAME_MASTER sin perfil resoluble: degrada a nulls, sin inventar "Game Master"/"Official Seller"', async () => {
      const repository = makeRepository({
        findDetailById: jest.fn().mockResolvedValue(officialAuction),
      })
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest
          .fn()
          .mockRejectedValue(
            new ExternalResourceNotFoundError('account', officialAuction.sellerId),
          ),
      })

      const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())
      const result = await useCase.execute(officialAuction.id)

      expect(result).not.toBeNull()
      expect(result).toMatchObject({ sellerDisplayName: null, sellerAvatarUrl: null })
      expect(result?.sellerDisplayName).not.toBe('Game Master')
      expect(result?.sellerDisplayName).not.toBe('Official Seller')
    })

    it('H. un error que NO es de dependencia externa se propaga -no se traga por error-', async () => {
      const repository = makeRepository()
      const sellerProfile = makeSellerProfile({
        getPublicProfile: jest.fn().mockRejectedValue(new Error('bug interno inesperado')),
      })

      const useCase = new GetAuctionDetail(repository, sellerProfile, makeLogger())

      await expect(useCase.execute(playerAuction.id)).rejects.toThrow('bug interno inesperado')
    })
  })
})
