import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely, type Migration } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import type {
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../src/application/ports/BidCreditsPort'
import { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import {
  MIGRATIONS,
  createDatabase,
  migrateToLatest,
  pingDatabase,
} from '../../src/infrastructure/persistence/database'

/**
 * Infraestructura de persistencia contra un PostgreSQL REAL.
 *
 * Lo que se comprueba no se puede comprobar con un doble: que el pool conecta,
 * que el migrador registra lo aplicado y que una migracion rota se informa en
 * lugar de darse por buena.
 */
describe('Persistencia PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()

    db = createDatabase({
      connectionString: container.getConnectionUri(),
    })
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('la sonda responde contra un motor disponible', async () => {
    await expect(pingDatabase(db)).resolves.toBe(true)
  })

  it('aplica las migraciones del producto sin error', async () => {
    const outcome = await migrateToLatest(db)

    expect(outcome.error).toBeUndefined()
  })

  it('registra las migraciones aplicadas y no las repite', async () => {
    const migrations: Record<string, Migration> = {
      ...MIGRATIONS,
      '900-prueba': {
        up: async (conexion: Kysely<unknown>) => {
          await conexion.schema.createTable('prueba').addColumn('id', 'text').execute()
        },
      },
    }

    expect((await migrateToLatest(db, migrations)).applied).toEqual(['900-prueba'])

    expect((await migrateToLatest(db, migrations)).applied).toEqual([])

    const { rows } = await sql<{ existe: boolean }>`
        select
          to_regclass('public.prueba')
          is not null as existe
      `.execute(db)

    expect(rows[0]?.existe).toBe(true)
  })

  it('informa una migracion rota en lugar de darla por aplicada', async () => {
    const outcome = await migrateToLatest(db, {
      ...MIGRATIONS,
      '900-prueba': {
        up: () => Promise.resolve(),
      },
      '901-rota': {
        up: () => Promise.reject(new Error('sql invalido')),
      },
    })

    expect(outcome.applied).toEqual([])

    expect(outcome.error).toBeInstanceOf(Error)
  })

  /**
   * Reproduce lo que tumbaba el servicio: el motor corta una conexion que
   * espera ociosa en el pool. Sin oyente de `error`, Jest veria el proceso
   * terminar; con el, el error llega a `onIdleError` y la siguiente consulta
   * abre una conexion nueva.
   */
  it('sobrevive a que el motor corte una conexion ociosa del pool', async () => {
    const errores: Error[] = []

    const aplicacion = 'prueba-conexion-ociosa'

    const propia = createDatabase({
      connectionString: `${container.getConnectionUri()}?application_name=${aplicacion}`,
      onIdleError: (error) => errores.push(error),
    })

    try {
      await expect(pingDatabase(propia)).resolves.toBe(true)

      await sql`
        select
          pg_terminate_backend(pid)
        from pg_stat_activity
        where application_name = ${aplicacion}
          and state = 'idle'
      `.execute(db)

      for (let intento = 0; intento < 50 && errores.length === 0; intento += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(errores.length).toBeGreaterThan(0)

      await expect(pingDatabase(propia)).resolves.toBe(true)
    } finally {
      await propia.destroy()
    }
  })

  /**
   * El control de la primera prueba: con el motor inalcanzable la sonda dice
   * `false`. Sin este caso, una sonda que devolviera siempre `true` pasaria.
   */
  it('la sonda falla contra un motor inalcanzable', async () => {
    const inalcanzable = createDatabase({
      connectionString: 'postgres://nadie:nada@127.0.0.1:1/ninguna',
    })

    try {
      await expect(pingDatabase(inalcanzable)).resolves.toBe(false)
    } finally {
      await inalcanzable.destroy()
    }
  })

  describe('repositorio de publicaciones', () => {
    const publication = (id: string, sellerId = 'seller-1', productId = `product-${id}`) => ({
      operationId: `operation-${id}`,
      auction: Auction.publish({
        auctionId: id,
        sellerId,
        productId,
        durationHours: 24,
        minimumBidCredits: 10,
        buyNowCredits: 20,
        publishedAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: {
          productOwnedBySeller: true,
          productInUse: false,
          productTradable: true,
          sellerHasActiveSanctions: false,
          activeAuctionCount: 0,
        },
      }),
      inventoryCommitmentId: `commitment-${id}`,
      feeChargeId: `charge-${id}`,
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

    beforeEach(async () => {
      await sql`
        truncate
          auction_bids,
          auction_publication_operations,
          auction_audit_log,
          auction_publication_failures,
          outbox_events,
          auctions
        restart identity cascade
      `.execute(db)
    })

    /** Verifica las migraciones de creditos mediante operaciones reales e idempotentes. */
    it('persiste reservas, cambio de lider y estado de creditos atomicamente', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publish(publication('auction-credit-flow'))
      const now = new Date('2026-09-21T12:00:10.000Z')
      const first = bid('bid-credit-first', 'auction-credit-flow', 'bidder-1', 20, now, null)
      const second = bid('bid-credit-second', 'auction-credit-flow', 'bidder-2', 30, now, 20)
      const command = {
        operationId: 'credit-flow',
        bidId: second.snapshot().id,
        auctionId: 'auction-credit-flow',
        bidderId: 'bidder-2',
        amountCredits: 30,
        createdAt: now,
      }
      await expect(repository.findBidCreditOperation(command.operationId)).resolves.toBeNull()
      await repository.createBidCreditOperation(command)
      await repository.createBidCreditOperation(command)
      await expect(repository.findBidCreditOperation(command.operationId)).resolves.toEqual({
        ...command,
        status: 'PENDING_RESERVATION',
        reservationId: null,
        previousReservationId: null,
        updatedAt: now,
      })
      await expect(
        repository.createBidCreditOperation({ ...command, amountCredits: 40 }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
      await expect(
        repository.createBidCreditOperation({ ...command, operationId: 'another-operation' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
      await repository.updateBidCreditOperation({
        operationId: command.operationId,
        status: 'RESERVED',
        reservationId: 'reserve-second',
        previousReservationId: null,
        updatedAt: now,
      })
      await repository.persistBid(first, 'reserve-first')
      await expect(
        repository.persistBid(second, 'reserve-second', command.operationId),
      ).resolves.toEqual({
        bid: second.snapshot(),
        previousLeader: first.snapshot(),
        previousLeaderReservationId: 'reserve-first',
      })
      await expect(repository.findBidCreditOperation(command.operationId)).resolves.toMatchObject({
        status: 'BID_PERSISTED',
        reservationId: 'reserve-second',
        previousReservationId: 'reserve-first',
      })
    })

    it('rechaza operaciones de creditos inexistentes o de otra puja sin efectos parciales', async () => {
      const repository = new PostgresAuctionRepository(db)
      await repository.publish(publication('auction-credit-invalid'))
      const now = new Date('2026-09-21T12:00:10.000Z')
      const candidate = bid(
        'bid-credit-invalid',
        'auction-credit-invalid',
        'bidder-1',
        20,
        now,
        null,
      )
      await expect(
        repository.updateBidCreditOperation({
          operationId: 'missing',
          status: 'RESERVED',
          reservationId: 'reserve',
          previousReservationId: null,
          updatedAt: now,
        }),
      ).rejects.toThrow('no existe')
      await expect(repository.persistBid(candidate, 'reserve', 'missing')).rejects.toThrow(
        'no existe',
      )
      await repository.createBidCreditOperation({
        operationId: 'wrong-intent',
        bidId: 'different-bid',
        auctionId: 'auction-credit-invalid',
        bidderId: 'bidder-1',
        amountCredits: 20,
        createdAt: now,
      })
      await expect(
        repository.persistBid(candidate, 'reserve', 'wrong-intent'),
      ).rejects.toBeInstanceOf(IdempotencyConflictError)
      await expect(repository.findLeadingBid('auction-credit-invalid')).resolves.toBeNull()
      await expect(repository.findBidHistory('auction-credit-invalid')).resolves.toEqual([])
    })

    it('actualiza el fallo de compensacion sin duplicar el registro', async () => {
      const repository = new PostgresAuctionRepository(db)
      const failure = {
        operationId: 'credit-failure',
        bidId: 'bid-failure',
        auctionId: 'auction-failure',
        bidderId: 'bidder-1',
        stage: 'RELEASING_NEW_RESERVATION' as const,
        reason: 'offline',
        newReservationId: 'reserve',
        previousReservationId: null,
        newReservationReleased: false,
        previousReservationReleased: false,
        occurredAt: new Date('2026-09-21T12:00:00.000Z'),
      }
      await repository.recordBidCreditFailure(failure)
      await repository.recordBidCreditFailure({
        ...failure,
        reason: 'recovered',
        newReservationReleased: true,
      })
      const rows = await db
        .selectFrom('auction_bid_credit_failures')
        .selectAll()
        .where('operation_id', '=', failure.operationId)
        .execute()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ reason: 'recovered', new_reservation_released: true })
    })

    it('persiste la subasta, auditoria y outbox en una unidad atomica', async () => {
      const repository = new PostgresAuctionRepository(db)

      const result = await repository.publish(publication('auction-1'))

      expect(result.replayed).toBe(false)

      await expect(repository.findById('auction-1')).resolves.toEqual(result.auction)

      await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(1)

      const audit = await db.selectFrom('auction_audit_log').selectAll().execute()

      const outbox = await db.selectFrom('outbox_events').selectAll().execute()

      expect(audit).toHaveLength(1)

      expect(audit[0]).toMatchObject({
        auction_id: 'auction-1',
        operation_id: 'operation-auction-1',
        action: 'AUCTION_PUBLISHED',
      })

      expect(outbox).toHaveLength(1)

      expect(outbox[0]).toMatchObject({
        aggregate_id: 'auction-1',
        event_type: 'auction.published.v1',
        published_at: null,
      })
    })

    it('un reintento devuelve la publicacion sin duplicar efectos locales', async () => {
      const repository = new PostgresAuctionRepository(db)

      const command = publication('auction-idempotent')

      const retry = {
        ...publication('auction-generated-again', 'seller-1', 'product-auction-idempotent'),
        operationId: command.operationId,
      }

      await expect(repository.publish(command)).resolves.toMatchObject({
        replayed: false,
      })

      await expect(repository.publish(retry)).resolves.toMatchObject({
        replayed: true,
        auction: {
          id: 'auction-idempotent',
        },
      })

      const { amount } = await db
        .selectFrom('outbox_events')
        .select(
          sql<number>`
              count(*)::integer
            `.as('amount'),
        )
        .executeTakeFirstOrThrow()

      expect(amount).toBe(1)
    })

    it('revierte todos los registros si la publicacion viola una restriccion', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-first', 'seller-1', 'same-product'))

      await expect(
        repository.publish(publication('auction-failed', 'seller-2', 'same-product')),
      ).rejects.toBeDefined()

      await expect(repository.findById('auction-failed')).resolves.toBeNull()

      const operation = await db
        .selectFrom('auction_publication_operations')
        .selectAll()
        .where('operation_id', '=', 'operation-auction-failed')
        .executeTakeFirst()

      expect(operation).toBeUndefined()
    })

    it('serializa publicaciones concurrentes y no supera diez activas', async () => {
      const repository = new PostgresAuctionRepository(db)

      await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          repository.publish(publication(`auction-${String(index)}`, 'seller-limit')),
        ),
      )

      const outcomes = await Promise.allSettled([
        repository.publish(publication('auction-9', 'seller-limit')),
        repository.publish(publication('auction-10', 'seller-limit')),
      ])

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)

      const rejected = outcomes.find(({ status }) => status === 'rejected')

      expect(rejected).toMatchObject({
        reason: expect.any(ActiveAuctionLimitExceededError),
      })

      await expect(repository.countActiveBySeller('seller-limit')).resolves.toBe(10)
    })

    it('permanece disponible desde una conexion nueva', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-durable'))

      const restarted = createDatabase({
        connectionString: container.getConnectionUri(),
      })

      try {
        await expect(
          new PostgresAuctionRepository(restarted).findById('auction-durable'),
        ).resolves.toMatchObject({
          id: 'auction-durable',
          status: 'ACTIVE',
        })
      } finally {
        await restarted.destroy()
      }
    })

    it('registra y actualiza de forma idempotente un fallo compensable', async () => {
      const repository = new PostgresAuctionRepository(db)

      const failure = {
        operationId: 'operation-failed',
        auctionId: 'auction-failed',
        sellerId: 'seller-failed',
        stage: 'PERSISTING_AUCTION',
        reason: 'database unavailable',
        feeChargeId: 'charge-failed',
        inventoryCommitmentId: 'commitment-failed',
        feeRefunded: false,
        inventoryReleased: false,
        occurredAt: new Date('2026-09-21T12:00:00.000Z'),
      }

      await repository.recordFailure(failure)

      await repository.recordFailure({
        ...failure,
        feeRefunded: true,
        inventoryReleased: true,
      })

      const rows = await db.selectFrom('auction_publication_failures').selectAll().execute()

      expect(rows).toHaveLength(1)

      expect(rows[0]).toMatchObject({
        fee_refunded: true,
        inventory_released: true,
      })
    })

    it('persiste la primera puja como lider', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-first'))

      const firstBid = bid(
        'bid-1',
        'auction-bid-first',
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

      await expect(repository.findLeadingBid('auction-bid-first')).resolves.toEqual(
        firstBid.snapshot(),
      )

      const rows = await db
        .selectFrom('auction_bids')
        .selectAll()
        .where('auction_id', '=', 'auction-bid-first')
        .execute()

      expect(rows).toHaveLength(1)

      expect(rows[0]).toMatchObject({
        id: 'bid-1',
        auction_id: 'auction-bid-first',
        bidder_id: 'bidder-1',
        amount_credits: 20,
        is_leader: true,
      })
    })

    it('reemplaza el lider anterior y conserva el historial', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-history'))

      const firstBid = bid(
        'bid-history-1',
        'auction-bid-history',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const secondBid = bid(
        'bid-history-2',
        'auction-bid-history',
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

      await expect(repository.findLeadingBid('auction-bid-history')).resolves.toEqual(
        secondBid.snapshot(),
      )

      await expect(repository.findBidHistory('auction-bid-history')).resolves.toEqual([
        firstBid.snapshot(),
        secondBid.snapshot(),
      ])

      const rows = await db
        .selectFrom('auction_bids')
        .select(['id', 'is_leader'])
        .where('auction_id', '=', 'auction-bid-history')
        .orderBy('placed_at', 'asc')
        .execute()

      expect(rows).toEqual([
        {
          id: 'bid-history-1',
          is_leader: false,
        },
        {
          id: 'bid-history-2',
          is_leader: true,
        },
      ])
    })

    it('devuelve la ultima puja realizada por un jugador', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-last-bid-1'))

      await repository.publish(publication('auction-last-bid-2'))

      const firstBid = bid(
        'bid-last-1',
        'auction-last-bid-1',
        'bidder-last',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const secondBid = bid(
        'bid-last-2',
        'auction-last-bid-2',
        'bidder-last',
        30,
        new Date('2026-09-21T12:00:20.000Z'),
        null,
      )

      const anotherBid = bid(
        'bid-another',
        'auction-last-bid-1',
        'bidder-other',
        30,
        new Date('2026-09-21T12:00:30.000Z'),
        20,
      )

      await repository.persistBid(firstBid)

      await repository.persistBid(secondBid)

      await repository.persistBid(anotherBid)

      await expect(repository.findLastBidByBidder('bidder-last')).resolves.toEqual(
        secondBid.snapshot(),
      )

      await expect(repository.findLastBidByBidder('bidder-without-bids')).resolves.toBeNull()
    })

    it('cuenta solo las pujas activas donde el jugador sigue siendo lider', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-active-bid-1'))

      await repository.publish(publication('auction-active-bid-2'))

      await repository.publish(publication('auction-active-bid-3'))

      const leadingFirstAuction = bid(
        'bid-active-1',
        'auction-active-bid-1',
        'bidder-active',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const leadingSecondAuction = bid(
        'bid-active-2',
        'auction-active-bid-2',
        'bidder-active',
        20,
        new Date('2026-09-21T12:00:20.000Z'),
        null,
      )

      const initiallyLeadingThirdAuction = bid(
        'bid-active-3',
        'auction-active-bid-3',
        'bidder-active',
        20,
        new Date('2026-09-21T12:00:30.000Z'),
        null,
      )

      const replacementThirdAuction = bid(
        'bid-active-replacement',
        'auction-active-bid-3',
        'bidder-other',
        30,
        new Date('2026-09-21T12:00:40.000Z'),
        20,
      )

      await repository.persistBid(leadingFirstAuction)

      await repository.persistBid(leadingSecondAuction)

      await repository.persistBid(initiallyLeadingThirdAuction)

      await repository.persistBid(replacementThirdAuction)

      await expect(repository.countActiveBidsByBidder('bidder-active')).resolves.toBe(2)

      await expect(repository.countActiveBidsByBidder('bidder-other')).resolves.toBe(1)

      await expect(repository.countActiveBidsByBidder('bidder-without-active-bids')).resolves.toBe(
        0,
      )
    })

    it('rechaza un identificador de puja duplicado', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-duplicate'))

      const firstBid = bid(
        'bid-duplicate',
        'auction-bid-duplicate',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      await repository.persistBid(firstBid)

      await expect(repository.persistBid(firstBid)).rejects.toBeInstanceOf(BidAlreadyExistsError)

      await expect(repository.findBidHistory('auction-bid-duplicate')).resolves.toHaveLength(1)
    })

    it('rechaza persistir una puja para una subasta inexistente', async () => {
      const repository = new PostgresAuctionRepository(db)

      const orphanBid = bid(
        'bid-orphan',
        'auction-does-not-exist',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      await expect(repository.persistBid(orphanBid)).rejects.toBeInstanceOf(
        PersistedAuctionNotFoundError,
      )

      const rows = await db
        .selectFrom('auction_bids')
        .selectAll()
        .where('id', '=', 'bid-orphan')
        .execute()

      expect(rows).toHaveLength(0)
    })

    it('serializa pujas concurrentes y mantiene un unico lider', async () => {
      const repository = new PostgresAuctionRepository(db)

      await repository.publish(publication('auction-bid-concurrent'))

      const lowerBid = bid(
        'bid-concurrent-20',
        'auction-bid-concurrent',
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )

      const higherBid = bid(
        'bid-concurrent-30',
        'auction-bid-concurrent',
        'bidder-2',
        30,
        new Date('2026-09-21T12:00:11.000Z'),
        null,
      )

      const [lowerResult, higherResult] = await Promise.allSettled([
        repository.persistBid(lowerBid),
        repository.persistBid(higherBid),
      ])

      expect(higherResult.status).toBe('fulfilled')

      if (lowerResult.status === 'fulfilled') {
        expect(lowerResult.value.bid).toEqual(lowerBid.snapshot())
      } else {
        expect(lowerResult.reason).toBeInstanceOf(ConcurrentBidConflictError)
      }

      const history = await repository.findBidHistory('auction-bid-concurrent')

      expect(history).toHaveLength(lowerResult.status === 'fulfilled' ? 2 : 1)
      expect(history.some((entry) => entry.id === higherBid.snapshot().id)).toBe(true)

      await expect(repository.findLeadingBid('auction-bid-concurrent')).resolves.toEqual(
        higherBid.snapshot(),
      )

      const leaders = await db
        .selectFrom('auction_bids')
        .select(['id', 'amount_credits'])
        .where('auction_id', '=', 'auction-bid-concurrent')
        .where('is_leader', '=', true)
        .execute()

      expect(leaders).toHaveLength(1)

      expect(leaders[0]).toEqual({
        id: 'bid-concurrent-30',
        amount_credits: 30,
      })
    })

    it('conserva solo la reserva del lider cuando compiten dos pujas', async () => {
      const repository = new PostgresAuctionRepository(db)
      const auctionId = 'auction-concurrent-credits'

      await repository.publish(publication(auctionId))

      const activeReservations = new Set<string>()
      const reserve = jest.fn((command: ReserveBidCreditsCommand) => {
        const reservationId = `reservation-${command.bidId}`
        activeReservations.add(reservationId)
        return Promise.resolve({ reservationId })
      })
      const release = jest.fn((operationId: string, reservationId: string) => {
        void operationId
        activeReservations.delete(reservationId)
        return Promise.resolve()
      })
      const credits: BidCreditsPort = {
        getAvailableCredits: () => Promise.resolve({ availableCredits: 100 }),
        reserve,
        release,
      }
      const clock = { now: (): Date => new Date('2026-09-21T12:00:10.000Z') }
      const persistence = new PersistBidWithCredits(repository, credits, clock)

      const lowerBid = bid(
        'bid-credit-concurrent-20',
        auctionId,
        'bidder-1',
        20,
        new Date('2026-09-21T12:00:10.000Z'),
        null,
      )
      const higherBid = bid(
        'bid-credit-concurrent-30',
        auctionId,
        'bidder-2',
        30,
        new Date('2026-09-21T12:00:11.000Z'),
        null,
      )

      const [lowerResult, higherResult] = await Promise.allSettled([
        persistence.execute({
          operationId: 'operation-credit-concurrent-20',
          bid: lowerBid,
          expiresAt: new Date('2026-09-22T12:00:00.000Z'),
        }),
        persistence.execute({
          operationId: 'operation-credit-concurrent-30',
          bid: higherBid,
          expiresAt: new Date('2026-09-22T12:00:00.000Z'),
        }),
      ])

      expect(higherResult.status).toBe('fulfilled')
      if (lowerResult.status === 'rejected') {
        expect(lowerResult.reason).toBeInstanceOf(ConcurrentBidConflictError)
      }

      await expect(repository.findLeadingBid(auctionId)).resolves.toEqual(higherBid.snapshot())
      expect(activeReservations).toEqual(new Set(['reservation-bid-credit-concurrent-30']))
      expect(reserve).toHaveBeenCalledTimes(2)
      expect(release).toHaveBeenCalledTimes(1)
      await expect(
        repository.findBidCreditOperation('operation-credit-concurrent-30'),
      ).resolves.toMatchObject({ status: 'COMPLETED' })
      await expect(
        repository.findBidCreditOperation('operation-credit-concurrent-20'),
      ).resolves.toMatchObject({
        status: lowerResult.status === 'fulfilled' ? 'COMPLETED' : 'COMPENSATED',
      })
    })
  })
})
