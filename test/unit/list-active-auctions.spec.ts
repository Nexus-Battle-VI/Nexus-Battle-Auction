import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ListActiveAuctions } from '../../src/application/use-cases/ListActiveAuctions'
import { Auction } from '../../src/domain/entities/Auction'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import { Bid } from '../../src/domain/entities/Bid'
import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
} from '../../src/domain/entities/OfficialAuction'
import { AuctionPriceKind } from '../../src/domain/value-objects/AuctionPublicationPricing'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }

const publish = async (repository: InMemoryAuctionRepository, id: string, closesAt: Date) => {
  const publishedAt = new Date(closesAt.getTime() - 24 * 60 * 60 * 1000)
  await repository.publish({
    operationId: `publish-${id}`,
    auction: Auction.publish({
      auctionId: id,
      sellerId: `seller-${id}`,
      productId: `product-${id}`,
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
    inventoryCommitmentId: `commitment-${id}`,
    feeChargeId: `fee-${id}`,
  })
}

const bid = async (
  repository: InMemoryAuctionRepository,
  auctionId: string,
  amountCredits: number,
  bidId = `bid-${auctionId}`,
) =>
  repository.persistBid(
    Bid.register({
      bidId,
      auctionId,
      bidderId: 'bidder-1',
      amountCredits,
      placedAt: now,
      eligibility: {
        auctionStatus: 'ACTIVE',
        sellerId: `seller-${auctionId}`,
        currentBidCredits: null,
        minimumIncrementCredits: 1,
        lastBidAtByBidder: null,
        activeBidCount: 0,
      },
    }),
  )

const publishOfficial = async (
  repository: InMemoryAuctionRepository,
  id: string,
  closesAt: Date,
  mark = OfficialAuctionMark.Official,
) => {
  const publishedAt = new Date(closesAt.getTime() - 24 * 60 * 60 * 1000)
  await repository.publishOfficial({
    operationId: `publish-${id}`,
    auction: OfficialAuction.publish({
      auctionId: id,
      publisherId: 'upb-company',
      publisherType: AuctionPublisherType.GameMaster,
      productId: `product-${id}`,
      durationHours: 24,
      pricing: {
        kind: AuctionPriceKind.RealMoney,
        minimumBid: { amountMinor: 90_000, currency: 'COP' },
        buyNow: { amountMinor: 120_000, currency: 'COP' },
      },
      mark,
      publishedAt,
    }),
  })
}

describe('ListActiveAuctions', () => {
  it('devuelve una pagina vacia cuando no hay activas disponibles', async () => {
    await expect(
      new ListActiveAuctions(new InMemoryAuctionRepository(), clock).execute({
        page: 1,
        pageSize: 16,
      }),
    ).resolves.toEqual({ items: [], total: 0 })
  })

  it('filtra, ordena, pagina y expone solo el importe de la puja lider', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = new ListActiveAuctions(repository, clock)
    await publish(repository, 'same-b', new Date(now.getTime() + 2_000))
    await publish(repository, 'expired', now)
    await publish(repository, 'first', new Date(now.getTime() + 1_000))
    await publish(repository, 'same-a', new Date(now.getTime() + 2_000))
    await bid(repository, 'same-a', 30)
    await repository.finishAuction({
      auctionId: 'same-b',
      finishedAt: now,
      closingResult: AuctionClosingResult.withoutBids(now),
    })

    await expect(useCase.execute({ page: 1, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'first', currentBidAmount: null, bidCount: 0 }],
    })
    await expect(useCase.execute({ page: 2, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'same-a', currentBidAmount: 30, status: 'ACTIVE', bidCount: 1 }],
    })
  })

  it('prioriza GAME_MASTER y mantiene cierre e id como desempates antes de paginar', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = new ListActiveAuctions(repository, clock)
    await publish(repository, 'player-first-closing', new Date(now.getTime() + 1_000))
    await publishOfficial(repository, 'official-b', new Date(now.getTime() + 3_000))
    await publishOfficial(
      repository,
      'official-a',
      new Date(now.getTime() + 3_000),
      OfficialAuctionMark.Premium,
    )

    await expect(useCase.execute({ page: 1, pageSize: 2 })).resolves.toMatchObject({
      total: 3,
      items: [
        {
          id: 'official-a',
          publisherType: 'GAME_MASTER',
          priceKind: 'REAL_MONEY',
          currency: 'COP',
          officialMark: 'PREMIUM',
          minimumBidAmountMinor: 90_000,
          bidCount: 0,
        },
        {
          id: 'official-b',
          publisherType: 'GAME_MASTER',
          officialMark: 'OFFICIAL',
          bidCount: 0,
        },
      ],
    })
    await expect(useCase.execute({ page: 2, pageSize: 2 })).resolves.toMatchObject({
      total: 3,
      items: [
        {
          id: 'player-first-closing',
          publisherType: 'PLAYER',
          priceKind: 'CREDITS',
          minimumBidCredits: 10,
          officialMark: null,
        },
      ],
    })
  })

  it('devuelve el total real de pujas persistidas de cada subasta del listado', async () => {
    const repository = new InMemoryAuctionRepository()
    const useCase = new ListActiveAuctions(repository, clock)
    await publish(repository, 'no-bids', new Date(now.getTime() + 1_000))
    await publish(repository, 'one-bid', new Date(now.getTime() + 2_000))
    await publish(repository, 'many-bids', new Date(now.getTime() + 3_000))
    await bid(repository, 'one-bid', 15)
    await bid(repository, 'many-bids', 20, 'many-bids-1')
    await bid(repository, 'many-bids', 30, 'many-bids-2')
    await bid(repository, 'many-bids', 40, 'many-bids-3')

    await expect(useCase.execute({ page: 1, pageSize: 16 })).resolves.toMatchObject({
      total: 3,
      items: [
        { id: 'no-bids', bidCount: 0, currentBidAmount: null },
        { id: 'one-bid', bidCount: 1, currentBidAmount: 15 },
        { id: 'many-bids', bidCount: 3, currentBidAmount: 40 },
      ],
    })
    await expect(repository.countBids('no-bids')).resolves.toBe(0)
    await expect(repository.countBids('one-bid')).resolves.toBe(1)
    await expect(repository.countBids('many-bids')).resolves.toBe(3)
  })
})
