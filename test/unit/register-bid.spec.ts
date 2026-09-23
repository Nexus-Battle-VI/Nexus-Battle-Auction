import {
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
  PersistBidResult,
} from '../../src/application/ports/AuctionRepositoryPort'
import type {
  OutbidNotification,
  OutbidNotificationPort,
} from '../../src/application/ports/OutbidNotificationPort'
import type { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import type { ReactToRivalBid } from '../../src/application/use-cases/ReactToRivalBid'
import { RegisterBid } from '../../src/application/use-cases/RegisterBid'
import { AuctionStatus, type AuctionSnapshot } from '../../src/domain/entities/Auction'
import type { BidSnapshot } from '../../src/domain/entities/Bid'
import { BidRuleCode, BidRuleViolation } from '../../src/domain/errors/BidRuleViolation'

const now = new Date('2026-09-21T12:00:10.000Z')

const auction: AuctionSnapshot = {
  id: 'auction-63-4',
  sellerId: 'seller-1',
  productId: 'product-1',
  durationHours: 24,
  publicationFeeCredits: 1,
  minimumBidCredits: 10,
  buyNowCredits: 100,
  status: AuctionStatus.Active,
  publishedAt: new Date('2026-09-21T12:00:00.000Z'),
  closesAt: new Date('2026-09-22T12:00:00.000Z'),
}

const leadingBid: BidSnapshot = {
  id: 'bid-leading',
  auctionId: auction.id,
  bidderId: 'bidder-leading',
  amountCredits: 20,
  placedAt: new Date('2026-09-21T12:00:00.000Z'),
}

const existingOperation = (
  overrides: Partial<BidCreditOperationSnapshot> = {},
): BidCreditOperationSnapshot => ({
  operationId: 'operation-existing',
  bidId: 'bid-original',
  auctionId: auction.id,
  bidderId: 'bidder-2',
  amountCredits: 30,
  status: 'COMPLETED',
  reservationId: 'reservation-original',
  previousReservationId: null,
  createdAt: new Date('2026-09-21T12:00:10.000Z'),
  updatedAt: new Date('2026-09-21T12:00:11.000Z'),
  ...overrides,
})

const dependencies = () => {
  const repository = {
    findBidCreditOperation: jest.fn(() => Promise.resolve<BidCreditOperationSnapshot | null>(null)),

    findById: jest.fn(() => Promise.resolve<AuctionSnapshot | null>(auction)),

    findLeadingBid: jest.fn(() => Promise.resolve<BidSnapshot | null>(leadingBid)),

    findLastBidByBidder: jest.fn(() => Promise.resolve<BidSnapshot | null>(null)),

    countActiveBidsByBidder: jest.fn(() => Promise.resolve(0)),
  } as unknown as jest.Mocked<AuctionRepositoryPort>

  const persistence = {
    execute: jest.fn(({ bid }) => {
      const snapshot = bid.snapshot()

      const result: PersistBidResult = {
        bid: snapshot,
        previousLeader: leadingBid,
        previousLeaderReservationId: 'reservation-leading',
      }

      return Promise.resolve(result)
    }),
  } as unknown as jest.Mocked<PersistBidWithCredits>

  /*
   * El parametro explicito es importante.
   *
   * OutbidNotificationPort.publish recibe exactamente un
   * OutbidNotification. Sin este parametro TypeScript inferiria
   * jest.Mock<Promise<void>, []> y perderia compatibilidad con
   * el puerto real.
   */
  const notifications: jest.Mocked<OutbidNotificationPort> = {
    publish: jest.fn((notification: OutbidNotification): Promise<void> => {
      void notification

      return Promise.resolve()
    }),
  }

  const clock = {
    now: (): Date => new Date(now),
  }

  const identifiers = {
    generate: jest.fn(() => 'bid-generated'),
  }

  const autoBidReactor: jest.Mocked<ReactToRivalBid> = {
    execute: jest.fn(() => Promise.resolve()),
  } as unknown as jest.Mocked<ReactToRivalBid>

  const useCase = new RegisterBid(
    repository,
    persistence,
    clock,
    identifiers,
    notifications,
    autoBidReactor,
  )

  return {
    repository,
    persistence,
    notifications,
    identifiers,
    autoBidReactor,
    useCase,
  }
}

describe('RegisterBid HU-63.4 / HU-63.5', () => {
  it('construye la puja con la identidad autenticada y delega la persistencia con creditos', async () => {
    const { repository, persistence, identifiers, useCase } = dependencies()

    await expect(
      useCase.execute({
        operationId: 'operation-bid-1',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toEqual({
      id: 'bid-generated',
      auctionId: auction.id,
      bidderId: 'bidder-2',
      amountCredits: 30,
      placedAt: now,
    })

    expect(repository.findBidCreditOperation).toHaveBeenCalledWith('operation-bid-1')

    expect(repository.findById).toHaveBeenCalledWith(auction.id)

    expect(repository.findLeadingBid).toHaveBeenCalledWith(auction.id)

    expect(repository.findLastBidByBidder).toHaveBeenCalledWith('bidder-2')

    expect(repository.countActiveBidsByBidder).toHaveBeenCalledWith('bidder-2')

    expect(identifiers.generate).toHaveBeenCalledTimes(1)

    expect(persistence.execute).toHaveBeenCalledTimes(1)

    expect(persistence.execute).toHaveBeenCalledWith({
      operationId: 'operation-bid-1',
      bid: expect.anything(),
      expiresAt: auction.closesAt,
    })

    const persistedCommand = persistence.execute.mock.calls[0]?.[0]

    expect(persistedCommand?.bid.snapshot()).toEqual({
      id: 'bid-generated',
      auctionId: auction.id,
      bidderId: 'bidder-2',
      amountCredits: 30,
      placedAt: now,
    })
  })

  it('dispara el motor de reaccion de pujas automaticas tras persistir', async () => {
    const { autoBidReactor, useCase } = dependencies()

    await useCase.execute({
      operationId: 'operation-auto-bid-trigger',
      auctionId: auction.id,
      bidderId: 'bidder-2',
      amountCredits: 30,
    })

    expect(autoBidReactor.execute).toHaveBeenCalledTimes(1)

    expect(autoBidReactor.execute).toHaveBeenCalledWith({
      operationId: 'operation-auto-bid-trigger',
      leadingBid: {
        id: 'bid-generated',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
        placedAt: now,
      },
    })
  })

  it('notifica al lider desplazado con usuario, subasta y puja correctos', async () => {
    const { persistence, notifications, useCase } = dependencies()

    await expect(
      useCase.execute({
        operationId: 'operation-outbid',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toMatchObject({
      id: 'bid-generated',
      bidderId: 'bidder-2',
      amountCredits: 30,
    })

    expect(notifications.publish).toHaveBeenCalledTimes(1)

    expect(notifications.publish).toHaveBeenCalledWith({
      notificationId: 'operation-outbid:outbid',
      operationId: 'operation-outbid',
      recipientPlayerId: 'bidder-leading',
      auctionId: auction.id,
      outbidBidId: 'bid-leading',
      winningBidId: 'bid-generated',
      winningBidderId: 'bidder-2',
      winningAmountCredits: 30,
      occurredAt: now,
    })

    const persistenceOrder = persistence.execute.mock.invocationCallOrder[0]

    const notificationOrder = notifications.publish.mock.invocationCallOrder[0]

    expect(persistenceOrder).toBeDefined()

    expect(notificationOrder).toBeDefined()

    expect(persistenceOrder).toBeLessThan(notificationOrder ?? Number.MAX_SAFE_INTEGER)
  })

  it('rechaza una subasta inexistente antes de crear o persistir la puja', async () => {
    const { repository, persistence, notifications, identifiers, useCase } = dependencies()

    repository.findById.mockResolvedValue(null)

    await expect(
      useCase.execute({
        operationId: 'operation-not-found',
        auctionId: 'auction-missing',
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).rejects.toBeInstanceOf(PersistedAuctionNotFoundError)

    expect(identifiers.generate).not.toHaveBeenCalled()

    expect(repository.findLeadingBid).not.toHaveBeenCalled()

    expect(repository.findLastBidByBidder).not.toHaveBeenCalled()

    expect(repository.countActiveBidsByBidder).not.toHaveBeenCalled()

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza una puja cuando la subasta ya alcanzo su fecha de cierre sin notificar', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findById.mockResolvedValue({
      ...auction,
      closesAt: new Date('2026-09-21T12:00:10.000Z'),
    })

    await expect(
      useCase.execute({
        operationId: 'operation-closed',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).rejects.toMatchObject({
      code: BidRuleCode.AuctionNotActive,
    })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza que el vendedor puje en su propia subasta sin notificar', async () => {
    const { persistence, notifications, useCase } = dependencies()

    await expect(
      useCase.execute({
        operationId: 'operation-own-auction',
        auctionId: auction.id,
        bidderId: auction.sellerId,
        amountCredits: 30,
      }),
    ).rejects.toMatchObject({
      code: BidRuleCode.SellerCannotBid,
    })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza una oferta que no supera la oferta actual sin notificar', async () => {
    const { persistence, notifications, useCase } = dependencies()

    await expect(
      useCase.execute({
        operationId: 'operation-low',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 20,
      }),
    ).rejects.toMatchObject({
      code: BidRuleCode.BidTooLow,
    })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza una oferta que no cumple el incremento minimo sin notificar', async () => {
    const { persistence, notifications, useCase } = dependencies()

    await expect(
      useCase.execute({
        operationId: 'operation-increment',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 25,
      }),
    ).rejects.toMatchObject({
      code: BidRuleCode.MinimumIncrementNotMet,
    })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza una segunda puja durante el cooldown del jugador sin notificar', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findLastBidByBidder.mockResolvedValue({
      id: 'bid-previous',
      auctionId: 'auction-other',
      bidderId: 'bidder-2',
      amountCredits: 15,
      placedAt: new Date('2026-09-21T12:00:07.000Z'),
    })

    await expect(
      useCase.execute({
        operationId: 'operation-cooldown',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).rejects.toMatchObject({
      code: BidRuleCode.BidCooldownActive,
    })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza al jugador cuando alcanza el limite de 50 pujas activas sin notificar', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.countActiveBidsByBidder.mockResolvedValue(50)

    await expect(
      useCase.execute({
        operationId: 'operation-limit',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).rejects.toMatchObject({
      code: BidRuleCode.ActiveBidLimitReached,
    })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('permite la primera puja y no notifica porque no existe lider anterior', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findLeadingBid.mockResolvedValue(null)

    persistence.execute.mockImplementation(({ bid }) => {
      const result: PersistBidResult = {
        bid: bid.snapshot(),
        previousLeader: null,
        previousLeaderReservationId: null,
      }

      return Promise.resolve(result)
    })

    await expect(
      useCase.execute({
        operationId: 'operation-first-bid',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 10,
      }),
    ).resolves.toMatchObject({
      id: 'bid-generated',
      bidderId: 'bidder-2',
      amountCredits: 10,
    })

    expect(persistence.execute).toHaveBeenCalledTimes(1)

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('un fallo de creditos no genera notificacion', async () => {
    const { persistence, notifications, useCase } = dependencies()

    const creditError = new Error('credit service unavailable')

    persistence.execute.mockRejectedValue(creditError)

    await expect(
      useCase.execute({
        operationId: 'operation-credit-error',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).rejects.toBe(creditError)

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('un fallo temporal de Notifications no convierte una puja confirmada en fallida', async () => {
    const { notifications, useCase } = dependencies()

    notifications.publish.mockRejectedValue(new Error('notifications unavailable'))

    await expect(
      useCase.execute({
        operationId: 'operation-notification-error',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toMatchObject({
      id: 'bid-generated',
      auctionId: auction.id,
      bidderId: 'bidder-2',
      amountCredits: 30,
    })

    expect(notifications.publish).toHaveBeenCalledTimes(1)
  })

  it('las violaciones funcionales siguen siendo errores del dominio', async () => {
    const { notifications, useCase } = dependencies()

    try {
      await useCase.execute({
        operationId: 'operation-domain-error',
        auctionId: auction.id,
        bidderId: auction.sellerId,
        amountCredits: 30,
      })

      throw new Error('La operacion debio ser rechazada.')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BidRuleViolation)
    }

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('reutiliza el bidId original cuando se reintenta el mismo Idempotency-Key', async () => {
    const { repository, persistence, identifiers, useCase } = dependencies()

    repository.findBidCreditOperation.mockResolvedValue(existingOperation())

    persistence.execute.mockImplementation(({ bid }) => {
      const result: PersistBidResult = {
        bid: bid.snapshot(),
        previousLeader: null,
        previousLeaderReservationId: null,
      }

      return Promise.resolve(result)
    })

    await expect(
      useCase.execute({
        operationId: 'operation-existing',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toMatchObject({
      id: 'bid-original',
      auctionId: auction.id,
      bidderId: 'bidder-2',
      amountCredits: 30,
    })

    expect(identifiers.generate).not.toHaveBeenCalled()

    expect(repository.findLeadingBid).not.toHaveBeenCalled()

    expect(repository.findLastBidByBidder).not.toHaveBeenCalled()

    expect(repository.countActiveBidsByBidder).not.toHaveBeenCalled()

    expect(persistence.execute).toHaveBeenCalledWith({
      operationId: 'operation-existing',
      bid: expect.anything(),
      expiresAt: auction.closesAt,
    })
  })

  it('un reintento conserva el mismo identificador idempotente de notificacion', async () => {
    const { repository, persistence, notifications, identifiers, useCase } = dependencies()

    repository.findBidCreditOperation.mockResolvedValue(existingOperation())

    persistence.execute.mockImplementation(({ bid }) =>
      Promise.resolve({
        bid: bid.snapshot(),
        previousLeader: leadingBid,
        previousLeaderReservationId: 'reservation-leading',
      }),
    )

    await expect(
      useCase.execute({
        operationId: 'operation-existing',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toMatchObject({
      id: 'bid-original',
    })

    expect(identifiers.generate).not.toHaveBeenCalled()

    expect(notifications.publish).toHaveBeenCalledTimes(1)

    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'operation-existing:outbid',
        operationId: 'operation-existing',
        recipientPlayerId: 'bidder-leading',
        auctionId: auction.id,
        outbidBidId: 'bid-leading',
        winningBidId: 'bid-original',
        winningBidderId: 'bidder-2',
        winningAmountCredits: 30,
      }),
    )
  })

  it('rechaza reutilizar Idempotency-Key con otra intencion sin notificar', async () => {
    const { repository, persistence, identifiers, notifications, useCase } = dependencies()

    repository.findBidCreditOperation.mockResolvedValue(existingOperation())

    await expect(
      useCase.execute({
        operationId: 'operation-existing',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 40,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    expect(identifiers.generate).not.toHaveBeenCalled()

    expect(repository.findById).not.toHaveBeenCalled()

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza reutilizar Idempotency-Key para otra subasta sin notificar', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findBidCreditOperation.mockResolvedValue(existingOperation())

    await expect(
      useCase.execute({
        operationId: 'operation-existing',
        auctionId: 'auction-other',
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('rechaza reutilizar Idempotency-Key para otro jugador sin notificar', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findBidCreditOperation.mockResolvedValue(existingOperation())

    await expect(
      useCase.execute({
        operationId: 'operation-existing',
        auctionId: auction.id,
        bidderId: 'bidder-other',
        amountCredits: 30,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publish).not.toHaveBeenCalled()
  })

  it('reanuda una operacion durable sin volver a evaluar cooldown ni limite', async () => {
    const { repository, persistence, identifiers, useCase } = dependencies()

    repository.findBidCreditOperation.mockResolvedValue(
      existingOperation({
        status: 'RESERVED',
      }),
    )

    persistence.execute.mockImplementation(({ bid }) => {
      const result: PersistBidResult = {
        bid: bid.snapshot(),
        previousLeader: null,
        previousLeaderReservationId: null,
      }

      return Promise.resolve(result)
    })

    await expect(
      useCase.execute({
        operationId: 'operation-existing',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toMatchObject({
      id: 'bid-original',
    })

    expect(identifiers.generate).not.toHaveBeenCalled()

    expect(repository.findLeadingBid).not.toHaveBeenCalled()

    expect(repository.findLastBidByBidder).not.toHaveBeenCalled()

    expect(repository.countActiveBidsByBidder).not.toHaveBeenCalled()

    expect(persistence.execute).toHaveBeenCalledTimes(1)
  })

  it('no notifica al mismo jugador si el lider anterior pertenece al mismo postor', async () => {
    const { persistence, notifications, useCase } = dependencies()

    persistence.execute.mockImplementation(({ bid }) =>
      Promise.resolve({
        bid: bid.snapshot(),
        previousLeader: {
          ...leadingBid,
          bidderId: 'bidder-2',
        },
        previousLeaderReservationId: 'reservation-leading',
      }),
    )

    await expect(
      useCase.execute({
        operationId: 'operation-self-outbid',
        auctionId: auction.id,
        bidderId: 'bidder-2',
        amountCredits: 30,
      }),
    ).resolves.toBeDefined()

    expect(notifications.publish).not.toHaveBeenCalled()
  })
})
