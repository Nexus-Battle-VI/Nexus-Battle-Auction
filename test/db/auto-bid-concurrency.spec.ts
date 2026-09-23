import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type {
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../src/application/ports/BidCreditsPort'
import type {
  AutoBidLimitReachedNotification,
  OutbidNotification,
  OutbidNotificationPort,
} from '../../src/application/ports/OutbidNotificationPort'
import { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { ReactToRivalBid } from '../../src/application/use-cases/ReactToRivalBid'
import { RegisterBid } from '../../src/application/use-cases/RegisterBid'
import { Auction } from '../../src/domain/entities/Auction'
import { AutoBidConfig } from '../../src/domain/entities/AutoBidConfig'
import { ConcurrentBidConflictError } from '../../src/application/errors/AuctionPersistenceError'

/**
 * HU-67.7 (CP de concurrencia): dos pujas rivales concurrentes por la misma
 * subasta, con dos jugadores con puja automatica activa, ejercitando el
 * `pg_advisory_xact_lock(hashtext(auctionId))` real de
 * PostgresAuctionRepository.persistBid (no el repositorio en memoria, que no
 * serializa nada).
 */
describe('HU-67.7: concurrencia real entre auto-bids (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let repository: PostgresAuctionRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    repository = new PostgresAuctionRepository(db)
  }, 120_000)

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await db?.destroy()
    await container?.stop()
  })

  it('dos pujas rivales concurrentes: solo una gana la carrera y las reservas quedan consistentes', async () => {
    await repository.publish({
      operationId: 'publish-concurrency',
      auction: Auction.publish({
        auctionId: 'auction-concurrency',
        sellerId: 'seller-1',
        productId: 'product-1',
        durationHours: 24,
        minimumBidCredits: 10,
        publishedAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: {
          productOwnedBySeller: true,
          productInUse: false,
          productTradable: true,
          sellerHasActiveSanctions: false,
          activeAuctionCount: 0,
        },
      }),
      inventoryCommitmentId: 'inventory-concurrency',
      feeChargeId: 'fee-concurrency',
    })

    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-concurrency',
        bidderId: 'bidder-A',
        maxAmountCredits: 100,
        configuredAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )
    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-concurrency',
        bidderId: 'bidder-B',
        maxAmountCredits: 150,
        configuredAt: new Date('2026-09-21T12:00:01.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )

    const reserved = new Map<string, string>()
    let reserveCalls = 0
    const released: string[] = []

    let tick = 0
    const baseTime = new Date('2026-09-21T12:01:00.000Z').getTime()
    /*
     * Cada llamada avanza el reloj: evita que el cooldown de 5s de
     * Bid.register (reutilizado sin cambios, ver HU-67.2) bloquee a un
     * mismo auto-bidder que necesita volver a liderar dentro de esta
     * misma cadena de reacciones.
     */
    const clock = { now: (): Date => new Date(baseTime + tick++ * 8_000) }

    const credits: BidCreditsPort = {
      getAvailableCredits: () => Promise.resolve({ availableCredits: 100_000 }),

      reserve: (command: ReserveBidCreditsCommand) => {
        reserveCalls += 1

        const reservationId = `reservation-${command.bidId}`

        reserved.set(reservationId, command.bidderId)

        return Promise.resolve({ reservationId })
      },

      release: (operationId: string, reservationId: string) => {
        void operationId

        released.push(reservationId)

        return Promise.resolve()
      },
    }

    const notifications: OutbidNotificationPort = {
      publish: (notification: OutbidNotification): Promise<void> => {
        void notification

        return Promise.resolve()
      },

      publishAutoBidLimitReached: (
        notification: AutoBidLimitReachedNotification,
      ): Promise<void> => {
        void notification

        return Promise.resolve()
      },
    }

    const persistence = new PersistBidWithCredits(repository, credits, clock)

    let nextId = 0
    const identifiers = { generate: () => `auto-concurrency-${String(++nextId)}` }

    const autoBidReactor = new ReactToRivalBid(
      repository,
      persistence,
      clock,
      identifiers,
      notifications,
    )

    const registerBid = new RegisterBid(
      repository,
      persistence,
      clock,
      identifiers,
      notifications,
      autoBidReactor,
    )

    // Dos jugadores rivales pujan la MISMA cantidad al mismo tiempo: sin
    // lider previo, el dominio acepta ambas intenciones; solo la transaccion
    // que gane el advisory lock del auctionId puede persistir como lider.
    const [xResult, yResult] = await Promise.allSettled([
      registerBid.execute({
        operationId: 'operation-x',
        auctionId: 'auction-concurrency',
        bidderId: 'bidder-X',
        amountCredits: 20,
      }),
      registerBid.execute({
        operationId: 'operation-y',
        auctionId: 'auction-concurrency',
        bidderId: 'bidder-Y',
        amountCredits: 20,
      }),
    ])

    const settled = [xResult, yResult]

    const fulfilled = settled.filter((r) => r.status === 'fulfilled')

    const rejected = settled.filter((r) => r.status === 'rejected')

    // Exactamente una de las dos pujas rivales concurrentes gana la carrera.
    expect(fulfilled).toHaveLength(1)

    expect(rejected).toHaveLength(1)

    expect(rejected[0]!.reason).toBeInstanceOf(ConcurrentBidConflictError)

    // El motor de reaccion (HU-67.2) ya corrio dentro de la puja ganadora:
    // el lider final debe ser uno de los dos auto-bidders, no bidder-X/Y.
    const finalLeader = await repository.findLeadingBid('auction-concurrency')

    expect(finalLeader).not.toBeNull()

    expect(['bidder-A', 'bidder-B']).toContain(finalLeader?.bidderId)

    expect(finalLeader?.amountCredits).toBeGreaterThan(20)

    // Consistencia de creditos: cada reserva se libero exactamente una vez,
    // salvo la del lider final, que queda activa. Ni duplicadas ni perdidas.
    const uniqueReleased = new Set(released)

    expect(uniqueReleased.size).toBe(released.length)

    expect(reserveCalls - released.length).toBe(1)

    const activeReservationId = [...reserved.entries()].find(([id]) => !uniqueReleased.has(id))?.[0]

    expect(activeReservationId).toBeDefined()

    expect(reserved.get(activeReservationId!)).toBe(finalLeader?.bidderId)
  }, 30_000)
})
