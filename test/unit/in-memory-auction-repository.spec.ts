import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import {
  BidAlreadyExistsError,
  IdempotencyConflictError,
} from '../../src/application/errors/AuctionPersistenceError'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'

const command = (auctionId: string, operationId = 'operation-1', minimumBidCredits = 10) => ({
  operationId,
  auction: Auction.publish({
    auctionId,
    sellerId: 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits,
    publishedAt: new Date('2026-09-21T12:00:00.000Z'),
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  }),
  inventoryCommitmentId: 'commitment-1',
  feeChargeId: 'charge-1',
})

const bid = (
  bidId: string,
  auctionId: string,
  bidderId: string,
  amountCredits: number,
  placedAt: Date,
  currentBidCredits: number | null,
) =>
  Bid.register({
    bidId,
    auctionId,
    bidderId,
    amountCredits,
    placedAt,
    eligibility: {
      auctionStatus: 'ACTIVE',
      sellerId: 'seller-1',
      currentBidCredits,
      minimumIncrementCredits: 10,
      lastBidAtByBidder: null,
      activeBidCount: 0,
    },
  })

describe('InMemoryAuctionRepository', () => {
  it('reproduce la misma publicacion ante un reintento con datos generados distintos', async () => {
    const repository = new InMemoryAuctionRepository()

    await expect(repository.publish(command('auction-first'))).resolves.toMatchObject({
      replayed: false,
    })

    await expect(repository.publish(command('auction-regenerated'))).resolves.toMatchObject({
      replayed: true,
      auction: {
        id: 'auction-first',
      },
    })

    await expect(repository.findById('auction-first')).resolves.toMatchObject({
      id: 'auction-first',
    })
  })

  it('rechaza reutilizar la operacion con otra intencion funcional', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish(command('auction-first'))

    await expect(
      repository.publish(command('auction-second', 'operation-1', 11)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('persiste la primera puja como lider', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish(command('auction-bids'))

    const firstBid = bid(
      'bid-1',
      'auction-bids',
      'bidder-1',
      20,
      new Date('2026-09-21T12:00:10.000Z'),
      null,
    )

    await expect(repository.persistBid(firstBid)).resolves.toEqual({
      bid: firstBid.snapshot(),
      previousLeader: null,
      previousLeaderReservationId: null,
    })

    await expect(repository.findLeadingBid('auction-bids')).resolves.toEqual(firstBid.snapshot())
  })

  it('reemplaza el lider y conserva el historial de pujas', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish(command('auction-history'))

    const firstBid = bid(
      'bid-history-1',
      'auction-history',
      'bidder-1',
      20,
      new Date('2026-09-21T12:00:10.000Z'),
      null,
    )

    const secondBid = bid(
      'bid-history-2',
      'auction-history',
      'bidder-2',
      30,
      new Date('2026-09-21T12:00:20.000Z'),
      20,
    )

    await repository.persistBid(firstBid)

    await expect(repository.persistBid(secondBid)).resolves.toEqual({
      bid: secondBid.snapshot(),
      previousLeader: firstBid.snapshot(),
      previousLeaderReservationId: null,
    })

    await expect(repository.findLeadingBid('auction-history')).resolves.toEqual(
      secondBid.snapshot(),
    )

    await expect(repository.findBidHistory('auction-history')).resolves.toEqual([
      firstBid.snapshot(),
      secondBid.snapshot(),
    ])
  })

  it('conserva la reserva de creditos del lider anterior', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish(command('auction-reservations'))

    const firstBid = bid(
      'bid-reservation-1',
      'auction-reservations',
      'bidder-1',
      20,
      new Date('2026-09-21T12:00:10.000Z'),
      null,
    )

    const secondBid = bid(
      'bid-reservation-2',
      'auction-reservations',
      'bidder-2',
      30,
      new Date('2026-09-21T12:00:20.000Z'),
      20,
    )

    await repository.persistBid(firstBid, 'reservation-first')

    await expect(repository.persistBid(secondBid, 'reservation-second')).resolves.toEqual({
      bid: secondBid.snapshot(),
      previousLeader: firstBid.snapshot(),
      previousLeaderReservationId: 'reservation-first',
    })
  })

  it('rechaza una puja con identificador duplicado', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish(command('auction-duplicate'))

    const firstBid = bid(
      'bid-duplicate',
      'auction-duplicate',
      'bidder-1',
      20,
      new Date('2026-09-21T12:00:10.000Z'),
      null,
    )

    await repository.persistBid(firstBid)

    await expect(repository.persistBid(firstBid)).rejects.toBeInstanceOf(BidAlreadyExistsError)
  })
})
