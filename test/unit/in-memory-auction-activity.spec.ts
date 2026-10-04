import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'

const publish = async (
  repository: InMemoryAuctionRepository,
  auctionId: string,
  sellerId: string,
  operationId: string,
) =>
  repository.publish({
    operationId,
    auction: Auction.publish({
      auctionId,
      sellerId,
      productId: `product-${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      publishedAt: new Date('2026-10-03T10:00:00.000Z'),
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    }),
    inventoryCommitmentId: `inventory-${auctionId}`,
    feeChargeId: `fee-${auctionId}`,
  })

describe('InMemoryAuctionRepository - lecturas HU-89', () => {
  it('aísla publicaciones y transacciones por vendedor', async () => {
    const repository = new InMemoryAuctionRepository()
    await publish(repository, 'auction-a', 'seller-a', 'publication-a')
    await publish(repository, 'auction-b', 'seller-b', 'publication-b')

    await expect(
      repository.listOwnedAuctions({
        playerId: 'seller-a',
        page: 1,
        pageSize: 16,
        now: new Date('2026-10-03T11:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ total: 1, items: [{ auctionId: 'auction-a' }] })
    await expect(
      repository.listTransactions({ playerId: 'seller-a', page: 1, pageSize: 16 }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ type: 'PUBLICATION_FEE', reference: 'publication-a' }],
    })
  })

  it('distingue una puja superada sin exponer al pujador líder', async () => {
    const repository = new InMemoryAuctionRepository()
    await publish(repository, 'auction-1', 'seller', 'publication')
    const first = Bid.register({
      bidId: 'bid-a',
      auctionId: 'auction-1',
      bidderId: 'player-a',
      amountCredits: 20,
      placedAt: new Date('2026-10-03T10:01:00.000Z'),
      eligibility: {
        auctionStatus: 'ACTIVE',
        sellerId: 'seller',
        currentBidCredits: null,
        minimumIncrementCredits: 10,
        lastBidAtByBidder: null,
        activeBidCount: 0,
      },
    })
    const second = Bid.register({
      bidId: 'bid-b',
      auctionId: 'auction-1',
      bidderId: 'player-b',
      amountCredits: 30,
      placedAt: new Date('2026-10-03T10:02:00.000Z'),
      eligibility: {
        auctionStatus: 'ACTIVE',
        sellerId: 'seller',
        currentBidCredits: 20,
        minimumIncrementCredits: 10,
        lastBidAtByBidder: null,
        activeBidCount: 0,
      },
    })
    await repository.persistBid(first)
    await repository.persistBid(second)

    const result = await repository.listBidParticipations({
      playerId: 'player-a',
      page: 1,
      pageSize: 16,
    })
    expect(result).toMatchObject({
      total: 1,
      items: [
        {
          auctionId: 'auction-1',
          participationStatus: 'OUTBID',
          ownLatestBidCredits: 20,
          currentBidCredits: 30,
        },
      ],
    })
    expect(result.items[0]).not.toHaveProperty('bidderId')
    expect(result.items[0]).not.toHaveProperty('leaderBidderId')
  })
})
