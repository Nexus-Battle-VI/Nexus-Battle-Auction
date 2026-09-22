import {
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../src/application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
  PersistBidResult,
} from '../../src/application/ports/AuctionRepositoryPort'
import type { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
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

  const clock = {
    now: (): Date => new Date(now),
  }

  const identifiers = {
    generate: jest.fn(() => 'bid-generated'),
  }

  const useCase = new RegisterBid(repository, persistence, clock, identifiers)

  return {
    repository,
    persistence,
    identifiers,
    useCase,
  }
}

describe('RegisterBid HU-63.4', () => {
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

  it('rechaza una subasta inexistente antes de crear o persistir la puja', async () => {
    const { repository, persistence, identifiers, useCase } = dependencies()

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
  })

  it('rechaza una puja cuando la subasta ya alcanzo su fecha de cierre', async () => {
    const { repository, persistence, useCase } = dependencies()

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
  })

  it('rechaza que el vendedor puje en su propia subasta', async () => {
    const { persistence, useCase } = dependencies()

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
  })

  it('rechaza una oferta que no supera la oferta actual', async () => {
    const { persistence, useCase } = dependencies()

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
  })

  it('rechaza una oferta que no cumple el incremento minimo', async () => {
    const { persistence, useCase } = dependencies()

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
  })

  it('rechaza una segunda puja durante el cooldown del jugador', async () => {
    const { repository, persistence, useCase } = dependencies()

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
  })

  it('rechaza al jugador cuando ya alcanza el limite de 50 pujas activas', async () => {
    const { repository, persistence, useCase } = dependencies()

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
  })

  it('permite la primera puja cuando no existe lider', async () => {
    const { repository, persistence, useCase } = dependencies()

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
  })

  it('propaga los errores de creditos sin convertirlos dentro del caso de uso', async () => {
    const { persistence, useCase } = dependencies()

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
  })

  it('las violaciones funcionales siguen siendo errores del dominio', async () => {
    const { useCase } = dependencies()

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

    const retriedCommand = persistence.execute.mock.calls[0]?.[0]

    expect(retriedCommand?.bid.snapshot()).toMatchObject({
      id: 'bid-original',
      auctionId: auction.id,
      bidderId: 'bidder-2',
      amountCredits: 30,
    })
  })

  it('rechaza reutilizar Idempotency-Key con otra intencion', async () => {
    const { repository, persistence, identifiers, useCase } = dependencies()

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
  })

  it('rechaza reutilizar Idempotency-Key para otra subasta', async () => {
    const { repository, persistence, useCase } = dependencies()

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
  })

  it('rechaza reutilizar Idempotency-Key para otro jugador', async () => {
    const { repository, persistence, useCase } = dependencies()

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
  })

  it('reanuda una operacion durable sin volver a evaluar cooldown ni limite de pujas', async () => {
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
})
