import type {
  AuctionActivityRepositoryPort,
  PersonalTransactionPage,
} from '../../src/application/ports/AuctionActivityRepositoryPort'
import { GetMyAuctionTransactions } from '../../src/application/use-cases/GetMyAuctionTransactions'

describe('GetMyAuctionTransactions', () => {
  it('delega el historial paginado con la identidad autenticada', async () => {
    const result: PersonalTransactionPage = { items: [], total: 0 }
    const repository: jest.Mocked<AuctionActivityRepositoryPort> = {
      listOwnedAuctions: jest.fn(),
      listBidParticipations: jest.fn(),
      listTransactions: jest.fn().mockResolvedValue(result),
    }

    await expect(
      new GetMyAuctionTransactions(repository).execute({
        playerId: 'player-a',
        page: 3,
        pageSize: 20,
      }),
    ).resolves.toBe(result)

    expect(repository.listTransactions).toHaveBeenCalledWith({
      playerId: 'player-a',
      page: 3,
      pageSize: 20,
    })
  })
})
