import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import {
  BidAlreadyExistsError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import { Auction } from '../../src/domain/entities/Auction'
import { AutoBidConfig } from '../../src/domain/entities/AutoBidConfig'
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

const autoBidConfig = (
  auctionId: string,
  bidderId: string,
  maxAmountCredits: number,
  configuredAt: Date,
) =>
  AutoBidConfig.configure({
    auctionId,
    bidderId,
    maxAmountCredits,
    configuredAt,
    eligibility: {
      auctionStatus: 'ACTIVE',
      sellerId: 'seller-1',
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

  describe('configuracion de puja automatica (HU-67.4)', () => {
    it('rechaza configurar sobre una subasta que no existe', async () => {
      const repository = new InMemoryAuctionRepository()

      await expect(
        repository.saveAutoBidConfig(
          autoBidConfig('auction-missing', 'bidder-1', 100, new Date('2026-09-21T12:00:00Z')),
        ),
      ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)
    })

    it('guarda y recupera una configuracion nueva', async () => {
      const repository = new InMemoryAuctionRepository()

      await repository.publish(command('auction-auto-bid'))

      const config = autoBidConfig(
        'auction-auto-bid',
        'bidder-1',
        100,
        new Date('2026-09-21T12:00:00Z'),
      )

      await expect(repository.saveAutoBidConfig(config)).resolves.toEqual(config.snapshot())

      await expect(repository.findAutoBidConfig('auction-auto-bid', 'bidder-1')).resolves.toEqual(
        config.snapshot(),
      )
    })

    it('retorna null cuando no existe configuracion para ese jugador', async () => {
      const repository = new InMemoryAuctionRepository()

      await repository.publish(command('auction-auto-bid-empty'))

      await expect(
        repository.findAutoBidConfig('auction-auto-bid-empty', 'bidder-1'),
      ).resolves.toBeNull()
    })

    it('reconfigurar sobrescribe el limite anterior del mismo jugador', async () => {
      const repository = new InMemoryAuctionRepository()

      await repository.publish(command('auction-auto-bid-reconfig'))

      await repository.saveAutoBidConfig(
        autoBidConfig(
          'auction-auto-bid-reconfig',
          'bidder-1',
          100,
          new Date('2026-09-21T12:00:00Z'),
        ),
      )

      const updated = autoBidConfig(
        'auction-auto-bid-reconfig',
        'bidder-1',
        200,
        new Date('2026-09-21T12:05:00Z'),
      )

      await repository.saveAutoBidConfig(updated)

      await expect(
        repository.findAutoBidConfig('auction-auto-bid-reconfig', 'bidder-1'),
      ).resolves.toEqual(updated.snapshot())
    })

    it('findActiveAutoBidsForAuction excluye al postor indicado y otras subastas', async () => {
      const repository = new InMemoryAuctionRepository()

      await repository.publish(command('auction-auto-bid-active', 'operation-active'))
      await repository.publish(command('auction-auto-bid-other', 'operation-other'))

      await repository.saveAutoBidConfig(
        autoBidConfig('auction-auto-bid-active', 'bidder-1', 100, new Date('2026-09-21T12:00:00Z')),
      )
      await repository.saveAutoBidConfig(
        autoBidConfig('auction-auto-bid-active', 'bidder-2', 150, new Date('2026-09-21T12:01:00Z')),
      )
      await repository.saveAutoBidConfig(
        autoBidConfig('auction-auto-bid-other', 'bidder-3', 300, new Date('2026-09-21T12:02:00Z')),
      )

      const active = await repository.findActiveAutoBidsForAuction(
        'auction-auto-bid-active',
        'bidder-1',
      )

      expect(active).toHaveLength(1)
      expect(active[0]?.bidderId).toBe('bidder-2')
    })

    it('findActiveAutoBidsForAuction retorna vacio cuando no hay configuraciones', async () => {
      const repository = new InMemoryAuctionRepository()

      await repository.publish(command('auction-auto-bid-none'))

      await expect(
        repository.findActiveAutoBidsForAuction('auction-auto-bid-none', 'bidder-1'),
      ).resolves.toEqual([])
    })

    it('no expone referencia mutable de configuredAt', async () => {
      const repository = new InMemoryAuctionRepository()

      await repository.publish(command('auction-auto-bid-immutable'))

      await repository.saveAutoBidConfig(
        autoBidConfig(
          'auction-auto-bid-immutable',
          'bidder-1',
          100,
          new Date('2026-09-21T12:00:00Z'),
        ),
      )

      const first = await repository.findAutoBidConfig('auction-auto-bid-immutable', 'bidder-1')
      first?.configuredAt.setUTCFullYear(2030)

      const second = await repository.findAutoBidConfig('auction-auto-bid-immutable', 'bidder-1')
      expect(second?.configuredAt).toEqual(new Date('2026-09-21T12:00:00Z'))
    })
  })
})
