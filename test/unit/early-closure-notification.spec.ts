import { HttpEarlyClosureNotificationClient } from '../../src/adapters/outbound/http/HttpEarlyClosureNotificationClient'
import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryEarlyClosureNotificationRepository } from '../../src/adapters/outbound/persistence/InMemoryEarlyClosureNotificationRepository'
import type {
  BidCreditBalance,
  BidCreditReservation,
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../src/application/ports/BidCreditsPort'
import type {
  NotificationDispatch,
  NotificationPort,
  NotifyAuctionClosedEarlyCommand,
} from '../../src/application/ports/NotificationPort'
import {
  EarlyClosureNotificationService,
  MAX_DELIVERY_ATTEMPTS,
  type AuctionClosedByBuyNowEvent,
} from '../../src/application/services/EarlyClosureNotificationService'
import { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'

const PUBLISHED_AT = new Date('2026-09-20T12:00:00.000Z')
const CLOSED_AT = new Date('2026-09-21T15:00:00.000Z')

/**
 * Doble fiel de Wallet para reservas de puja: reserva un id nuevo por cada
 * llamada y solo libera lo que de verdad esta reservado, exactamente el
 * contrato real de `BidCreditsPort` (HU-63.2).
 */
class ConfigurableBidCredits implements BidCreditsPort {
  balances = new Map<string, number>()
  releaseFailures = new Set<string>()
  readonly reservations = new Map<string, { bidderId: string; amount: number }>()
  readonly released: string[] = []
  private sequence = 0

  getAvailableCredits(bidderId: string): Promise<BidCreditBalance> {
    return Promise.resolve({ availableCredits: this.balances.get(bidderId) ?? 0 })
  }

  reserve(command: ReserveBidCreditsCommand): Promise<BidCreditReservation> {
    const reservationId = `reservation-${String(++this.sequence)}`

    this.reservations.set(reservationId, { bidderId: command.bidderId, amount: command.amount })

    return Promise.resolve({ reservationId })
  }

  release(operationId: string, reservationId: string): Promise<void> {
    if (this.releaseFailures.has(reservationId)) {
      return Promise.reject(new Error('wallet caido'))
    }

    if (!this.reservations.has(reservationId)) {
      return Promise.reject(new Error(`La reserva ${reservationId} no existe o ya se libero.`))
    }

    this.reservations.delete(reservationId)
    this.released.push(reservationId)

    return Promise.resolve()
  }
}

class ConfigurableNotifier implements NotificationPort {
  notifyFailures = new Set<string>()
  private sequence = 0
  readonly sent: NotifyAuctionClosedEarlyCommand[] = []

  notifyAuctionClosedEarly(
    command: NotifyAuctionClosedEarlyCommand,
  ): Promise<NotificationDispatch> {
    if (this.notifyFailures.has(command.recipientId)) {
      return Promise.reject(new Error('notifications caido'))
    }

    this.sent.push(command)

    return Promise.resolve({ notificationId: `notification-${String(++this.sequence)}` })
  }
}

const seedAuction = async (
  repository: InMemoryAuctionRepository,
  auctionId = 'auction-1',
): Promise<void> => {
  const auction = Auction.publish({
    auctionId,
    sellerId: 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits: 10,
    buyNowCredits: 2500,
    publishedAt: PUBLISHED_AT,
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  })

  await repository.publish({
    operationId: `publish-${auctionId}`,
    auction,
    inventoryCommitmentId: 'commitment-1',
    feeChargeId: 'fee-1',
  })
}

const fixture = () => {
  const repository = new InMemoryAuctionRepository()
  const notifications = new InMemoryEarlyClosureNotificationRepository()
  const credits = new ConfigurableBidCredits()
  const notifier = new ConfigurableNotifier()
  const clock = { now: () => new Date(CLOSED_AT) }
  const persistence = new PersistBidWithCredits(repository, credits, clock)
  const service = new EarlyClosureNotificationService(
    repository,
    notifications,
    credits,
    notifier,
    clock,
  )

  /** Coloca una puja usando el flujo REAL de HU-63.2/63.4. */
  const placeBid = async (
    bidId: string,
    bidderId: string,
    amountCredits: number,
    placedAt: Date,
    auctionId = 'auction-1',
  ) => {
    credits.balances.set(bidderId, (credits.balances.get(bidderId) ?? 0) + amountCredits)

    await persistence.execute({
      operationId: `place-${bidId}`,
      bid: Bid.register({
        bidId,
        auctionId,
        bidderId,
        amountCredits,
        placedAt,
        eligibility: {
          auctionStatus: 'ACTIVE',
          sellerId: 'seller-1',
          currentBidCredits: (await repository.findLeadingBid(auctionId))?.amountCredits ?? null,
          minimumIncrementCredits: 10,
          lastBidAtByBidder: null,
          activeBidCount: 0,
        },
      }),
      expiresAt: new Date('2026-09-22T12:00:00.000Z'),
    })
  }

  return { repository, notifications, credits, notifier, service, placeBid }
}

const eventFor = (
  auctionId: string,
  overrides: Partial<AuctionClosedByBuyNowEvent> = {},
): AuctionClosedByBuyNowEvent => ({
  auctionId,
  buyerId: 'buyer-winner',
  transactionId: 'txn-1',
  closedAt: CLOSED_AT,
  ...overrides,
})

describe('EarlyClosureNotificationService HU-64.5', () => {
  it('libera el credito SOLO del postor que segue siendo lider y notifica a todos', async () => {
    const { repository, notifications, credits, notifier, service, placeBid } = fixture()
    await seedAuction(repository)

    // bidder-a puja primero, bidder-b lo desplaza: HU-63.2/63.4 libera de
    // inmediato la reserva de bidder-a (vease RegisterBid). Solo bidder-b
    // -el lider- sigue con creditos retenidos cuando llega la compra
    // inmediata.
    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))
    await placeBid('bid-2', 'bidder-b', 30, new Date('2026-09-20T12:00:20.000Z'))

    // bidder-a ya quedo liberado por PersistBidWithCredits al ser desplazado;
    // solo queda la reserva de bidder-b, el lider.
    expect(credits.reservations.size).toBe(1)
    const releasedBeforeClosure = credits.released.length

    const outcome = await service.processClosure(eventFor('auction-1'))

    expect(outcome.notified).toEqual(
      expect.arrayContaining([
        { bidderId: 'bidder-a', status: 'SENT', attempts: 1 },
        { bidderId: 'bidder-b', status: 'SENT', attempts: 1 },
      ]),
    )
    expect(outcome.notified).toHaveLength(2)

    // El cierre solo libero UNA reserva mas: la del lider (bidder-b). La de
    // bidder-a ya no existia -HU-63.2 la libero cuando lo desplazaron-, y
    // volver a intentarlo habria sido un error.
    expect(credits.released.length - releasedBeforeClosure).toBe(1)
    expect(credits.reservations.size).toBe(0)
    expect(notifier.sent).toHaveLength(2)

    const persisted = await notifications.findByAuction('auction-1')
    const byBidder = new Map(persisted.map((record) => [record.bidderId, record]))

    expect(byBidder.get('bidder-a')).toMatchObject({
      creditsReleased: true,
      creditReservationId: null,
    })
    expect(byBidder.get('bidder-b')).toMatchObject({
      creditsReleased: true,
      creditReservationId: expect.stringMatching(/^reservation-/),
    })
  })

  it('excluye al comprador de las notificaciones aunque haya sido el lider', async () => {
    const { repository, notifier, service, placeBid } = fixture()
    await seedAuction(repository)

    await placeBid('bid-winner', 'buyer-winner', 20, new Date('2026-09-20T12:00:10.000Z'))

    const outcome = await service.processClosure(eventFor('auction-1'))

    expect(outcome.notified).toHaveLength(0)
    expect(notifier.sent).toHaveLength(0)
  })

  it('una subasta sin pujas no genera ninguna notificacion', async () => {
    const { repository, service } = fixture()
    await seedAuction(repository)

    await expect(service.processClosure(eventFor('auction-1'))).resolves.toEqual({
      auctionId: 'auction-1',
      notified: [],
    })
  })

  it('reintenta hasta MAX_DELIVERY_ATTEMPTS si la liberacion del lider falla, sin re-liberar a nadie mas', async () => {
    const { repository, notifications, credits, service, placeBid } = fixture()
    await seedAuction(repository)

    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))

    const [reservationId] = credits.reservations.keys()

    credits.releaseFailures.add(reservationId!)

    const first = await service.processClosure(eventFor('auction-1'))

    expect(first.notified).toEqual([{ bidderId: 'bidder-a', status: 'FAILED', attempts: 1 }])

    for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const retried = await service.retryFailed()
      expect(retried).toEqual([{ bidderId: 'bidder-a', status: 'FAILED', attempts: attempt }])
    }

    await expect(service.retryFailed()).resolves.toEqual([])

    const [persisted] = await notifications.findByAuction('auction-1')

    expect(persisted).toMatchObject({
      status: 'FAILED',
      attempts: MAX_DELIVERY_ATTEMPTS,
      creditsReleased: false,
      lastError: expect.stringContaining('wallet caido'),
    })
    expect(credits.reservations.size).toBe(1)
  })

  it('si la liberacion tiene exito pero la notificacion falla, el reintento no vuelve a liberar', async () => {
    const { repository, notifications, credits, notifier, service, placeBid } = fixture()
    await seedAuction(repository)

    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))

    notifier.notifyFailures.add('bidder-a')

    await service.processClosure(eventFor('auction-1'))

    expect(credits.released).toHaveLength(1)

    const [failedRecord] = await notifications.findByAuction('auction-1')

    expect(failedRecord).toMatchObject({ status: 'FAILED', creditsReleased: true })

    notifier.notifyFailures.delete('bidder-a')

    const retried = await service.retryFailed()

    expect(retried).toEqual([{ bidderId: 'bidder-a', status: 'SENT', attempts: 2 }])
    // No se intento liberar otra vez: seguiria habiendo 1 liberacion total.
    expect(credits.released).toHaveLength(1)
    expect(notifier.sent).toHaveLength(1)
  })

  it('procesar el mismo cierre dos veces no duplica el trabajo ya hecho', async () => {
    const { repository, credits, notifier, service, placeBid } = fixture()
    await seedAuction(repository)

    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))

    await service.processClosure(eventFor('auction-1'))
    const second = await service.processClosure(eventFor('auction-1'))

    expect(second.notified).toEqual([{ bidderId: 'bidder-a', status: 'SENT', attempts: 1 }])
    expect(credits.released).toHaveLength(1)
    expect(notifier.sent).toHaveLength(1)
  })

  it('retryFailed no toca lo que ya se entrego', async () => {
    const { service } = fixture()

    await expect(service.retryFailed()).resolves.toEqual([])
  })
})

/**
 * Notifications falso a nivel HTTP con el contrato real de
 * closed-by-buy-now: 201 la primera vez, 200 en replay exacto, 409 si el
 * operationId se reutiliza con otro payload.
 */
const fakeNotificationsServer = () => {
  const stored = new Map<string, string>()
  const requests: { url: string; body: Record<string, string> }[] = []
  let unavailable = false

  const fetchImpl = jest.fn((url: string, init?: RequestInit) => {
    if (unavailable) {
      return Promise.resolve(new Response('{}', { status: 503 }))
    }

    const raw = init?.body as string
    const body = JSON.parse(raw) as Record<string, string>
    requests.push({ url, body })

    const operationId = body.operationId!
    const previous = stored.get(operationId)
    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status })

    if (previous === undefined) {
      stored.set(operationId, raw)
      return Promise.resolve(json(201, { notificationId: operationId, status: 'created' }))
    }

    return Promise.resolve(
      previous === raw
        ? json(200, { notificationId: operationId, status: 'duplicated' })
        : json(409, { error: 'operation_conflict' }),
    )
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    stored,
    requests,
    setUnavailable: (value: boolean): void => {
      unavailable = value
    },
  }
}

describe('EarlyClosureNotificationService HU-64.5 con HttpEarlyClosureNotificationClient', () => {
  const realFixture = () => {
    const base = fixture()
    const server = fakeNotificationsServer()
    const clock = { now: () => new Date(CLOSED_AT) }
    const httpNotifier = new HttpEarlyClosureNotificationClient({
      baseUrl: 'http://notifications:3005',
      secret: 'shared-secret',
      serviceName: 'auction',
      timeoutMs: 100,
      logger: { warn: jest.fn() },
      fetchImpl: server.fetchImpl,
      now: () => clock.now(),
    })
    const service = new EarlyClosureNotificationService(
      base.repository,
      base.notifications,
      base.credits,
      httpNotifier,
      clock,
    )

    return { ...base, server, service }
  }

  it('notifica por HTTP a cada participante, libera solo al lider y el replay no duplica', async () => {
    const { repository, credits, server, service, placeBid } = realFixture()
    await seedAuction(repository)

    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))
    await placeBid('bid-2', 'bidder-b', 30, new Date('2026-09-20T12:00:20.000Z'))
    await placeBid('bid-3', 'buyer-winner', 40, new Date('2026-09-20T12:00:30.000Z'))
    await placeBid('bid-4', 'bidder-a', 50, new Date('2026-09-20T12:00:40.000Z'))

    const releasedBeforeClosure = credits.released.length

    const outcome = await service.processClosure(eventFor('auction-1'))

    expect(outcome.notified).toHaveLength(2)
    expect(outcome.notified.every((item) => item.status === 'SENT')).toBe(true)

    // Una notificacion por participante, nunca al comprador.
    expect([...server.stored.keys()].sort()).toEqual(['txn-1:bidder-a', 'txn-1:bidder-b'])
    expect(server.requests).toHaveLength(2)
    for (const request of server.requests) {
      expect(request.url).toBe(
        'http://notifications:3005/api/internal/v1/notifications/auction/closed-by-buy-now',
      )
      expect(request.body).toEqual({
        operationId: `txn-1:${request.body.recipientId!}`,
        auctionId: 'auction-1',
        recipientId: request.body.recipientId,
        transactionId: 'txn-1',
        closedAt: CLOSED_AT.toISOString(),
      })
    }

    // Solo el lider (bidder-a con bid-4) libera en el cierre; los desplazados
    // ya liberaron al ser superados.
    expect(credits.released.length - releasedBeforeClosure).toBe(1)
    expect(credits.reservations.size).toBe(0)

    const replay = await service.processClosure(eventFor('auction-1'))

    expect(replay.notified.every((item) => item.status === 'SENT')).toBe(true)
    expect(server.requests).toHaveLength(2)
    expect(credits.released.length - releasedBeforeClosure).toBe(1)
  })

  it('un fallo de Notifications queda FAILED (best-effort) y un reintento responde 201 sin re-liberar', async () => {
    const { repository, notifications, credits, server, service, placeBid } = realFixture()
    await seedAuction(repository)

    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))

    server.setUnavailable(true)

    await expect(service.processClosure(eventFor('auction-1'))).resolves.toEqual({
      auctionId: 'auction-1',
      notified: [{ bidderId: 'bidder-a', status: 'FAILED', attempts: 1 }],
    })

    const [failed] = await notifications.findByAuction('auction-1')

    expect(failed).toMatchObject({
      status: 'FAILED',
      creditsReleased: true,
      lastError: expect.stringContaining('ExternalDependencyUnavailableError'),
    })
    expect(credits.released).toHaveLength(1)

    server.setUnavailable(false)

    await expect(service.retryFailed()).resolves.toEqual([
      { bidderId: 'bidder-a', status: 'SENT', attempts: 2 },
    ])
    expect(credits.released).toHaveLength(1)
    expect(server.stored.size).toBe(1)
  })

  it('un 409 de Notifications no se trata como entrega exitosa', async () => {
    const { repository, notifications, server, service, placeBid } = realFixture()
    await seedAuction(repository)

    await placeBid('bid-1', 'bidder-a', 20, new Date('2026-09-20T12:00:10.000Z'))

    // Otro payload ya ocupo el mismo operationId en Notifications.
    server.stored.set('txn-1:bidder-a', '{"operationId":"txn-1:bidder-a","auctionId":"otra"}')

    const outcome = await service.processClosure(eventFor('auction-1'))

    expect(outcome.notified).toEqual([{ bidderId: 'bidder-a', status: 'FAILED', attempts: 1 }])

    const [record] = await notifications.findByAuction('auction-1')

    expect(record).toMatchObject({
      status: 'FAILED',
      lastError: expect.stringContaining('ExternalContractError'),
    })
  })
})
