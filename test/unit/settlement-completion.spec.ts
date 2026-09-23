import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { AuctionSettlementStatus } from '../../src/application/ports/AuctionSettlementRepositoryPort'

const now = new Date('2026-10-01T00:00:00.000Z')
const winner = {
  auctionId: 'auction-winner',
  resultType: 'WITH_WINNER' as const,
  sellerId: 'seller',
  winningBidId: 'bid',
  winnerId: 'winner',
  winningHoldId: 'hold',
  finalAmountCredits: 30,
  captureOperationId: 'capture',
  createdAt: now,
}
describe('completion InMemory', () => {
  it('crea claim durable WITH_WINNER y el replay no lo duplica', async () => {
    const claims = new InMemoryAuctionPendingClaimRepository()
    const settlements = new InMemoryAuctionSettlementRepository(claims)
    await settlements.createIfAbsent(winner)
    await settlements.markCaptureConfirmed(winner.auctionId, now)
    const input = {
      auctionId: winner.auctionId,
      resultType: 'WITH_WINNER' as const,
      productId: 'product',
      winnerId: 'winner',
      winningBidId: 'bid',
      finalAmountCredits: 30,
      settledAt: now,
    }
    const first = await settlements.completeSettlement(input)
    const replay = await settlements.completeSettlement(input)
    expect(first).toMatchObject({ status: AuctionSettlementStatus.Completed, settledAt: now })
    expect(replay).toEqual(first)
    await expect(claims.findByAuctionId(winner.auctionId)).resolves.toMatchObject({
      auctionId: winner.auctionId,
      winnerId: 'winner',
      productId: 'product',
      winningBidId: 'bid',
      finalAmountCredits: 30,
      settledAt: now,
      claimStatus: 'PENDING',
      claimedAt: null,
    })
  })
  it('completa WITHOUT_BIDS sin claim', async () => {
    const claims = new InMemoryAuctionPendingClaimRepository()
    const settlements = new InMemoryAuctionSettlementRepository(claims)
    await settlements.createIfAbsent({
      auctionId: 'empty',
      resultType: 'WITHOUT_BIDS',
      sellerId: 'seller',
      createdAt: now,
    })
    await expect(
      settlements.completeSettlement({
        auctionId: 'empty',
        resultType: 'WITHOUT_BIDS',
        productId: 'product',
        settledAt: now,
      }),
    ).resolves.toMatchObject({ status: AuctionSettlementStatus.Completed, settledAt: now })
    await expect(claims.findByAuctionId('empty')).resolves.toBeNull()
  })
})
