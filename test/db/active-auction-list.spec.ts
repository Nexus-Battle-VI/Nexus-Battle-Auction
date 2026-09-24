import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Auction } from '../../src/domain/entities/Auction'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import { Bid } from '../../src/domain/entities/Bid'
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

  const publish = async (id: string, closesAt: Date) => {
    await repository.publish({
      operationId: `publish-${id}`,
      auction: Auction.publish({
        auctionId: id,
        sellerId: `seller-${id}`,
        productId: `product-${id}`,
        durationHours: 24,
        minimumBidCredits: 10,
        publishedAt: new Date(closesAt.getTime() - 24 * 60 * 60 * 1000),
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
      items: [{ id: 'first', currentBidAmount: null }],
    })
    await expect(repository.listActive({ now, page: 2, pageSize: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: 'same-a', currentBidAmount: 30, status: 'ACTIVE' }],
    })
  })
})
