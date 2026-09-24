import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { AuctionSettlementStatus } from '../../src/application/ports/AuctionSettlementRepositoryPort'
import {
  AUCTION_SETTLED_EVENT_MAX_BYTES,
  AuctionSettledEventPayloadTooLargeError,
  createAuctionSettledEventV1,
} from '../../src/domain/events/AuctionSettledEventV1'

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
      loserBidderIds: [],
      settledAt: now,
      event: createAuctionSettledEventV1({
        auctionId: winner.auctionId,
        productId: 'product',
        sellerId: winner.sellerId,
        resultType: 'WITH_WINNER',
        winnerId: winner.winnerId,
        winningBidId: winner.winningBidId,
        finalAmountCredits: winner.finalAmountCredits,
        loserBidderIds: [],
        settledAt: now,
      }),
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
        event: createAuctionSettledEventV1({
          auctionId: 'empty',
          productId: 'product',
          sellerId: 'seller',
          resultType: 'WITHOUT_BIDS',
          settledAt: now,
        }),
      }),
    ).resolves.toMatchObject({ status: AuctionSettlementStatus.Completed, settledAt: now })
    await expect(claims.findByAuctionId('empty')).resolves.toBeNull()
  })

  it('mantiene la defensa de tamano al completar en memoria', async () => {
    const claims = new InMemoryAuctionPendingClaimRepository()
    const settlements = new InMemoryAuctionSettlementRepository(claims)
    await settlements.createIfAbsent({
      auctionId: 'oversized',
      resultType: 'WITHOUT_BIDS',
      sellerId: 'seller',
      createdAt: now,
    })
    const event = createAuctionSettledEventV1({
      auctionId: 'oversized',
      productId: 'product',
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt: now,
    })
    const oversized = {
      ...event,
      data: { ...event.data, productId: '\u00e1'.repeat(AUCTION_SETTLED_EVENT_MAX_BYTES) },
    }

    await expect(
      settlements.completeSettlement({
        auctionId: 'oversized',
        resultType: 'WITHOUT_BIDS',
        productId: 'product',
        settledAt: now,
        event: oversized,
      }),
    ).rejects.toBeInstanceOf(AuctionSettledEventPayloadTooLargeError)
    await expect(settlements.getByAuctionId('oversized')).resolves.toMatchObject({
      status: AuctionSettlementStatus.Pending,
    })
  })
})
