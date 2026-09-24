import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import { PersistedAuctionNotFoundError } from '../../src/application/errors/AuctionPersistenceError'
import { ConfigureAutoBid } from '../../src/application/use-cases/ConfigureAutoBid'
import { AuctionStatus, type AuctionSnapshot } from '../../src/domain/entities/Auction'
import type { AutoBidConfig, AutoBidConfigSnapshot } from '../../src/domain/entities/AutoBidConfig'
import { AutoBidRuleCode, AutoBidRuleViolation } from '../../src/domain/errors/AutoBidRuleViolation'

const now = new Date('2026-09-21T12:00:00.000Z')

const auction: AuctionSnapshot = {
  id: 'auction-67-5',
  sellerId: 'seller-1',
  productId: 'product-1',
  durationHours: 24,
  publicationFeeCredits: 1,
  minimumBidCredits: 10,
  buyNowCredits: null,
  status: AuctionStatus.Active,
  publishedAt: new Date('2026-09-21T11:00:00.000Z'),
  closesAt: new Date('2026-09-22T11:00:00.000Z'),
}

const dependencies = () => {
  const repository = {
    findById: jest.fn(() => Promise.resolve<AuctionSnapshot | null>(auction)),

    saveAutoBidConfig: jest.fn((config: AutoBidConfig) => Promise.resolve(config.snapshot())),
  } as unknown as jest.Mocked<AuctionRepositoryPort>

  const clock = { now: (): Date => new Date(now) }

  const useCase = new ConfigureAutoBid(repository, clock)

  return { repository, clock, useCase }
}

describe('ConfigureAutoBid HU-67.5', () => {
  it('guarda una configuracion valida y retorna el snapshot persistido', async () => {
    const { repository, useCase } = dependencies()

    const result = await useCase.execute({
      auctionId: auction.id,
      bidderId: 'bidder-1',
      maxAmountCredits: 100,
    })

    expect(result).toEqual<AutoBidConfigSnapshot>({
      auctionId: auction.id,
      bidderId: 'bidder-1',
      maxAmountCredits: 100,
      configuredAt: now,
      isActive: true,
    })

    expect(repository.saveAutoBidConfig).toHaveBeenCalledTimes(1)
  })

  it('rechaza una subasta inexistente antes de validar el dominio', async () => {
    const { repository, useCase } = dependencies()

    repository.findById.mockResolvedValueOnce(null)

    await expect(
      useCase.execute({
        auctionId: 'auction-missing',
        bidderId: 'bidder-1',
        maxAmountCredits: 100,
      }),
    ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)

    expect(repository.saveAutoBidConfig).not.toHaveBeenCalled()
  })

  it('rechaza configurar sobre una subasta ya vencida aunque el estado persistido diga ACTIVE', async () => {
    const { repository, useCase } = dependencies()

    repository.findById.mockResolvedValueOnce({
      ...auction,
      closesAt: new Date('2026-09-21T11:59:59.000Z'),
    })

    await expect(
      useCase.execute({ auctionId: auction.id, bidderId: 'bidder-1', maxAmountCredits: 100 }),
    ).rejects.toMatchObject({ code: AutoBidRuleCode.AuctionNotActive })

    expect(repository.saveAutoBidConfig).not.toHaveBeenCalled()
  })

  it('rechaza que el vendedor configure en su propia subasta', async () => {
    const { repository, useCase } = dependencies()

    await expect(
      useCase.execute({
        auctionId: auction.id,
        bidderId: auction.sellerId,
        maxAmountCredits: 100,
      }),
    ).rejects.toMatchObject({ code: AutoBidRuleCode.SellerCannotConfigure })

    expect(repository.saveAutoBidConfig).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5])('rechaza un limite maximo invalido %s', async (maxAmountCredits) => {
    const { repository, useCase } = dependencies()

    await expect(
      useCase.execute({ auctionId: auction.id, bidderId: 'bidder-1', maxAmountCredits }),
    ).rejects.toBeInstanceOf(AutoBidRuleViolation)

    expect(repository.saveAutoBidConfig).not.toHaveBeenCalled()
  })

  it('reconfigurar delega el upsert al repositorio con el nuevo limite', async () => {
    const { repository, useCase } = dependencies()

    await useCase.execute({ auctionId: auction.id, bidderId: 'bidder-1', maxAmountCredits: 100 })

    await useCase.execute({ auctionId: auction.id, bidderId: 'bidder-1', maxAmountCredits: 250 })

    expect(repository.saveAutoBidConfig).toHaveBeenCalledTimes(2)

    const secondCall = repository.saveAutoBidConfig.mock.calls[1]?.[0]

    expect(secondCall?.snapshot().maxAmountCredits).toBe(250)
  })
})
