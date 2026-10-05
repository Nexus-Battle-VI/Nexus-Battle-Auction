import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'

const publish = async (
  repository: InMemoryAuctionRepository,
  auctionId: string,
  sellerId: string,
  operationId: string,
  publishedAt = new Date('2026-10-03T10:00:00.000Z'),
) =>
  repository.publish({
    operationId,
    auction: Auction.publish({
      auctionId,
      sellerId,
      productId: `product-${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      publishedAt,
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

  it('mantiene el aislamiento de publicaciones al paginar para dos usuarios', async () => {
    const repository = new InMemoryAuctionRepository()
    await publish(repository, 'auction-a-1', 'player-a', 'publication-a-1')
    await publish(
      repository,
      'auction-a-2',
      'player-a',
      'publication-a-2',
      new Date('2026-10-03T11:00:00.000Z'),
    )
    await publish(
      repository,
      'auction-a-3',
      'player-a',
      'publication-a-3',
      new Date('2026-10-03T12:00:00.000Z'),
    )
    await publish(repository, 'auction-b-1', 'player-b', 'publication-b-1')
    await publish(
      repository,
      'auction-b-2',
      'player-b',
      'publication-b-2',
      new Date('2026-10-03T11:00:00.000Z'),
    )

    const firstPageA = await repository.listOwnedAuctions({
      playerId: 'player-a',
      page: 1,
      pageSize: 2,
      now: new Date('2026-10-03T13:00:00.000Z'),
    })
    const secondPageA = await repository.listOwnedAuctions({
      playerId: 'player-a',
      page: 2,
      pageSize: 2,
      now: new Date('2026-10-03T13:00:00.000Z'),
    })
    const pageB = await repository.listOwnedAuctions({
      playerId: 'player-b',
      page: 1,
      pageSize: 16,
      now: new Date('2026-10-03T13:00:00.000Z'),
    })

    expect(firstPageA).toMatchObject({
      total: 3,
      items: [{ auctionId: 'auction-a-3' }, { auctionId: 'auction-a-2' }],
    })
    expect(secondPageA).toMatchObject({ total: 3, items: [{ auctionId: 'auction-a-1' }] })
    expect(pageB).toMatchObject({
      total: 2,
      items: [{ auctionId: 'auction-b-2' }, { auctionId: 'auction-b-1' }],
    })
    for (const item of [...firstPageA.items, ...secondPageA.items, ...pageB.items]) {
      expect(item).not.toHaveProperty('sellerId')
      expect(item).not.toHaveProperty('bidderId')
    }
  })

  it('devuelve únicamente operaciones persistidas asociadas al usuario autenticado', async () => {
    const repository = new InMemoryAuctionRepository()
    await publish(repository, 'auction-a', 'player-a', 'publication-a')
    await publish(repository, 'auction-b', 'player-b', 'publication-b')
    await publish(repository, 'auction-market', 'seller', 'publication-market')
    await repository.createBidCreditOperation({
      operationId: 'bid-operation-a',
      bidId: 'bid-a',
      auctionId: 'auction-market',
      bidderId: 'player-a',
      amountCredits: 20,
      createdAt: new Date('2026-10-03T11:00:00.000Z'),
    })
    await repository.createBidCreditOperation({
      operationId: 'bid-operation-b',
      bidId: 'bid-b',
      auctionId: 'auction-market',
      bidderId: 'player-b',
      amountCredits: 30,
      createdAt: new Date('2026-10-03T12:00:00.000Z'),
    })

    const historyA = await repository.listTransactions({
      playerId: 'player-a',
      page: 1,
      pageSize: 1,
    })
    const historyASecondPage = await repository.listTransactions({
      playerId: 'player-a',
      page: 2,
      pageSize: 1,
    })
    const historyB = await repository.listTransactions({
      playerId: 'player-b',
      page: 1,
      pageSize: 16,
    })

    expect(historyA.total).toBe(2)
    expect([...historyA.items, ...historyASecondPage.items].map((item) => item.reference)).toEqual([
      'bid-operation-a',
      'publication-a',
    ])
    expect(historyB).toMatchObject({
      total: 2,
      items: [{ reference: 'bid-operation-b' }, { reference: 'publication-b' }],
    })
    for (const item of [...historyA.items, ...historyASecondPage.items, ...historyB.items]) {
      expect(item).not.toHaveProperty('sellerId')
      expect(item).not.toHaveProperty('bidderId')
    }
  })
})
