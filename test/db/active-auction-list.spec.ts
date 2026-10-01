import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Auction } from '../../src/domain/entities/Auction'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import type { ListActiveAuctionsInput } from '../../src/application/ports/AuctionRepositoryPort'
import { Bid } from '../../src/domain/entities/Bid'
import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
} from '../../src/domain/entities/OfficialAuction'
import { AuctionPriceKind } from '../../src/domain/value-objects/AuctionPublicationPricing'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

const now = new Date('2026-09-23T12:00:00.000Z')

describe('PostgreSQL active auction marketplace', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresAuctionRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const migration = await migrateToLatest(db)
    if (migration.error instanceof Error) throw migration.error
    repository = new PostgresAuctionRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  beforeEach(async () => {
    await db.deleteFrom('auction_bids').execute()
    await db.deleteFrom('auction_audit_log').execute()
    await db.deleteFrom('outbox_events').execute()
    await db.deleteFrom('auction_publication_operations').execute()
    await db.deleteFrom('auctions').execute()
  })

  const publish = async (
    id: string,
    closesAt: Date,
    {
      durationHours = 24,
      minimumBidCredits = 10,
      buyNowCredits = null,
    }: {
      readonly durationHours?: 24 | 48
      readonly minimumBidCredits?: number
      readonly buyNowCredits?: number | null
    } = {},
  ) => {
    await repository.publish({
      operationId: `publish-${id}`,
      auction: Auction.publish({
        auctionId: id,
        sellerId: `seller-${id}`,
        productId: `product-${id}`,
        durationHours,
        minimumBidCredits,
        buyNowCredits,
        publishedAt: new Date(closesAt.getTime() - durationHours * 60 * 60 * 1000),
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

  const publishOfficial = async (
    id: string,
    closesAt: Date,
    mark = OfficialAuctionMark.Official,
    buyNowAmountMinor: number | null = 120_000,
  ) => {
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
          buyNow:
            buyNowAmountMinor === null ? null : { amountMinor: buyNowAmountMinor, currency: 'COP' },
        },
        mark,
        publishedAt: new Date(closesAt.getTime() - 24 * 60 * 60 * 1000),
      }),
    })
  }

  const placeBid = async (auctionId: string, bidId: string, amountCredits: number) => {
    await repository.persistBid(
      Bid.register({
        bidId,
        auctionId,
        bidderId: `bidder-${bidId}`,
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
  }

  it('filtra, ordena, pagina y resuelve el lider con una sola consulta de listado', async () => {
    await publish('expired', now)
    await publish('same-b', new Date(now.getTime() + 2_000))
    await publish('first', new Date(now.getTime() + 1_000))
    await publish('same-a', new Date(now.getTime() + 2_000))
    await repository.persistBid(
      Bid.register({
        bidId: 'bid-same-a',
        auctionId: 'same-a',
        bidderId: 'bidder',
        amountCredits: 30,
        placedAt: now,
        eligibility: {
          auctionStatus: 'ACTIVE',
          sellerId: 'seller-same-a',
          currentBidCredits: null,
          minimumIncrementCredits: 1,
          lastBidAtByBidder: null,
          activeBidCount: 0,
        },
      }),
    )
    await repository.finishAuction({
      auctionId: 'same-b',
      finishedAt: now,
      closingResult: AuctionClosingResult.withoutBids(now),
    })

    await expect(repository.listActive({ now, page: 1, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'first', currentBidAmount: null, bidCount: 0 }],
    })
    await expect(repository.listActive({ now, page: 2, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'same-a', currentBidAmount: 30, status: 'ACTIVE', bidCount: 1 }],
    })
  })

  it('pagina el listado mixto con oficiales primero y desempate determinista', async () => {
    await publish('player-earlier', new Date(now.getTime() + 1_000))
    await publishOfficial('official-b', new Date(now.getTime() + 3_000))
    await publishOfficial(
      'official-a',
      new Date(now.getTime() + 3_000),
      OfficialAuctionMark.Premium,
    )

    await expect(repository.listActive({ now, page: 1, pageSize: 2 })).resolves.toMatchObject({
      total: 3,
      items: [
        {
          id: 'official-a',
          publisherType: 'GAME_MASTER',
          priceKind: 'REAL_MONEY',
          currency: 'COP',
          officialMark: 'PREMIUM',
        },
        { id: 'official-b', publisherType: 'GAME_MASTER', officialMark: 'OFFICIAL' },
      ],
    })
    await expect(repository.listActive({ now, page: 2, pageSize: 2 })).resolves.toMatchObject({
      total: 3,
      items: [{ id: 'player-earlier', publisherType: 'PLAYER', priceKind: 'CREDITS' }],
    })
  })

  it('agrega el total real de pujas por subasta sin duplicar filas ni alterar total o paginacion', async () => {
    await publish('no-bids', new Date(now.getTime() + 1_000))
    await publish('one-bid', new Date(now.getTime() + 2_000))
    await publish('many-bids', new Date(now.getTime() + 3_000))
    await publishOfficial('official', new Date(now.getTime() + 4_000))
    await placeBid('one-bid', 'one-bid-1', 15)
    await placeBid('many-bids', 'many-bids-1', 20)
    await placeBid('many-bids', 'many-bids-2', 30)
    await placeBid('many-bids', 'many-bids-3', 40)
    const countBids = jest.spyOn(repository, 'countBids')

    const full = await repository.listActive({ now, page: 1, pageSize: 16 })

    expect(full.total).toBe(4)
    expect(full.items.map((item) => [item.id, item.bidCount, item.currentBidAmount])).toEqual([
      ['official', 0, null],
      ['no-bids', 0, null],
      ['one-bid', 1, 15],
      ['many-bids', 3, 40],
    ])
    await expect(repository.listActive({ now, page: 1, pageSize: 2 })).resolves.toMatchObject({
      total: 4,
      items: [
        { id: 'official', bidCount: 0 },
        { id: 'no-bids', bidCount: 0 },
      ],
    })
    await expect(repository.listActive({ now, page: 2, pageSize: 2 })).resolves.toMatchObject({
      total: 4,
      items: [
        { id: 'one-bid', bidCount: 1 },
        { id: 'many-bids', bidCount: 3 },
      ],
    })
    // El listado agrega en la misma consulta: nunca un conteo por subasta (N+1).
    expect(countBids).not.toHaveBeenCalled()
    countBids.mockRestore()

    await expect(repository.countBids('no-bids')).resolves.toBe(0)
    await expect(repository.countBids('one-bid')).resolves.toBe(1)
    await expect(repository.countBids('many-bids')).resolves.toBe(3)
    await expect(repository.countBids('missing')).resolves.toBe(0)
  })

  describe('filtros y orden (mismo escenario que la prueba unitaria en memoria)', () => {
    const at = (hours: number): Date => new Date(now.getTime() + hours * 60 * 60 * 1000)
    const listIds = async (input: Omit<ListActiveAuctionsInput, 'now'>) => {
      const result = await repository.listActive({ ...input, now })
      return { ids: result.items.map((item) => item.id), total: result.total }
    }

    /*
     * | id   | tipo   | cierre | publicado | buy-now | pujas | precio efectivo |
     * | o-a  | GM     | +4h    | -20h      | si      | 0     | -               |
     * | o-b  | GM     | +5h    | -19h      | no      | 0     | -               |
     * | p-c  | PLAYER | +1h    | -47h      | si      | 0     | 5 (minimo)      |
     * | p-a  | PLAYER | +2h    | -22h      | si      | 1     | 50 (lider)      |
     * | p-b  | PLAYER | +3h    | -45h      | no      | 3     | 100 (lider)     |
     */
    beforeEach(async () => {
      await publishOfficial('o-a', at(4))
      await publishOfficial('o-b', at(5), OfficialAuctionMark.Premium, null)
      await publish('p-c', at(1), { durationHours: 48, minimumBidCredits: 5, buyNowCredits: 8 })
      await publish('p-a', at(2), { minimumBidCredits: 10, buyNowCredits: 100 })
      await publish('p-b', at(3), { durationHours: 48, minimumBidCredits: 30 })
      await placeBid('p-a', 'p-a-1', 50)
      await placeBid('p-b', 'p-b-1', 40)
      await placeBid('p-b', 'p-b-2', 70)
      await placeBid('p-b', 'p-b-3', 100)
    })

    it('sin filtros ni sort conserva el orden historico', async () => {
      await expect(listIds({ page: 1, pageSize: 16 })).resolves.toEqual({
        ids: ['o-a', 'o-b', 'p-c', 'p-a', 'p-b'],
        total: 5,
      })
    })

    it.each([
      [{ publisherType: 'PLAYER' as const }, ['p-c', 'p-a', 'p-b']],
      [{ publisherType: 'GAME_MASTER' as const }, ['o-a', 'o-b']],
      [{ priceKind: 'CREDITS' as const }, ['p-c', 'p-a', 'p-b']],
      [{ priceKind: 'REAL_MONEY' as const }, ['o-a', 'o-b']],
      [{ hasBuyNow: true }, ['o-a', 'p-c', 'p-a']],
      [{ hasBuyNow: false }, ['o-b', 'p-b']],
      [{ publisherType: 'PLAYER' as const, hasBuyNow: true }, ['p-c', 'p-a']],
      [{ publisherType: 'PLAYER' as const, priceKind: 'REAL_MONEY' as const }, []],
    ])('filtra %j con el mismo WHERE en items y total', async (filters, expected) => {
      await expect(listIds({ page: 1, pageSize: 16, filters })).resolves.toEqual({
        ids: expected,
        total: expected.length,
      })
    })

    it.each([
      ['closingSoon' as const, {}, ['p-c', 'p-a', 'p-b', 'o-a', 'o-b']],
      ['newest' as const, {}, ['o-b', 'o-a', 'p-a', 'p-b', 'p-c']],
      ['mostBids' as const, {}, ['p-b', 'p-a', 'p-c', 'o-a', 'o-b']],
      ['priceAsc' as const, { priceKind: 'CREDITS' as const }, ['p-c', 'p-a', 'p-b']],
      ['priceDesc' as const, { priceKind: 'CREDITS' as const }, ['p-b', 'p-a', 'p-c']],
    ])('sort=%s ordena en SQL', async (sort, filters, expected) => {
      await expect(listIds({ page: 1, pageSize: 16, filters, sort })).resolves.toEqual({
        ids: expected,
        total: expected.length,
      })
    })

    it('mostBids conserva el conteo real y una fila por subasta', async () => {
      const result = await repository.listActive({ now, page: 1, pageSize: 16, sort: 'mostBids' })

      expect(result.items.map((item) => [item.id, item.bidCount, item.currentBidAmount])).toEqual([
        ['p-b', 3, 100],
        ['p-a', 1, 50],
        ['p-c', 0, null],
        ['o-a', 0, null],
        ['o-b', 0, null],
      ])
    })

    it('pagina despues de filtrar y ordenar, y una pagina vacia conserva el total', async () => {
      const input = {
        pageSize: 2,
        filters: { priceKind: 'CREDITS' as const },
        sort: 'priceDesc' as const,
      }

      await expect(listIds({ ...input, page: 1 })).resolves.toEqual({
        ids: ['p-b', 'p-a'],
        total: 3,
      })
      await expect(listIds({ ...input, page: 2 })).resolves.toEqual({ ids: ['p-c'], total: 3 })
      await expect(listIds({ ...input, page: 3 })).resolves.toEqual({ ids: [], total: 3 })
    })
  })

  describe('productIds de la busqueda global', () => {
    it('restringe antes de paginar y count, tambien con una lista vacia', async () => {
      await publish('first', new Date(now.getTime() + 1_000))
      await publish('second', new Date(now.getTime() + 2_000))
      await publish('match', new Date(now.getTime() + 3_000))

      await expect(
        repository.listActive({ now, page: 1, pageSize: 1, productIds: ['product-match'] }),
      ).resolves.toMatchObject({ total: 1, items: [{ id: 'match' }] })
      await expect(
        repository.listActive({ now, page: 1, pageSize: 16, productIds: [] }),
      ).resolves.toEqual({ total: 0, items: [] })
    })

    it('combina productIds con publisherType, priceKind, hasBuyNow y cada sort', async () => {
      const at = (hours: number): Date => new Date(now.getTime() + hours * 60 * 60 * 1000)
      await publishOfficial('official-match', at(4))
      await publishOfficial('official-excluded', at(5), OfficialAuctionMark.Premium, null)
      await publish('player-match', at(1), { minimumBidCredits: 10, buyNowCredits: 20 })
      await publish('player-excluded', at(2), { minimumBidCredits: 20 })
      await placeBid('player-match', 'player-match-bid', 30)

      const productIds = ['product-official-match', 'product-player-match']
      await expect(
        repository.listActive({
          now,
          page: 1,
          pageSize: 16,
          productIds,
          filters: { publisherType: 'PLAYER', priceKind: 'CREDITS', hasBuyNow: true },
          sort: 'closingSoon',
        }),
      ).resolves.toMatchObject({ total: 1, items: [{ id: 'player-match' }] })

      for (const sort of ['closingSoon', 'mostBids'] as const) {
        const result = await repository.listActive({ now, page: 1, pageSize: 16, productIds, sort })
        expect(result.total).toBe(2)
        expect(result.items.map((item) => item.id)).toEqual(
          sort === 'closingSoon'
            ? ['player-match', 'official-match']
            : ['player-match', 'official-match'],
        )
      }
    })
  })

  it('desempata por id cuando precio, pujas o cierre coinciden', async () => {
    const closesAt = new Date(now.getTime() + 60 * 60 * 1000)
    await publish('tie-b', closesAt)
    await publish('tie-a', closesAt)
    await publish('tie-c', closesAt)

    for (const sort of ['closingSoon', 'newest', 'mostBids', 'priceAsc', 'priceDesc'] as const) {
      const result = await repository.listActive({
        now,
        page: 1,
        pageSize: 16,
        filters: { priceKind: 'CREDITS' },
        sort,
      })
      expect(result.items.map((item) => item.id)).toEqual(['tie-a', 'tie-b', 'tie-c'])

      // Paginando de a uno sobre el empate: sin duplicados ni huecos entre paginas.
      const pages = []
      for (const page of [1, 2, 3]) {
        const { items } = await repository.listActive({
          now,
          page,
          pageSize: 1,
          filters: { priceKind: 'CREDITS' },
          sort,
        })
        pages.push(...items.map((item) => item.id))
      }
      expect(pages).toEqual(['tie-a', 'tie-b', 'tie-c'])
    }
  })
})
