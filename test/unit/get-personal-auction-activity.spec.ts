import type {
  AuctionActivityRepositoryPort,
  PersonalAuctionPage,
  PersonalBidPage,
} from '../../src/application/ports/AuctionActivityRepositoryPort'
import { GetMyAuctionActivity } from '../../src/application/use-cases/GetMyAuctionActivity'

describe('GetMyAuctionActivity', () => {
  const owned: PersonalAuctionPage = { items: [], total: 0 }
  const bids: PersonalBidPage = { items: [], total: 0 }
  const repository: jest.Mocked<AuctionActivityRepositoryPort> = {
    listOwnedAuctions: jest.fn().mockResolvedValue(owned),
    listBidParticipations: jest.fn().mockResolvedValue(bids),
    listTransactions: jest.fn(),
  }
  const clock = { now: jest.fn(() => new Date('2026-10-03T12:00:00.000Z')) }
  const useCase = new GetMyAuctionActivity(repository, clock)

  beforeEach(() => jest.clearAllMocks())

  it('consulta subastas propias usando exclusivamente el sujeto autenticado', async () => {
    await expect(useCase.listOwned({ playerId: 'player-a', page: 2, pageSize: 10 })).resolves.toBe(
      owned,
    )

    expect(repository.listOwnedAuctions).toHaveBeenCalledWith({
      playerId: 'player-a',
      page: 2,
      pageSize: 10,
      now: new Date('2026-10-03T12:00:00.000Z'),
    })
  })

  it('consulta solo las participaciones del sujeto autenticado', async () => {
    await expect(useCase.listBids({ playerId: 'player-b', page: 1, pageSize: 16 })).resolves.toBe(
      bids,
    )

    expect(repository.listBidParticipations).toHaveBeenCalledWith({
      playerId: 'player-b',
      page: 1,
      pageSize: 16,
    })
  })
})
