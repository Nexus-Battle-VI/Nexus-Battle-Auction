import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely, type Migration } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
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

      await Promise.allSettled([repository.persistBid(lowerBid), repository.persistBid(higherBid)])

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
  })
})
