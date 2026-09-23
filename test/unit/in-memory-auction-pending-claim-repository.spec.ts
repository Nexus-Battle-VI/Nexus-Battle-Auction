import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'

const at = (value: string) => new Date(value)
const claim = (auctionId = 'auction-1', patch = {}) => ({
  auctionId,
  winnerId: 'winner-1',
  productId: 'product-1',
  winningBidId: 'bid-1',
  finalAmountCredits: 30,
  settledAt: at('2026-10-01T12:00:00.000Z'),
  createdAt: at('2026-10-01T12:01:00.000Z'),
  ...patch,
})

describe('InMemoryAuctionPendingClaimRepository', () => {
  it.each([
    ['winnerId', 'winner-2'],
    ['productId', 'product-2'],
    ['winningBidId', 'bid-2'],
    ['finalAmountCredits', 31],
    ['settledAt', at('2026-10-02T12:00:00.000Z')],
  ])('rechaza replay con %s distinto', async (key, value) => {
    const repository = new InMemoryAuctionPendingClaimRepository()
    await repository.createIfAbsent(claim())
    await expect(repository.createIfAbsent(claim('auction-1', { [key]: value }))).rejects.toThrow(
      'Conflicto de intent',
    )
  })
  it('crea, reproduce identicamente y consulta por subasta', async () => {
    const repository = new InMemoryAuctionPendingClaimRepository()
    const first = await repository.createIfAbsent(claim())
    const replay = await repository.createIfAbsent(
      claim('auction-1', { createdAt: at('2027-01-01T00:00:00.000Z') }),
    )
    expect(replay).toEqual(first)
    first.settledAt.setFullYear(2000)
    await expect(repository.findByAuctionId('auction-1')).resolves.toMatchObject({
      claimStatus: 'PENDING',
      settledAt: at('2026-10-01T12:00:00.000Z'),
    })
  })
  it('devuelve pendientes ordenados por settledAt DESC y auctionId', async () => {
    const repository = new InMemoryAuctionPendingClaimRepository()
    await repository.createIfAbsent(
      claim('auction-b', { settledAt: at('2026-10-02T00:00:00.000Z') }),
    )
    await repository.createIfAbsent(
      claim('auction-a', { settledAt: at('2026-10-02T00:00:00.000Z') }),
    )
    await repository.createIfAbsent(claim('auction-old'))
    await repository.createIfAbsent(claim('auction-other', { winnerId: 'other' }))
    await expect(repository.findPendingByWinnerId('winner-1')).resolves.toMatchObject([
      { auctionId: 'auction-a' },
      { auctionId: 'auction-b' },
      { auctionId: 'auction-old' },
    ])
  })
})
