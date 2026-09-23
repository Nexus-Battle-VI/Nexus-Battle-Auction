import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { CLAIM_PERIOD_MS } from '../../src/domain/entities/AuctionPendingClaim'
import { AuctionPendingClaimRuleCode } from '../../src/domain/errors/AuctionPendingClaimRuleViolation'

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

  describe('markClaimed', () => {
    it('transiciona PENDING a CLAIMED dentro del plazo', async () => {
      const repository = new InMemoryAuctionPendingClaimRepository()
      await repository.createIfAbsent(claim())
      const claimedAt = at('2026-10-02T12:00:00.000Z')

      await expect(repository.markClaimed('auction-1', claimedAt)).resolves.toMatchObject({
        claimStatus: 'CLAIMED',
        claimedAt,
      })
      await expect(repository.findByAuctionId('auction-1')).resolves.toMatchObject({
        claimStatus: 'CLAIMED',
        claimedAt,
      })
    })

    it('acepta el limite exacto del dia 7 (inclusive)', async () => {
      const repository = new InMemoryAuctionPendingClaimRepository()
      const settledAt = at('2026-10-01T12:00:00.000Z')
      await repository.createIfAbsent(claim('auction-1', { settledAt }))
      const deadline = new Date(settledAt.getTime() + CLAIM_PERIOD_MS)

      await expect(repository.markClaimed('auction-1', deadline)).resolves.toMatchObject({
        claimStatus: 'CLAIMED',
      })
    })

    it('rechaza un reclamo despues del plazo de siete dias', async () => {
      const repository = new InMemoryAuctionPendingClaimRepository()
      const settledAt = at('2026-10-01T12:00:00.000Z')
      await repository.createIfAbsent(claim('auction-1', { settledAt }))
      const pastDeadline = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)

      await expect(repository.markClaimed('auction-1', pastDeadline)).rejects.toMatchObject({
        code: AuctionPendingClaimRuleCode.ClaimDeadlineExpired,
      })
      await expect(repository.findByAuctionId('auction-1')).resolves.toMatchObject({
        claimStatus: 'PENDING',
      })
    })

    it('rechaza un segundo reclamo sobre un pending-claim ya CLAIMED', async () => {
      const repository = new InMemoryAuctionPendingClaimRepository()
      await repository.createIfAbsent(claim())
      await repository.markClaimed('auction-1', at('2026-10-02T12:00:00.000Z'))

      await expect(
        repository.markClaimed('auction-1', at('2026-10-03T12:00:00.000Z')),
      ).rejects.toMatchObject({
        code: AuctionPendingClaimRuleCode.AlreadyClaimed,
      })
    })

    it('rechaza un auctionId sin pending-claim', async () => {
      const repository = new InMemoryAuctionPendingClaimRepository()

      await expect(
        repository.markClaimed('auction-missing', at('2026-10-02T12:00:00.000Z')),
      ).rejects.toThrow('No existe pending-claim')
    })
  })
})
