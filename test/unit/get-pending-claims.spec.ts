import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { GetPendingClaims } from '../../src/application/use-cases/GetPendingClaims'

describe('GetPendingClaims', () => {
  it('delega en findPendingByWinnerId sin reinterpretar el resultado', async () => {
    const repository = new InMemoryAuctionPendingClaimRepository()
    await repository.createIfAbsent({
      auctionId: 'auction-1',
      winnerId: 'winner-1',
      productId: 'product-1',
      winningBidId: 'bid-1',
      finalAmountCredits: 30,
      settledAt: new Date('2026-09-20T12:00:00.000Z'),
      createdAt: new Date('2026-09-20T12:00:00.000Z'),
    })
    await repository.createIfAbsent({
      auctionId: 'auction-2',
      winnerId: 'winner-2',
      productId: 'product-2',
      winningBidId: 'bid-2',
      finalAmountCredits: 40,
      settledAt: new Date('2026-09-20T12:00:00.000Z'),
      createdAt: new Date('2026-09-20T12:00:00.000Z'),
    })
    const useCase = new GetPendingClaims(repository)

    await expect(useCase.execute('winner-1')).resolves.toEqual([
      expect.objectContaining({ auctionId: 'auction-1', winnerId: 'winner-1' }),
    ])
  })

  it('devuelve un array vacio cuando el titular no tiene pendientes', async () => {
    const repository = new InMemoryAuctionPendingClaimRepository()
    const useCase = new GetPendingClaims(repository)

    await expect(useCase.execute('winner-sin-pendientes')).resolves.toEqual([])
  })
})
