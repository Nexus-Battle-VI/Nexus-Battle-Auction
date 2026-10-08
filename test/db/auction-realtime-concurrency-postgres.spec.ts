import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'
import { Client } from 'pg'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { ConcurrentBidConflictError } from '../../src/application/errors/AuctionPersistenceError'
import { AuctionClosingResult } from '../../src/domain/entities/AuctionClosingResult'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import { AuctionRuleCode } from '../../src/domain/errors/AuctionRuleViolation'
import {
  parseAuctionRealtimeNotice,
  type AuctionRealtimeSignalV1,
} from '../../src/domain/events/AuctionRealtimeSignalV1'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * EN-034, TASK 34.3. Orden, concurrencia y aislamiento de las senales realtime, ejercitando los
 * caminos REALES del repositorio (`persistBid`, `cancelAuction`, `closeByBuyNow`,
 * `finishAuction`) y no SQL directo. Cubre CA-02 y CA-06 del Enabler en el lado del servidor.
 *
 * Las senales se observan donde nacen: una conexion `LISTEN auction_realtime`, igual que la de
 * Auction. Asi se comprueba lo que PostgreSQL entrega de verdad, en el orden en que lo entrega.
 */
describe('Senales realtime bajo concurrencia (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: Kysely<Database>
  let repository: PostgresAuctionRepository
  let listener: Client
  const signals: AuctionRealtimeSignalV1[] = []

  const now = new Date('2026-10-07T12:00:00.000Z')

  const forAuction = (auctionId: string): AuctionRealtimeSignalV1[] =>
    signals.filter((signal) => signal.auctionId === auctionId)

  /** Espera a que lleguen al menos `count` senales de la subasta. */
  const waitFor = async (auctionId: string, count: number): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (forAuction(auctionId).length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (forAuction(auctionId).length < count) {
      throw new Error(
        `Se esperaban ${String(count)} senales de ${auctionId} y llegaron ${String(forAuction(auctionId).length)}`,
      )
    }
  }

  /** Deja pasar un instante para detectar senales que NO deberian llegar. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

  const seed = async (auctionId: string, buyNowCredits: number | null = null): Promise<void> => {
    const auction = Auction.publish({
      auctionId,
      sellerId: `seller:${auctionId}`,
      productId: `product:${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      buyNowCredits,
      publishedAt: now,
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })
    await repository.publish({
      operationId: `publish:${auctionId}`,
      auction,
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
    })
  }

  const bid = (auctionId: string, n: number, amount: number): Bid =>
    Bid.restore({
      id: `${auctionId}-bid-${String(n)}`,
      auctionId,
      bidderId: `bidder-${String(n)}`,
      amountCredits: amount,
      placedAt: now,
    })

  const cancelCommand = (auctionId: string) => ({
    operationId: `cancel:${auctionId}`,
    auctionId,
    sellerId: `seller:${auctionId}`,
    productId: `product:${auctionId}`,
    cancelledAt: now,
    inventoryCommitmentId: `commitment:${auctionId}`,
    feeChargeId: `charge:${auctionId}`,
    refundAmountCredits: 0.5,
    walletRefundOperationId: `wallet-refund:${auctionId}`,
    inventoryReleaseOperationId: `inventory-release:${auctionId}`,
  })

  const revisions = (auctionId: string): number[] =>
    forAuction(auctionId).map((signal) => signal.revision)

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri(), maxConnections: 20 })
    expect((await migrateToLatest(db)).error).toBeUndefined()
    repository = new PostgresAuctionRepository(db)

    listener = new Client({ connectionString: container.getConnectionUri() })
    await listener.connect()
    listener.on('notification', (message) => {
      const signal = parseAuctionRealtimeNotice(message.payload ?? '')
      if (signal !== null) signals.push(signal)
    })
    await listener.query('LISTEN auction_realtime')
  }, 120_000)

  afterAll(async () => {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    await listener?.end()
    await db?.destroy()
    await container?.stop()
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  })

  it('12 pujas simultaneas: la revision no tiene huecos, repeticiones ni retrocesos', async () => {
    const auctionId = 'conc-one'
    await seed(auctionId)
    await waitFor(auctionId, 1)

    // Montos crecientes: algunas llegaran cuando ya hay un lider mayor y perderan la carrera.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        repository.persistBid(bid(auctionId, index + 1, (index + 1) * 10)),
      ),
    )
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    expect(accepted).toBeGreaterThan(0)
    // Las que pierden la carrera fallan por conflicto concurrente, nunca por otra causa.
    expect(rejected.every((outcome) => outcome.reason instanceof ConcurrentBidConflictError)).toBe(
      true,
    )

    await waitFor(auctionId, 1 + accepted)
    await settle()

    // PUBLISHED (0) y despues exactamente 1..accepted, en el orden en que PostgreSQL las entrega.
    expect(revisions(auctionId)).toEqual(Array.from({ length: accepted + 1 }, (_, index) => index))
    const row = await db
      .selectFrom('auctions')
      .select('revision')
      .where('id', '=', auctionId)
      .executeTakeFirstOrThrow()
    expect(Number(row.revision)).toBe(accepted)

    // El resumen avanza con la revision: cada puja aceptada sube `bidCount` en 1 y el monto lider
    // nunca baja.
    const bids = forAuction(auctionId).filter((signal) => signal.reason === 'BID_ACCEPTED')
    expect(bids.map((signal) => signal.summary?.bidCount)).toEqual(
      Array.from({ length: accepted }, (_, index) => index + 1),
    )
    const leaders = bids.map((signal) => signal.summary?.currentBidCredits ?? 0)
    expect(leaders).toEqual([...leaders].sort((a, b) => a - b))
  })

  it('pujas simultaneas en dos subastas: cada una conserva su propia secuencia', async () => {
    await seed('conc-a')
    await seed('conc-b')
    await waitFor('conc-a', 1)
    await waitFor('conc-b', 1)

    // Entrelazadas A, B, A, B... con el mismo rango de montos en ambas.
    const attempts = Array.from({ length: 8 }, (_, index) => [
      repository.persistBid(bid('conc-a', index + 1, (index + 1) * 10)),
      repository.persistBid(bid('conc-b', index + 1, (index + 1) * 10)),
    ]).flat()
    const outcomes = await Promise.allSettled(attempts)
    const acceptedOf = (auctionId: string): number =>
      outcomes.filter(
        (outcome, index) =>
          outcome.status === 'fulfilled' &&
          attempts[index] !== undefined &&
          index % 2 === (auctionId === 'conc-a' ? 0 : 1),
      ).length

    for (const auctionId of ['conc-a', 'conc-b']) {
      await waitFor(auctionId, 1 + acceptedOf(auctionId))
    }
    await settle()

    for (const auctionId of ['conc-a', 'conc-b']) {
      const expected = Array.from({ length: acceptedOf(auctionId) + 1 }, (_, index) => index)
      expect(revisions(auctionId)).toEqual(expected)
    }
    // Ninguna senal mezcla datos de la otra subasta.
    expect(
      forAuction('conc-a').every((signal) => signal.signalId.startsWith('auction:conc-a:')),
    ).toBe(true)
    expect(
      forAuction('conc-b').every((signal) => signal.signalId.startsWith('auction:conc-b:')),
    ).toBe(true)
  })

  it('puja contra cancelacion: gana una sola, y nunca hay una puja despues de la cancelacion', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `race-cancel-${String(index)}`)
    for (const id of ids) {
      await seed(id)
      await waitFor(id, 1)
    }

    const results = await Promise.all(
      ids.map(async (id) => {
        const [placed, cancelled] = await Promise.allSettled([
          repository.persistBid(bid(id, 1, 10)),
          repository.cancelAuction(cancelCommand(id)),
        ])
        return { id, placed, cancelled }
      }),
    )
    await settle()

    for (const { id, placed, cancelled } of results) {
      const bidWon = placed.status === 'fulfilled'
      const cancelWon = cancelled.status === 'fulfilled'
      // Exactamente un ganador.
      expect(bidWon).not.toBe(cancelWon)

      const reasons = forAuction(id).map((signal) => signal.reason)
      if (bidWon) {
        expect(reasons).toEqual(['PUBLISHED', 'BID_ACCEPTED'])
        // La cancelacion perdedora se rechaza porque ya hay pujas.
        expect(cancelled).toMatchObject({
          status: 'rejected',
          reason: { code: AuctionRuleCode.AuctionHasBids },
        })
      } else {
        expect(reasons).toEqual(['PUBLISHED', 'CANCELLED'])
        expect(placed.status).toBe('rejected')
      }
      // Pase lo que pase, la revision sigue sin huecos.
      expect(revisions(id)).toEqual([0, 1])
    }
  })

  it('la compra inmediata avisa BOUGHT_NOW y despues no llega ninguna senal mas', async () => {
    const auctionId = 'conc-buy-now'
    await seed(auctionId, 500)
    await waitFor(auctionId, 1)
    await repository.persistBid(bid(auctionId, 1, 10))
    await waitFor(auctionId, 2)

    await repository.closeByBuyNow({
      operationId: 'buy-op-1',
      transactionId: 'buy-tx-1',
      auctionId,
      buyerId: 'buyer-1',
      transferId: 'transfer-1',
      priceCredits: 500,
      remainingCredits: 0,
      closedAt: new Date(now.getTime() + 3_600_000),
    })
    await waitFor(auctionId, 3)

    // Una puja tardia sobre la subasta ya vendida se rechaza y no emite nada.
    await expect(repository.persistBid(bid(auctionId, 2, 600))).rejects.toBeInstanceOf(
      ConcurrentBidConflictError,
    )
    await settle()

    expect(forAuction(auctionId).map((signal) => [signal.reason, signal.revision])).toEqual([
      ['PUBLISHED', 0],
      ['BID_ACCEPTED', 1],
      ['BOUGHT_NOW', 2],
    ])
    expect(forAuction(auctionId)[2]?.summary).toMatchObject({ status: 'SOLD', bidCount: 1 })
  })

  it('el cierre de la subasta avisa SETTLED con la revision siguiente', async () => {
    const auctionId = 'conc-finish'
    await seed(auctionId)
    await waitFor(auctionId, 1)

    await repository.finishAuction({
      auctionId,
      finishedAt: now,
      closingResult: AuctionClosingResult.withoutBids(now),
    })
    await waitFor(auctionId, 2)

    expect(forAuction(auctionId).map((signal) => [signal.reason, signal.revision])).toEqual([
      ['PUBLISHED', 0],
      ['SETTLED', 1],
    ])
    expect(forAuction(auctionId)[1]?.summary).toMatchObject({ status: 'FINISHED' })
  })

  it('una puja rechazada por conflicto no consume revision ni emite senal', async () => {
    const auctionId = 'conc-rejected'
    await seed(auctionId)
    await persistLeader(auctionId)
    await waitFor(auctionId, 2)

    // 15 no supera el lider (50) mas el incremento minimo: el motor la rechaza.
    await expect(repository.persistBid(bid(auctionId, 2, 15))).rejects.toBeInstanceOf(
      ConcurrentBidConflictError,
    )
    await settle()

    expect(revisions(auctionId)).toEqual([0, 1])
  })

  async function persistLeader(auctionId: string): Promise<void> {
    await repository.persistBid(bid(auctionId, 1, 50))
  }
})
