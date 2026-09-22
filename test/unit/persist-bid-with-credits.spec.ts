import {
  BidCreditCompensationError,
  InsufficientBidCreditsError,
} from '../../src/application/errors/BidCreditError'
import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
  PersistBidResult,
} from '../../src/application/ports/AuctionRepositoryPort'
import type { BidCreditsPort } from '../../src/application/ports/BidCreditsPort'
import { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { Bid } from '../../src/domain/entities/Bid'

const now = new Date('2026-09-21T12:00:10.000Z')

const expiresAt = new Date('2026-09-22T12:00:00.000Z')

const createBid = (bidId = 'bid-63-2-1', bidderId = 'bidder-1', amountCredits = 20) =>
  Bid.register({
    bidId,
    auctionId: 'auction-63-2',
    bidderId,
    amountCredits,
    placedAt: now,
    eligibility: {
      auctionStatus: 'ACTIVE',
      sellerId: 'seller-1',
      currentBidCredits: 10,
      minimumIncrementCredits: 5,
      lastBidAtByBidder: null,
      activeBidCount: 0,
    },
  })

const cloneOperation = (operation: BidCreditOperationSnapshot): BidCreditOperationSnapshot => ({
  ...operation,
  createdAt: new Date(operation.createdAt),
  updatedAt: new Date(operation.updatedAt),
})

const dependencies = () => {
  let storedOperation: BidCreditOperationSnapshot | null = null

  let previousReservationId: string | null = null

  let previousLeader: ReturnType<ReturnType<typeof createBid>['snapshot']> | null = null

  const repository = {
    publish: jest.fn(),

    recordFailure: jest.fn(() => Promise.resolve()),

    recordBidCreditFailure: jest.fn(() => Promise.resolve()),

    createBidCreditOperation: jest.fn((command) => {
      storedOperation ??= {
        operationId: command.operationId,
        bidId: command.bidId,
        auctionId: command.auctionId,
        bidderId: command.bidderId,
        amountCredits: command.amountCredits,
        status: 'PENDING_RESERVATION',
        reservationId: null,
        previousReservationId: null,
        createdAt: new Date(command.createdAt),
        updatedAt: new Date(command.createdAt),
      }

      return Promise.resolve()
    }),

    updateBidCreditOperation: jest.fn((command) => {
      if (storedOperation === null) {
        return Promise.reject(new Error('Operacion inexistente.'))
      }

      storedOperation = {
        ...storedOperation,
        status: command.status,
        reservationId: command.reservationId,
        previousReservationId: command.previousReservationId,
        updatedAt: new Date(command.updatedAt),
      }

      return Promise.resolve()
    }),

    findBidCreditOperation: jest.fn(() =>
      Promise.resolve(storedOperation === null ? null : cloneOperation(storedOperation)),
    ),

    findById: jest.fn(() => Promise.resolve(null)),

    countActiveBySeller: jest.fn(() => Promise.resolve(0)),

    persistBid: jest.fn((bid, reservationId, operationId) => {
      if (storedOperation !== null && operationId !== null && operationId !== undefined) {
        storedOperation = {
          ...storedOperation,
          status: 'BID_PERSISTED',
          reservationId: reservationId ?? null,
          previousReservationId,
          updatedAt: new Date(now),
        }
      }

      const result: PersistBidResult = {
        bid: bid.snapshot(),
        previousLeader,
        previousLeaderReservationId: previousReservationId,
      }

      return Promise.resolve(result)
    }),

    findLeadingBid: jest.fn(() => Promise.resolve(null)),

    findBidHistory: jest.fn(),
  } as unknown as jest.Mocked<AuctionRepositoryPort>

  const credits = {
    getAvailableCredits: jest.fn(() =>
      Promise.resolve({
        availableCredits: 100,
      }),
    ),

    reserve: jest.fn(() =>
      Promise.resolve({
        reservationId: 'reservation-new',
      }),
    ),

    release: jest.fn(() => Promise.resolve()),
  } as unknown as jest.Mocked<BidCreditsPort>

  const clock = {
    now: () => new Date(now),
  }

  const useCase = new PersistBidWithCredits(repository, credits, clock)

  const prepareHistory = (bid = createBid()): void => {
    repository.findBidHistory.mockResolvedValue(
      previousLeader === null ? [bid.snapshot()] : [previousLeader, bid.snapshot()],
    )
  }

  return {
    repository,
    credits,
    useCase,

    setPreviousLeader: (
      leader: ReturnType<ReturnType<typeof createBid>['snapshot']> | null,
      reservationId: string | null,
    ): void => {
      previousLeader = leader

      previousReservationId = reservationId
    },

    setStoredOperation: (operation: BidCreditOperationSnapshot): void => {
      storedOperation = cloneOperation(operation)
    },

    getStoredOperation: (): BidCreditOperationSnapshot | null =>
      storedOperation === null ? null : cloneOperation(storedOperation),

    prepareHistory,
  }
}

describe('PersistBidWithCredits HU-63.2', () => {
  it('registra la intencion antes de reservar creditos', async () => {
    const { repository, credits, useCase, prepareHistory } = dependencies()

    const bid = createBid()

    prepareHistory(bid)

    await useCase.execute({
      operationId: 'operation-bid-1',
      bid,
      expiresAt,
    })

    expect(repository.createBidCreditOperation).toHaveBeenCalledWith({
      operationId: 'operation-bid-1',
      bidId: 'bid-63-2-1',
      auctionId: 'auction-63-2',
      bidderId: 'bidder-1',
      amountCredits: 20,
      createdAt: now,
    })

    expect(repository.createBidCreditOperation.mock.invocationCallOrder[0]).toBeLessThan(
      credits.reserve.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    )
  })

  it('reserva creditos con un operationId externo independiente', async () => {
    const { repository, credits, useCase, prepareHistory } = dependencies()

    const bid = createBid()

    prepareHistory(bid)

    await expect(
      useCase.execute({
        operationId: 'operation-bid-1',
        bid,
        expiresAt,
      }),
    ).resolves.toMatchObject({
      bid: bid.snapshot(),
    })

    expect(credits.getAvailableCredits).toHaveBeenCalledWith('bidder-1')

    expect(credits.reserve).toHaveBeenCalledWith({
      operationId: 'operation-bid-1:reserve',
      bidderId: 'bidder-1',
      bidId: 'bid-63-2-1',
      auctionId: 'auction-63-2',
      amount: 20,
      expiresAt,
    })

    expect(repository.persistBid).toHaveBeenCalledWith(bid, 'reservation-new', 'operation-bid-1')
  })

  it('termina la operacion en COMPLETED cuando la puja no tenia lider anterior', async () => {
    const { useCase, getStoredOperation, prepareHistory } = dependencies()

    const bid = createBid()

    prepareHistory(bid)

    await useCase.execute({
      operationId: 'operation-completed',
      bid,
      expiresAt,
    })

    expect(getStoredOperation()).toMatchObject({
      operationId: 'operation-completed',
      status: 'COMPLETED',
      reservationId: 'reservation-new',
      previousReservationId: null,
    })
  })

  it('rechaza saldo insuficiente sin reservar creditos', async () => {
    const { repository, credits, useCase } = dependencies()

    credits.getAvailableCredits.mockResolvedValue({
      availableCredits: 10,
    })

    const bid = createBid()

    await expect(
      useCase.execute({
        operationId: 'operation-insufficient',
        bid,
        expiresAt,
      }),
    ).rejects.toBeInstanceOf(InsufficientBidCreditsError)

    expect(credits.reserve).not.toHaveBeenCalled()

    expect(repository.persistBid).not.toHaveBeenCalled()

    expect(repository.recordBidCreditFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation-insufficient',
        stage: 'CHECKING_BALANCE',
        newReservationId: null,
      }),
    )
  })

  it('compensa la nueva reserva si falla la persistencia', async () => {
    const { repository, credits, useCase, getStoredOperation } = dependencies()

    const bid = createBid()

    repository.persistBid.mockRejectedValue(new Error('database unavailable'))

    await expect(
      useCase.execute({
        operationId: 'operation-persistence-failure',
        bid,
        expiresAt,
      }),
    ).rejects.toThrow('database unavailable')

    expect(credits.release).toHaveBeenCalledWith(
      'operation-persistence-failure:release-new',
      'reservation-new',
    )

    expect(getStoredOperation()).toMatchObject({
      status: 'COMPENSATED',
      reservationId: 'reservation-new',
    })

    expect(repository.recordBidCreditFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'PERSISTING_BID',
        newReservationReleased: true,
      }),
    )
  })

  it('deja COMPENSATION_PENDING cuando falla la liberacion compensatoria', async () => {
    const { repository, credits, useCase, getStoredOperation } = dependencies()

    const bid = createBid()

    repository.persistBid.mockRejectedValue(new Error('database unavailable'))

    credits.release.mockRejectedValue(new Error('wallet unavailable'))

    await expect(
      useCase.execute({
        operationId: 'operation-compensation-pending',
        bid,
        expiresAt,
      }),
    ).rejects.toBeInstanceOf(BidCreditCompensationError)

    expect(getStoredOperation()).toMatchObject({
      status: 'COMPENSATION_PENDING',
      reservationId: 'reservation-new',
    })

    expect(repository.recordBidCreditFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'RELEASING_NEW_RESERVATION',
        newReservationReleased: false,
      }),
    )
  })

  it('reanuda una compensacion pendiente sin volver a reservar creditos', async () => {
    const { credits, useCase, setStoredOperation, getStoredOperation } = dependencies()

    const bid = createBid()

    const snapshot = bid.snapshot()

    setStoredOperation({
      operationId: 'operation-retry-compensation',
      bidId: snapshot.id,
      auctionId: snapshot.auctionId,
      bidderId: snapshot.bidderId,
      amountCredits: snapshot.amountCredits,
      status: 'COMPENSATION_PENDING',
      reservationId: 'reservation-existing',
      previousReservationId: null,
      createdAt: now,
      updatedAt: now,
    })

    await expect(
      useCase.execute({
        operationId: 'operation-retry-compensation',
        bid,
        expiresAt,
      }),
    ).rejects.toThrow('fue compensada')

    expect(credits.reserve).not.toHaveBeenCalled()

    expect(credits.release).toHaveBeenCalledWith(
      'operation-retry-compensation:release-new',
      'reservation-existing',
    )

    expect(getStoredOperation()).toMatchObject({
      status: 'COMPENSATED',
    })
  })

  it('libera la reserva del lider anterior con su propio operationId', async () => {
    const { repository, credits, useCase, setPreviousLeader, prepareHistory, getStoredOperation } =
      dependencies()

    const bid = createBid('bid-new', 'bidder-2', 30)

    const oldBid = createBid('bid-old', 'bidder-1', 20).snapshot()

    setPreviousLeader(oldBid, 'reservation-old')

    prepareHistory(bid)

    await expect(
      useCase.execute({
        operationId: 'operation-release-previous',
        bid,
        expiresAt,
      }),
    ).resolves.toMatchObject({
      bid: bid.snapshot(),
      previousLeader: oldBid,
      previousLeaderReservationId: 'reservation-old',
    })

    expect(credits.release).toHaveBeenCalledWith(
      'operation-release-previous:release-previous',
      'reservation-old',
    )

    expect(getStoredOperation()).toMatchObject({
      status: 'COMPLETED',
      previousReservationId: 'reservation-old',
    })

    expect(repository.recordBidCreditFailure).not.toHaveBeenCalled()
  })

  it('si falla liberar al lider anterior conserva BID_PERSISTED para reintentar', async () => {
    const { repository, credits, useCase, setPreviousLeader, prepareHistory, getStoredOperation } =
      dependencies()

    const bid = createBid('bid-new', 'bidder-2', 30)

    const oldBid = createBid('bid-old', 'bidder-1', 20).snapshot()

    setPreviousLeader(oldBid, 'reservation-old')

    prepareHistory(bid)

    credits.release.mockRejectedValue(new Error('wallet release unavailable'))

    await expect(
      useCase.execute({
        operationId: 'operation-release-failure',
        bid,
        expiresAt,
      }),
    ).rejects.toThrow('wallet release unavailable')

    expect(getStoredOperation()).toMatchObject({
      status: 'BID_PERSISTED',
      reservationId: 'reservation-new',
      previousReservationId: 'reservation-old',
    })

    expect(repository.recordBidCreditFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'RELEASING_PREVIOUS_RESERVATION',
        previousReservationId: 'reservation-old',
      }),
    )
  })

  it('reanuda BID_PERSISTED sin crear una segunda reserva ni persistir otra puja', async () => {
    const { repository, credits, useCase, setStoredOperation } = dependencies()

    const bid = createBid('bid-retry', 'bidder-2', 30)

    const oldBid = createBid('bid-old', 'bidder-1', 20).snapshot()

    const snapshot = bid.snapshot()

    setStoredOperation({
      operationId: 'operation-retry',
      bidId: snapshot.id,
      auctionId: snapshot.auctionId,
      bidderId: snapshot.bidderId,
      amountCredits: snapshot.amountCredits,
      status: 'BID_PERSISTED',
      reservationId: 'reservation-new',
      previousReservationId: 'reservation-old',
      createdAt: now,
      updatedAt: now,
    })

    repository.findBidHistory.mockResolvedValue([oldBid, snapshot])

    await expect(
      useCase.execute({
        operationId: 'operation-retry',
        bid,
        expiresAt,
      }),
    ).resolves.toMatchObject({
      bid: snapshot,
      previousLeader: oldBid,
      previousLeaderReservationId: 'reservation-old',
    })

    expect(credits.reserve).not.toHaveBeenCalled()

    expect(repository.persistBid).not.toHaveBeenCalled()

    expect(credits.release).toHaveBeenCalledWith(
      'operation-retry:release-previous',
      'reservation-old',
    )
  })
})
