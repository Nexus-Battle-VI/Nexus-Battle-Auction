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

/**
 * HU-67.7: pruebas de aceptacion explicitas de CA-01/CA-02 (issue #52) a
 * traves de los casos de prueba CP-01/CP-02 (issue #343).
 */
describe('HU-67: pruebas de aceptacion de puja automatica', () => {
  const buildHarness = () => {
    const repository = new InMemoryAuctionRepository()

    let tick = 0
    const baseTime = new Date('2026-09-21T12:01:00.000Z').getTime()
    const clock = { now: (): Date => new Date(baseTime + tick++ * 8_000) }

    const reserve = jest.fn(
      (command: ReserveBidCreditsCommand): Promise<{ reservationId: string }> =>
        Promise.resolve({ reservationId: `reservation-${command.bidId}` }),
    )

    const release = jest.fn(() => Promise.resolve())

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
    const identifiers = { generate: () => `auto-cp-${String(++nextId)}` }

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

    return { repository, registerBid, notified, limitReachedNotified }
  }

  const publishAuction = async (
    repository: InMemoryAuctionRepository,
    auctionId: string,
  ): Promise<void> => {
    await repository.publish({
      operationId: `publish-${auctionId}`,
      auction: Auction.publish({
        auctionId,
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
      inventoryCommitmentId: `inventory-${auctionId}`,
      feeChargeId: `fee-${auctionId}`,
    })
  }

  it('CP-01: la oferta del auto-bid sube automaticamente ante una puja rival valida por debajo de su limite', async () => {
    const { repository, registerBid, notified, limitReachedNotified } = buildHarness()

    await publishAuction(repository, 'auction-cp-01')

    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-cp-01',
        bidderId: 'bidder-auto',
        maxAmountCredits: 100,
        configuredAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )

    const rivalBid = await registerBid.execute({
      operationId: 'operation-cp-01-rival',
      auctionId: 'auction-cp-01',
      bidderId: 'bidder-rival',
      amountCredits: 20,
    })

    expect(rivalBid.amountCredits).toBe(20)

    // El auto-bid reacciona con el incremento minimo (20 + 10) sin superar
    // su limite (100).
    const leader = await repository.findLeadingBid('auction-cp-01')

    expect(leader).toMatchObject({ bidderId: 'bidder-auto', amountCredits: 30 })

    // bidder-rival, desplazado por la reaccion automatica, es notificado.
    expect(notified).toContainEqual(
      expect.objectContaining({
        recipientPlayerId: 'bidder-rival',
        winningBidderId: 'bidder-auto',
        winningAmountCredits: 30,
      }),
    )

    // El auto-bid no alcanzo su limite: no se avisa HU-67.3 todavia.
    expect(limitReachedNotified).toHaveLength(0)
  })

  it('CP-02: el auto-bid deja de subir y recibe aviso cuando el rival exige superar su limite', async () => {
    const { repository, registerBid, notified, limitReachedNotified } = buildHarness()

    await publishAuction(repository, 'auction-cp-02')

    await repository.saveAutoBidConfig(
      AutoBidConfig.configure({
        auctionId: 'auction-cp-02',
        bidderId: 'bidder-auto',
        maxAmountCredits: 35,
        configuredAt: new Date('2026-09-21T12:00:00.000Z'),
        eligibility: { auctionStatus: 'ACTIVE', sellerId: 'seller-1' },
      }),
    )

    // El auto-bid con limite 35 lidera en 30 (reacciono a una primera
    // puja rival de 20, igual que en CP-01).
    await registerBid.execute({
      operationId: 'operation-cp-02-first-rival',
      auctionId: 'auction-cp-02',
      bidderId: 'bidder-rival-1',
      amountCredits: 20,
    })

    expect(await repository.findLeadingBid('auction-cp-02')).toMatchObject({
      bidderId: 'bidder-auto',
      amountCredits: 30,
    })

    // Un segundo rival exige 40 para liderar: el auto-bid necesitaria 50
    // para seguir (40 + 10 de incremento minimo), por encima de su limite
    // de 35. No reacciona.
    const secondRival = await registerBid.execute({
      operationId: 'operation-cp-02-second-rival',
      auctionId: 'auction-cp-02',
      bidderId: 'bidder-rival-2',
      amountCredits: 40,
    })

    expect(secondRival.amountCredits).toBe(40)

    const leader = await repository.findLeadingBid('auction-cp-02')

    expect(leader).toMatchObject({ bidderId: 'bidder-rival-2', amountCredits: 40 })

    // bidder-auto recibe el aviso de HU-67.3: alcanzo su limite sin ganar.
    expect(limitReachedNotified).toContainEqual(
      expect.objectContaining({
        recipientPlayerId: 'bidder-auto',
        autoBidLimitCredits: 35,
        requiredAmountCredits: 50,
        leadingBidderId: 'bidder-rival-2',
      }),
    )

    // El rival-1, desplazado por bidder-rival-2, tambien fue notificado
    // (independiente de HU-67.3).
    expect(notified).toContainEqual(
      expect.objectContaining({
        recipientPlayerId: 'bidder-auto',
        winningBidderId: 'bidder-rival-2',
      }),
    )
  })
})
