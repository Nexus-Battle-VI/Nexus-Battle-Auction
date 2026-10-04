import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { PostgresAuctionActivityRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionActivityRepository'
import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Auction } from '../../src/domain/entities/Auction'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

describe('Actividad personal PostgreSQL HU-89', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let activity: PostgresAuctionActivityRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    const auctions = new PostgresAuctionRepository(db)
    for (const [auctionId, sellerId, operationId] of [
      ['auction-a', 'seller-a', 'publication-a'],
      ['auction-b', 'seller-b', 'publication-b'],
    ] as const) {
      await auctions.publish({
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
    }
    await db
      .insertInto('auction_bids')
      .values([
        {
          id: 'bid-a',
          auction_id: 'auction-b',
          bidder_id: 'player-a',
          amount_credits: 20,
          placed_at: new Date('2026-10-03T10:01:00Z'),
          is_leader: false,
          credit_reservation_id: 'hold-a',
        },
        {
          id: 'bid-b',
          auction_id: 'auction-b',
          bidder_id: 'player-b',
          amount_credits: 30,
          placed_at: new Date('2026-10-03T10:02:00Z'),
          is_leader: true,
          credit_reservation_id: 'hold-b',
        },
      ])
      .execute()
    await db
      .insertInto('auction_bid_credit_operations')
      .values({
        operation_id: 'bid-operation-a',
        bid_id: 'bid-a',
        auction_id: 'auction-b',
        bidder_id: 'player-a',
        amount_credits: 20,
        status: 'COMPLETED',
        reservation_id: 'hold-a',
        previous_reservation_id: null,
        created_at: new Date('2026-10-03T10:01:00Z'),
        updated_at: new Date('2026-10-03T10:01:00Z'),
      })
      .execute()
    activity = new PostgresAuctionActivityRepository(db)
  }, 120_000)

  afterAll(async () => {
    // beforeAll puede fallar antes de asignar db si Docker no esta disponible.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await db?.destroy()
    await container?.stop()
  })

  it('aísla publicaciones, participaciones y transacciones por identidad', async () => {
    await expect(
      activity.listOwnedAuctions({
        playerId: 'seller-a',
        page: 1,
        pageSize: 10,
        now: new Date('2026-10-03T11:00:00Z'),
      }),
    ).resolves.toMatchObject({ total: 1, items: [{ auctionId: 'auction-a' }] })
    await expect(
      activity.listBidParticipations({ playerId: 'player-a', page: 1, pageSize: 10 }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        {
          auctionId: 'auction-b',
          participationStatus: 'OUTBID',
          ownLatestBidCredits: 20,
          currentBidCredits: 30,
        },
      ],
    })
    await expect(
      activity.listTransactions({ playerId: 'player-a', page: 1, pageSize: 10 }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ id: 'bid:bid-operation-a', type: 'BID_RESERVATION' }],
    })
  })
})
