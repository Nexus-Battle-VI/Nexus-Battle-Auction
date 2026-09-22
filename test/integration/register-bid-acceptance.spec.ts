import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import type {
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../src/application/ports/BidCreditsPort'
import type {
  OutbidNotification,
  OutbidNotificationPort,
} from '../../src/application/ports/OutbidNotificationPort'
import { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { ReactToRivalBid } from '../../src/application/use-cases/ReactToRivalBid'
import { RegisterBid } from '../../src/application/use-cases/RegisterBid'
import { Auction } from '../../src/domain/entities/Auction'
import { BidRuleCode } from '../../src/domain/errors/BidRuleViolation'

describe('HU-63: pruebas de aceptacion de pujas', () => {
  it('CP-01 reserva la nueva oferta, libera al postor superado y le notifica', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish({
      operationId: 'publish-cp-01',
      auction: Auction.publish({
        auctionId: 'auction-cp-01',
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
      inventoryCommitmentId: 'inventory-cp-01',
      feeChargeId: 'fee-cp-01',
    })

    let currentTime = new Date('2026-09-21T12:00:10.000Z')
    let nextBidNumber = 0
    const clock = { now: (): Date => new Date(currentTime) }

    const reserve = jest.fn(
      (command: ReserveBidCreditsCommand): Promise<{ reservationId: string }> =>
        Promise.resolve({ reservationId: `reservation-${command.bidderId}` }),
    )
    const release = jest.fn((operationId: string, reservationId: string): Promise<void> => {
      void operationId
      void reservationId
      return Promise.resolve()
    })
    const publishNotification = jest.fn((notification: OutbidNotification): Promise<void> => {
      void notification
      return Promise.resolve()
    })

    const credits: BidCreditsPort = {
      getAvailableCredits: () => Promise.resolve({ availableCredits: 100 }),
      reserve,
      release,
    }
    const notifications: OutbidNotificationPort = {
      publish: publishNotification,
      publishAutoBidLimitReached: () => Promise.resolve(),
    }
    const persistence = new PersistBidWithCredits(repository, credits, clock)
    const identifiers = { generate: () => `bid-${String(++nextBidNumber)}` }
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

    const firstBid = await registerBid.execute({
      operationId: 'operation-first',
      auctionId: 'auction-cp-01',
      bidderId: 'bidder-1',
      amountCredits: 20,
    })

    expect(firstBid.id).toBe('bid-1')
    expect(await repository.findLeadingBid('auction-cp-01')).toEqual(firstBid)
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation-first:reserve',
        bidderId: 'bidder-1',
        amount: 20,
      }),
    )
    expect(release).not.toHaveBeenCalled()
    expect(publishNotification).not.toHaveBeenCalled()

    currentTime = new Date('2026-09-21T12:00:20.000Z')

    const secondBid = await registerBid.execute({
      operationId: 'operation-second',
      auctionId: 'auction-cp-01',
      bidderId: 'bidder-2',
      amountCredits: 30,
    })

    expect(secondBid.id).toBe('bid-2')
    expect(await repository.findLeadingBid('auction-cp-01')).toEqual(secondBid)
    expect(await repository.findBidHistory('auction-cp-01')).toEqual([firstBid, secondBid])
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation-second:reserve',
        bidderId: 'bidder-2',
        amount: 30,
      }),
    )
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(
      'operation-second:release-previous',
      'reservation-bidder-1',
    )
    expect(publishNotification).toHaveBeenCalledTimes(1)
    expect(publishNotification).toHaveBeenCalledWith({
      notificationId: 'operation-second:outbid',
      operationId: 'operation-second',
      recipientPlayerId: 'bidder-1',
      auctionId: 'auction-cp-01',
      outbidBidId: firstBid.id,
      winningBidId: secondBid.id,
      winningBidderId: 'bidder-2',
      winningAmountCredits: 30,
      occurredAt: secondBid.placedAt,
    })
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      publishNotification.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    )
    expect(await repository.findBidCreditOperation('operation-first')).toMatchObject({
      status: 'COMPLETED',
      reservationId: 'reservation-bidder-1',
    })
    expect(await repository.findBidCreditOperation('operation-second')).toMatchObject({
      status: 'COMPLETED',
      reservationId: 'reservation-bidder-2',
      previousReservationId: 'reservation-bidder-1',
    })
  })

  it('CP-02 rechaza antes de 5 segundos y acepta exactamente a los 5 segundos', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish({
      operationId: 'publish-cp-02',
      auction: Auction.publish({
        auctionId: 'auction-cp-02',
        sellerId: 'seller-1',
        productId: 'product-2',
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
      inventoryCommitmentId: 'inventory-cp-02',
      feeChargeId: 'fee-cp-02',
    })

    let currentTime = new Date('2026-09-21T12:00:10.000Z')
    let nextBidNumber = 0
    const clock = { now: (): Date => new Date(currentTime) }
    const reserve = jest.fn(
      (command: ReserveBidCreditsCommand): Promise<{ reservationId: string }> =>
        Promise.resolve({ reservationId: `reservation-${command.bidId}` }),
    )
    const release = jest.fn((operationId: string, reservationId: string): Promise<void> => {
      void operationId
      void reservationId
      return Promise.resolve()
    })
    const publishNotification = jest.fn((notification: OutbidNotification): Promise<void> => {
      void notification
      return Promise.resolve()
    })

    const credits: BidCreditsPort = {
      getAvailableCredits: () => Promise.resolve({ availableCredits: 100 }),
      reserve,
      release,
    }
    const notifications: OutbidNotificationPort = {
      publish: publishNotification,
      publishAutoBidLimitReached: () => Promise.resolve(),
    }
    const persistence = new PersistBidWithCredits(repository, credits, clock)
    const identifiers = { generate: () => `bid-cp-02-${String(++nextBidNumber)}` }
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

    const firstBid = await registerBid.execute({
      operationId: 'operation-cp-02-first',
      auctionId: 'auction-cp-02',
      bidderId: 'bidder-1',
      amountCredits: 20,
    })

    currentTime = new Date('2026-09-21T12:00:14.999Z')

    await expect(
      registerBid.execute({
        operationId: 'operation-cp-02-too-soon',
        auctionId: 'auction-cp-02',
        bidderId: 'bidder-1',
        amountCredits: 30,
      }),
    ).rejects.toMatchObject({ code: BidRuleCode.BidCooldownActive })

    expect(await repository.findLeadingBid('auction-cp-02')).toEqual(firstBid)
    expect(await repository.findBidHistory('auction-cp-02')).toHaveLength(1)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()

    currentTime = new Date('2026-09-21T12:00:15.000Z')

    const secondBid = await registerBid.execute({
      operationId: 'operation-cp-02-boundary',
      auctionId: 'auction-cp-02',
      bidderId: 'bidder-1',
      amountCredits: 30,
    })

    expect(secondBid.amountCredits).toBe(30)
    expect(await repository.findLeadingBid('auction-cp-02')).toEqual(secondBid)
    expect(await repository.findBidHistory('auction-cp-02')).toHaveLength(2)
    expect(reserve).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledWith(
      'operation-cp-02-boundary:release-previous',
      'reservation-bid-cp-02-1',
    )
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('CA-02 y CA-03 rechaza montos invalidos y puja propia sin reservar creditos', async () => {
    const repository = new InMemoryAuctionRepository()

    await repository.publish({
      operationId: 'publish-invalid-bids',
      auction: Auction.publish({
        auctionId: 'auction-invalid-bids',
        sellerId: 'seller-1',
        productId: 'product-invalid-bids',
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
      inventoryCommitmentId: 'inventory-invalid-bids',
      feeChargeId: 'fee-invalid-bids',
    })

    const clock = { now: (): Date => new Date('2026-09-21T12:00:10.000Z') }
    let nextBidNumber = 0
    const reserve = jest.fn(
      (command: ReserveBidCreditsCommand): Promise<{ reservationId: string }> =>
        Promise.resolve({ reservationId: `reservation-${command.bidId}` }),
    )
    const release = jest.fn((operationId: string, reservationId: string): Promise<void> => {
      void operationId
      void reservationId
      return Promise.resolve()
    })
    const publishNotification = jest.fn((notification: OutbidNotification): Promise<void> => {
      void notification
      return Promise.resolve()
    })
    const credits: BidCreditsPort = {
      getAvailableCredits: () => Promise.resolve({ availableCredits: 100 }),
      reserve,
      release,
    }
    const persistence = new PersistBidWithCredits(repository, credits, clock)
    const identifiers = { generate: () => `bid-invalid-${String(++nextBidNumber)}` }
    const notifications = {
      publish: publishNotification,
      publishAutoBidLimitReached: () => Promise.resolve(),
    }
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

    const firstBid = await registerBid.execute({
      operationId: 'operation-initial',
      auctionId: 'auction-invalid-bids',
      bidderId: 'bidder-1',
      amountCredits: 20,
    })

    const invalidCases = [
      {
        operationId: 'operation-equal',
        bidderId: 'bidder-2',
        amountCredits: 20,
        code: BidRuleCode.BidTooLow,
      },
      {
        operationId: 'operation-below-increment',
        bidderId: 'bidder-2',
        amountCredits: 25,
        code: BidRuleCode.MinimumIncrementNotMet,
      },
      {
        operationId: 'operation-own-auction',
        bidderId: 'seller-1',
        amountCredits: 30,
        code: BidRuleCode.SellerCannotBid,
      },
    ]

    for (const invalidCase of invalidCases) {
      await expect(
        registerBid.execute({
          operationId: invalidCase.operationId,
          auctionId: 'auction-invalid-bids',
          bidderId: invalidCase.bidderId,
          amountCredits: invalidCase.amountCredits,
        }),
      ).rejects.toMatchObject({ code: invalidCase.code })

      expect(await repository.findBidCreditOperation(invalidCase.operationId)).toBeNull()
    }

    expect(await repository.findLeadingBid('auction-invalid-bids')).toEqual(firstBid)
    expect(await repository.findBidHistory('auction-invalid-bids')).toEqual([firstBid])
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('CA-06 admite la puja activa numero 50 y rechaza la numero 51', async () => {
    const repository = new InMemoryAuctionRepository()
    let currentTime = new Date('2026-09-21T12:00:10.000Z')
    let nextBidNumber = 0
    const clock = { now: (): Date => new Date(currentTime) }
    const reserve = jest.fn(
      (command: ReserveBidCreditsCommand): Promise<{ reservationId: string }> =>
        Promise.resolve({ reservationId: `reservation-${command.bidId}` }),
    )
    const credits: BidCreditsPort = {
      getAvailableCredits: () => Promise.resolve({ availableCredits: 100 }),
      reserve,
      release: () => Promise.resolve(),
    }
    const persistence = new PersistBidWithCredits(repository, credits, clock)
    const identifiers = { generate: () => `bid-limit-${String(++nextBidNumber)}` }
    const notifications = {
      publish: () => Promise.resolve(),
      publishAutoBidLimitReached: () => Promise.resolve(),
    }
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

    for (let index = 1; index <= 51; index++) {
      const suffix = String(index)
      const auctionId = `auction-limit-${suffix}`

      await repository.publish({
        operationId: `publish-limit-${suffix}`,
        auction: Auction.publish({
          auctionId,
          sellerId: `seller-limit-${suffix}`,
          productId: `product-limit-${suffix}`,
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
        inventoryCommitmentId: `inventory-limit-${suffix}`,
        feeChargeId: `fee-limit-${suffix}`,
      })

      if (index === 50) {
        expect(await repository.countActiveBidsByBidder('bidder-limit')).toBe(49)
      }

      const command = {
        operationId: `operation-limit-${suffix}`,
        auctionId,
        bidderId: 'bidder-limit',
        amountCredits: 20,
      }

      if (index === 51) {
        await expect(registerBid.execute(command)).rejects.toMatchObject({
          code: BidRuleCode.ActiveBidLimitReached,
        })
        expect(await repository.findLeadingBid(auctionId)).toBeNull()
        expect(await repository.findBidCreditOperation(command.operationId)).toBeNull()
      } else {
        await expect(registerBid.execute(command)).resolves.toMatchObject({
          auctionId,
          bidderId: 'bidder-limit',
        })
      }

      currentTime = new Date(currentTime.getTime() + 5_000)
    }

    expect(await repository.countActiveBidsByBidder('bidder-limit')).toBe(50)
    expect(reserve).toHaveBeenCalledTimes(50)
  })
})
