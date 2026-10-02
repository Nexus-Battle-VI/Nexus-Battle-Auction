import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import {
  BidAlreadyExistsError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import { Auction } from '../../src/domain/entities/Auction'
import { AutoBidConfig } from '../../src/domain/entities/AutoBidConfig'
import { Bid } from '../../src/domain/entities/Bid'
import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
} from '../../src/domain/entities/OfficialAuction'
import { AuctionPriceKind } from '../../src/domain/value-objects/AuctionPublicationPricing'

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

const officialCommand = (
  auctionId: string,
  operationId = 'operation-1',
  minimumBidAmountMinor = 150_000,
) => ({
  operationId,
  auction: OfficialAuction.publish({
    auctionId,
    publisherId: 'upb-company-subject',
    publisherType: AuctionPublisherType.GameMaster,
    productId: 'exclusive-product-1',
    durationHours: 48,
    pricing: {
      kind: AuctionPriceKind.RealMoney,
      minimumBid: { amountMinor: minimumBidAmountMinor, currency: 'COP' },
    },
    mark: OfficialAuctionMark.Official,
    publishedAt: new Date('2026-09-23T12:00:00.000Z'),
  }),
})

describe('InMemoryAuctionRepository, publicacion oficial (HU-66)', () => {
  it('reproduce la misma publicacion oficial ante un reintento', async () => {
    const repository = new InMemoryAuctionRepository()
    await expect(repository.publishOfficial(officialCommand('official-1'))).resolves.toMatchObject({
      replayed: false,
    })
    await expect(
      repository.publishOfficial(officialCommand('official-regenerated')),
    ).resolves.toMatchObject({ replayed: true, auction: { id: 'official-1' } })
    await expect(repository.findOfficialById('official-1')).resolves.toMatchObject({
      id: 'official-1',
      publisherType: AuctionPublisherType.GameMaster,
    })
  })

  it('rechaza reutilizar la operacion con otra intencion funcional', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publishOfficial(officialCommand('official-1'))
    await expect(
      repository.publishOfficial(officialCommand('official-2', 'operation-1', 200_000)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('no mezcla el espacio de subastas oficiales con el de creditos', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-player', 'operation-player'))
    await repository.publishOfficial(officialCommand('official-1', 'operation-official'))

    await expect(repository.findById('official-1')).resolves.toBeNull()
    await expect(repository.findOfficialById('auction-player')).resolves.toBeNull()
  })
})

describe('InMemoryAuctionRepository, detalle unificado y historial publico (HU-88)', () => {
  it('findDetailById: PLAYER/CREDITS incluye publisherType, priceKind y los campos oficiales en null', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-detail-player'))

    await expect(repository.findDetailById('auction-detail-player')).resolves.toMatchObject({
      publisherType: 'PLAYER',
      priceKind: 'CREDITS',
      minimumBidCredits: 10,
      buyNowCredits: null,
      currency: null,
      minimumBidAmountMinor: null,
      buyNowAmountMinor: null,
      officialMark: null,
    })
  })

  it('findDetailById: GAME_MASTER/REAL_MONEY ya no es null -corrige el bug de toSnapshot-', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publishOfficial(officialCommand('official-detail-1'))

    await expect(repository.findDetailById('official-detail-1')).resolves.toMatchObject({
      publisherType: 'GAME_MASTER',
      priceKind: 'REAL_MONEY',
      currency: 'COP',
      minimumBidAmountMinor: 150_000,
      officialMark: OfficialAuctionMark.Official,
      minimumBidCredits: null,
      buyNowCredits: null,
    })
  })

  it('findDetailById: subasta inexistente devuelve null', async () => {
    const repository = new InMemoryAuctionRepository()

    await expect(repository.findDetailById('auction-missing')).resolves.toBeNull()
  })

  it('listBidHistoryPage: subasta existente sin pujas devuelve [] y total 0', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-history-empty'))

    await expect(
      repository.listBidHistoryPage({ auctionId: 'auction-history-empty', page: 1, pageSize: 20 }),
    ).resolves.toEqual({ items: [], total: 0 })
  })

  it('listBidHistoryPage: GAME_MASTER/REAL_MONEY valida devuelve [] y total 0 -no admite pujas-', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publishOfficial(officialCommand('official-history-empty'))

    await expect(
      repository.listBidHistoryPage({ auctionId: 'official-history-empty', page: 1, pageSize: 20 }),
    ).resolves.toEqual({ items: [], total: 0 })
  })

  it('listBidHistoryPage: una puja la devuelve sin bidderId', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-history-one'))
    const firstBid = bid(
      'bid-h1',
      'auction-history-one',
      'bidder-1',
      20,
      new Date('2026-09-21T12:00:10.000Z'),
      null,
    )
    await repository.persistBid(firstBid)

    await expect(
      repository.listBidHistoryPage({ auctionId: 'auction-history-one', page: 1, pageSize: 20 }),
    ).resolves.toEqual({
      items: [{ id: 'bid-h1', amountCredits: 20, placedAt: firstBid.snapshot().placedAt }],
      total: 1,
    })
  })

  it('listBidHistoryPage: multiples pujas, orden estable placedAt/id y total correcto', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-history-many', 'operation-many', 1))
    const bids = [
      bid(
        'bid-m1',
        'auction-history-many',
        'bidder-1',
        10,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      ),
      bid(
        'bid-m2',
        'auction-history-many',
        'bidder-2',
        20,
        new Date('2026-09-21T12:00:20.000Z'),
        10,
      ),
      bid(
        'bid-m3',
        'auction-history-many',
        'bidder-3',
        30,
        new Date('2026-09-21T12:00:30.000Z'),
        20,
      ),
    ]
    for (const oneBid of bids) {
      await repository.persistBid(oneBid)
    }

    const result = await repository.listBidHistoryPage({
      auctionId: 'auction-history-many',
      page: 1,
      pageSize: 20,
    })

    expect(result.total).toBe(3)
    expect(result.items.map((item) => item.id)).toEqual(['bid-m1', 'bid-m2', 'bid-m3'])
    for (const item of result.items) {
      expect(item).not.toHaveProperty('bidderId')
    }
  })

  it('listBidHistoryPage: pagina 1 y pagina 2 no se solapan y respetan pageSize', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-history-paged', 'operation-paged', 1))
    const bids = [
      bid(
        'bid-p1',
        'auction-history-paged',
        'bidder-1',
        10,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      ),
      bid(
        'bid-p2',
        'auction-history-paged',
        'bidder-2',
        20,
        new Date('2026-09-21T12:00:20.000Z'),
        10,
      ),
      bid(
        'bid-p3',
        'auction-history-paged',
        'bidder-3',
        30,
        new Date('2026-09-21T12:00:30.000Z'),
        20,
      ),
    ]
    for (const oneBid of bids) {
      await repository.persistBid(oneBid)
    }

    const firstPage = await repository.listBidHistoryPage({
      auctionId: 'auction-history-paged',
      page: 1,
      pageSize: 2,
    })
    const secondPage = await repository.listBidHistoryPage({
      auctionId: 'auction-history-paged',
      page: 2,
      pageSize: 2,
    })

    expect(firstPage.items.map((item) => item.id)).toEqual(['bid-p1', 'bid-p2'])
    expect(firstPage.total).toBe(3)
    expect(secondPage.items.map((item) => item.id)).toEqual(['bid-p3'])
    expect(secondPage.total).toBe(3)
  })

  it('listBidHistoryPage: no mezcla pujas entre subastas distintas', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-isolated-a', 'operation-a', 1))
    await repository.publish(command('auction-isolated-b', 'operation-b', 1))
    await repository.persistBid(
      bid(
        'bid-a1',
        'auction-isolated-a',
        'bidder-1',
        10,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      ),
    )
    await repository.persistBid(
      bid(
        'bid-b1',
        'auction-isolated-b',
        'bidder-2',
        10,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      ),
    )

    const pageA = await repository.listBidHistoryPage({
      auctionId: 'auction-isolated-a',
      page: 1,
      pageSize: 20,
    })

    expect(pageA.items.map((item) => item.id)).toEqual(['bid-a1'])
    expect(pageA.total).toBe(1)
  })
})
