import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
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

describe('HU-67.2: aceptacion de la reaccion automatica ante una puja rival', () => {
  it('CA-01/CA-02: encadena 3 auto-bids y se detiene justo al limite del segundo mas fuerte', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish({
      operationId: 'publish-auto-bid-chain',
      auction: Auction.publish({
        auctionId: 'auction-auto-bid-chain',
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
      inventoryCommitmentId: 'inventory-auto-bid-chain',
      feeChargeId: 'fee-auto-bid-chain',
    })

    // bidder-A (50) y bidder-B (70) se turnan el liderazgo; bidder-C (1000)
    // siempre puede superarlos. La cadena debe detenerse justo cuando ni
    // bidder-A ni bidder-B alcanzan el siguiente incremento minimo.
    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-auto-bid-chain',
        bidderId: 'bidder-A',
        maxAmountCredits: 50,
        configuredAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )
    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-auto-bid-chain',
        bidderId: 'bidder-B',
        maxAmountCredits: 70,
        configuredAt: new Date('2026-09-21T12:00:01.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )
    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-auto-bid-chain',
        bidderId: 'bidder-C',
        maxAmountCredits: 1000,
        configuredAt: new Date('2026-09-21T12:00:02.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )

    /*
     * El reloj avanza 10s en cada llamada: Bid.register aplica el mismo
     * cooldown de 5s a una reaccion automatica que a una puja manual (se
     * reutiliza sin duplicar reglas), asi que sin avance de tiempo el mismo
     * postor quedaria bloqueado para volver a liderar dentro de esta misma
     * cadena.
     */
    const baseTime = new Date('2026-09-21T12:01:00.000Z').getTime()
    let ticks = 0
    const clock = { now: (): Date => new Date(baseTime + ticks++ * 10_000) }

    const reservations: Record<string, number> = {}

    const reserve = jest.fn(
      (command: ReserveBidCreditsCommand): Promise<{ reservationId: string }> => {
        reservations[command.bidderId] = (reservations[command.bidderId] ?? 0) + 1

        return Promise.resolve({
          reservationId: `reservation-${command.bidderId}-${String(reservations[command.bidderId])}`,
        })
      },
    )

    const released: string[] = []

    const release = jest.fn((operationId: string, reservationId: string): Promise<void> => {
      void operationId

      released.push(reservationId)

      return Promise.resolve()
    })

    const credits: BidCreditsPort = {
      getAvailableCredits: () => Promise.resolve({ availableCredits: 10_000 }),
      reserve,
      release,
    }

    const notified: OutbidNotification[] = []

    const limitReachedNotified: AutoBidLimitReachedNotification[] = []

    const notifications: OutbidNotificationPort = {
      publish: (notification: OutbidNotification): Promise<void> => {
        notified.push(notification)

        return Promise.resolve()
      },

      publishAutoBidLimitReached: (
        notification: AutoBidLimitReachedNotification,
      ): Promise<void> => {
        limitReachedNotified.push(notification)

        return Promise.resolve()
      },
    }

    const persistence = new PersistBidWithCredits(repository, credits, clock)

    let nextId = 0
    const identifiers = { generate: () => `auto-chain-${String(++nextId)}` }

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

    const humanBid = await registerBid.execute({
      operationId: 'operation-human-bid',
      auctionId: 'auction-auto-bid-chain',
      bidderId: 'bidder-human',
      amountCredits: 20,
    })

    expect(humanBid.amountCredits).toBe(20)

    const finalLeader = await repository.findLeadingBid('auction-auto-bid-chain')

    // C(30) -> B(40) -> C(50) -> B(60) -> C(70); en 80 ni A(50) ni B(70) alcanzan.
    expect(finalLeader).toMatchObject({ bidderId: 'bidder-C', amountCredits: 70 })

    const history = await repository.findBidHistory('auction-auto-bid-chain')

    expect(
      history.map((bid) => ({ bidderId: bid.bidderId, amountCredits: bid.amountCredits })),
    ).toEqual([
      { bidderId: 'bidder-human', amountCredits: 20 },
      { bidderId: 'bidder-C', amountCredits: 30 },
      { bidderId: 'bidder-B', amountCredits: 40 },
      { bidderId: 'bidder-C', amountCredits: 50 },
      { bidderId: 'bidder-B', amountCredits: 60 },
      { bidderId: 'bidder-C', amountCredits: 70 },
    ])

    // bidder-A nunca alcanzo a liderar: su limite (50) nunca fue el mas
    // fuerte disponible en ninguna ronda.
    expect(history.some((bid) => bid.bidderId === 'bidder-A')).toBe(false)

    // Cada desplazamiento (incluidas las 5 reacciones automaticas) libero la
    // reserva del lider anterior antes de dejar solo la del ganador final.
    expect(release).toHaveBeenCalledTimes(5)

    expect(notified.length).toBeGreaterThanOrEqual(5)

    /*
     * bidder-A (50) queda fuera de la ronda de 60 (C lidera con 50, no
     * alcanza el siguiente incremento minimo); bidder-B (70) sigue
     * compitiendo hasta la ronda de 80, donde tampoco alcanza. Cada uno
     * recibe el aviso de HU-67.3 exactamente una vez, con el monto que
     * realmente necesitaba superar.
     */
    expect(limitReachedNotified).toHaveLength(2)

    expect(
      limitReachedNotified
        .map((n) => ({
          recipientPlayerId: n.recipientPlayerId,
          requiredAmountCredits: n.requiredAmountCredits,
        }))
        .sort((left, right) => left.recipientPlayerId.localeCompare(right.recipientPlayerId)),
    ).toEqual([
      { recipientPlayerId: 'bidder-A', requiredAmountCredits: 60 },
      { recipientPlayerId: 'bidder-B', requiredAmountCredits: 80 },
    ])

    expect(limitReachedNotified.every((n) => n.leadingBidderId === 'bidder-C')).toBe(true)
  })
})
