import type {
  AuctionRepositoryPort,
  PersistBidResult,
} from '../../src/application/ports/AuctionRepositoryPort'
import type {
  AutoBidLimitReachedNotification,
  OutbidNotification,
  OutbidNotificationPort,
} from '../../src/application/ports/OutbidNotificationPort'
import { ConcurrentBidConflictError } from '../../src/application/errors/AuctionPersistenceError'
import type { PersistBidWithCredits } from '../../src/application/use-cases/PersistBidWithCredits'
import { ReactToRivalBid } from '../../src/application/use-cases/ReactToRivalBid'
import { AuctionStatus, type AuctionSnapshot } from '../../src/domain/entities/Auction'
import type { AutoBidConfigSnapshot } from '../../src/domain/entities/AutoBidConfig'
import type { BidSnapshot } from '../../src/domain/entities/Bid'
import { BidRuleCode, BidRuleViolation } from '../../src/domain/errors/BidRuleViolation'

const now = new Date('2026-09-21T12:01:00.000Z')

const auction: AuctionSnapshot = {
  id: 'auction-67-2',
  sellerId: 'seller-1',
  productId: 'product-1',
  durationHours: 24,
  publicationFeeCredits: 1,
  minimumBidCredits: 10,
  buyNowCredits: null,
  status: AuctionStatus.Active,
  publishedAt: new Date('2026-09-21T12:00:00.000Z'),
  closesAt: new Date('2026-09-22T12:00:00.000Z'),
}

const leadingBid: BidSnapshot = {
  id: 'bid-human',
  auctionId: auction.id,
  bidderId: 'bidder-human',
  amountCredits: 30,
  placedAt: now,
}

const autoBidConfig = (
  bidderId: string,
  maxAmountCredits: number,
  configuredAt: Date,
): AutoBidConfigSnapshot => ({
  auctionId: auction.id,
  bidderId,
  maxAmountCredits,
  configuredAt,
  isActive: true,
})

const dependencies = () => {
  const repository = {
    findById: jest.fn(() => Promise.resolve<AuctionSnapshot | null>(auction)),

    findActiveAutoBidsForAuction: jest.fn(() =>
      Promise.resolve<readonly AutoBidConfigSnapshot[]>([]),
    ),

    findLastBidByBidder: jest.fn(() => Promise.resolve<BidSnapshot | null>(null)),

    countActiveBidsByBidder: jest.fn(() => Promise.resolve(0)),

    findLeadingBid: jest.fn(() => Promise.resolve<BidSnapshot | null>(leadingBid)),
  } as unknown as jest.Mocked<AuctionRepositoryPort>

  const persistence = {
    execute: jest.fn(({ bid }) => {
      const result: PersistBidResult = {
        bid: bid.snapshot(),
        previousLeader: leadingBid,
        previousLeaderReservationId: 'reservation-human',
      }

      return Promise.resolve(result)
    }),
  } as unknown as jest.Mocked<PersistBidWithCredits>

  const notifications: jest.Mocked<OutbidNotificationPort> = {
    publish: jest.fn((notification: OutbidNotification): Promise<void> => {
      void notification

      return Promise.resolve()
    }),

    publishAutoBidLimitReached: jest.fn(
      (notification: AutoBidLimitReachedNotification): Promise<void> => {
        void notification

        return Promise.resolve()
      },
    ),
  }

  let nextId = 0

  const identifiers = {
    generate: jest.fn(() => `auto-bid-${String(++nextId)}`),
  }

  const clock = { now: (): Date => new Date(now) }

  const useCase = new ReactToRivalBid(repository, persistence, clock, identifiers, notifications)

  return { repository, persistence, notifications, identifiers, clock, useCase }
}

describe('ReactToRivalBid HU-67.2', () => {
  it('no reacciona cuando no hay pujas automaticas activas', async () => {
    const { repository, persistence, useCase } = dependencies()

    await useCase.execute({ operationId: 'operation-1', leadingBid })

    expect(repository.findActiveAutoBidsForAuction).toHaveBeenCalledWith(auction.id, 'bidder-human')

    expect(persistence.execute).not.toHaveBeenCalled()
  })

  it('CA-01: reacciona con el incremento minimo sin superar el limite configurado', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findActiveAutoBidsForAuction.mockResolvedValueOnce([
      autoBidConfig('bidder-auto', 100, new Date('2026-09-21T12:00:30.000Z')),
    ])

    await useCase.execute({ operationId: 'operation-ca-01', leadingBid })

    expect(persistence.execute).toHaveBeenCalledTimes(1)

    const persistedCommand = persistence.execute.mock.calls[0]?.[0]

    expect(persistedCommand?.operationId).toBe('operation-ca-01:auto:1')

    expect(persistedCommand?.bid.snapshot()).toMatchObject({
      bidderId: 'bidder-auto',
      amountCredits: 40,
    })

    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPlayerId: 'bidder-human',
        winningBidderId: 'bidder-auto',
        winningAmountCredits: 40,
      }),
    )
  })

  it('CA-02: no reacciona cuando la siguiente oferta necesaria supera el limite y avisa (HU-67.3)', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    repository.findActiveAutoBidsForAuction.mockResolvedValueOnce([
      autoBidConfig('bidder-auto', 35, new Date('2026-09-21T12:00:30.000Z')),
    ])

    await useCase.execute({ operationId: 'operation-ca-02', leadingBid })

    expect(persistence.execute).not.toHaveBeenCalled()

    expect(notifications.publishAutoBidLimitReached).toHaveBeenCalledTimes(1)

    expect(notifications.publishAutoBidLimitReached).toHaveBeenCalledWith({
      notificationId: 'operation-ca-02:auto:limit:bidder-auto',
      operationId: 'operation-ca-02',
      recipientPlayerId: 'bidder-auto',
      auctionId: auction.id,
      autoBidLimitCredits: 35,
      requiredAmountCredits: 40,
      leadingBidderId: 'bidder-human',
      occurredAt: now,
    })
  })

  it('avisa el limite alcanzado una sola vez aunque el candidato siga sin poder reaccionar', async () => {
    const { repository, persistence, notifications, useCase } = dependencies()

    const priced = autoBidConfig('bidder-priced-out', 35, new Date('2026-09-21T12:00:30.000Z'))

    const strong = autoBidConfig('bidder-strong', 1000, new Date('2026-09-21T12:00:10.000Z'))

    repository.findActiveAutoBidsForAuction.mockImplementation((_auctionId, excludeBidderId) =>
      Promise.resolve([priced, strong].filter((c) => c.bidderId !== excludeBidderId)),
    )

    await useCase.execute({ operationId: 'operation-once', leadingBid })

    // Ronda 1: bidder-priced-out (35) no alcanza 40 y se avisa+excluye;
    // bidder-strong (1000) gana y pasa a liderar. Ronda 2: el unico otro
    // candidato ya esta excluido, asi que la cadena termina sin volver a
    // evaluar (ni volver a avisar) a bidder-priced-out.
    expect(persistence.execute).toHaveBeenCalledTimes(1)

    expect(notifications.publishAutoBidLimitReached).toHaveBeenCalledTimes(1)
  })

  it('encadena rondas alternando entre los dos limites mas altos hasta que ninguno alcance', async () => {
    const { repository, persistence, useCase } = dependencies()

    const weak = autoBidConfig('bidder-weak', 45, new Date('2026-09-21T12:00:10.000Z'))
    const middle = autoBidConfig('bidder-middle', 80, new Date('2026-09-21T12:00:20.000Z'))
    const strong = autoBidConfig('bidder-strong', 200, new Date('2026-09-21T12:00:30.000Z'))

    repository.findActiveAutoBidsForAuction.mockImplementation((_auctionId, excludeBidderId) =>
      Promise.resolve([weak, middle, strong].filter((c) => c.bidderId !== excludeBidderId)),
    )

    await useCase.execute({ operationId: 'operation-chain', leadingBid })

    const amounts = persistence.execute.mock.calls.map(
      ([command]) => command.bid.snapshot().amountCredits,
    )

    const bidders = persistence.execute.mock.calls.map(
      ([command]) => command.bid.snapshot().bidderId,
    )

    /*
     * El lider parte en 30. En cada ronda el ganador (candidato con mayor
     * limite que aun alcance el incremento minimo) queda excluido de sus
     * propios candidatos en la ronda siguiente, asi que los dos limites mas
     * altos se turnan el liderazgo hasta que "bidder-middle" (80) ya no
     * alcanza el incremento minimo (90). "bidder-weak" (45) solo alcanzaba
     * la primera ronda (40) pero nunca fue el candidato mas fuerte.
     */
    expect(amounts).toEqual([40, 50, 60, 70, 80])
    expect(bidders).toEqual([
      'bidder-strong',
      'bidder-middle',
      'bidder-strong',
      'bidder-middle',
      'bidder-strong',
    ])

    expect(persistence.execute).toHaveBeenCalledTimes(5)
  })

  it('salta a un candidato con menor limite si el mejor incumple una regla de dominio', async () => {
    const { repository, persistence, useCase } = dependencies()

    const strong = autoBidConfig('bidder-strong', 200, new Date('2026-09-21T12:00:10.000Z'))
    const weak = autoBidConfig('bidder-weak', 100, new Date('2026-09-21T12:00:20.000Z'))

    repository.findActiveAutoBidsForAuction.mockResolvedValueOnce([strong, weak])

    repository.countActiveBidsByBidder.mockImplementation((bidderId) =>
      Promise.resolve(bidderId === 'bidder-strong' ? 50 : 0),
    )

    await useCase.execute({ operationId: 'operation-fallback', leadingBid })

    expect(persistence.execute).toHaveBeenCalledTimes(1)

    expect(persistence.execute.mock.calls[0]?.[0]?.bid.snapshot()).toMatchObject({
      bidderId: 'bidder-weak',
      amountCredits: 40,
    })
  })

  it('ante un conflicto de concurrencia relee el lider real y continua', async () => {
    const { repository, persistence, useCase } = dependencies()

    const candidate = autoBidConfig('bidder-auto', 200, new Date('2026-09-21T12:00:10.000Z'))

    repository.findActiveAutoBidsForAuction
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([])

    const refreshedLeader: BidSnapshot = {
      id: 'bid-refreshed',
      auctionId: auction.id,
      bidderId: 'bidder-concurrent',
      amountCredits: 90,
      placedAt: now,
    }

    repository.findLeadingBid.mockResolvedValueOnce(refreshedLeader)

    persistence.execute.mockRejectedValueOnce(new ConcurrentBidConflictError())

    await useCase.execute({ operationId: 'operation-conflict', leadingBid })

    expect(repository.findLeadingBid).toHaveBeenCalledWith(auction.id)

    expect(repository.findActiveAutoBidsForAuction).toHaveBeenNthCalledWith(
      2,
      auction.id,
      'bidder-concurrent',
    )
  })

  it('no reacciona si la subasta ya cerro', async () => {
    const { repository, persistence, useCase } = dependencies()

    repository.findById.mockResolvedValueOnce({
      ...auction,
      closesAt: new Date('2026-09-21T12:00:59.000Z'),
    })

    await useCase.execute({ operationId: 'operation-closed', leadingBid })

    expect(repository.findActiveAutoBidsForAuction).not.toHaveBeenCalled()

    expect(persistence.execute).not.toHaveBeenCalled()
  })

  it('no reacciona si la subasta ya no existe', async () => {
    const { repository, persistence, useCase } = dependencies()

    repository.findById.mockResolvedValueOnce(null)

    await useCase.execute({ operationId: 'operation-missing', leadingBid })

    expect(persistence.execute).not.toHaveBeenCalled()
  })

  it('nunca propaga un error: un fallo inesperado deja la cadena en silencio', async () => {
    const { repository, persistence, useCase } = dependencies()

    repository.findActiveAutoBidsForAuction.mockResolvedValueOnce([
      autoBidConfig('bidder-auto', 100, new Date('2026-09-21T12:00:30.000Z')),
    ])

    persistence.execute.mockRejectedValueOnce(new Error('wallet unavailable'))

    await expect(
      useCase.execute({ operationId: 'operation-unexpected-error', leadingBid }),
    ).resolves.toBeUndefined()
  })

  it('excluye a un candidato en cooldown solo para esta cadena y prueba al siguiente', async () => {
    const { repository, persistence, useCase } = dependencies()

    const first = autoBidConfig('bidder-cooldown', 200, new Date('2026-09-21T12:00:10.000Z'))
    const second = autoBidConfig('bidder-ok', 90, new Date('2026-09-21T12:00:20.000Z'))

    repository.findActiveAutoBidsForAuction.mockImplementation((_auctionId, excludeBidderId) =>
      Promise.resolve([first, second].filter((c) => c.bidderId !== excludeBidderId)),
    )

    const cooldownError = new BidRuleViolation(
      BidRuleCode.BidCooldownActive,
      'Debe esperar al menos 5 segundos entre pujas consecutivas.',
    )

    let calls = 0

    persistence.execute.mockImplementation(({ bid }) => {
      calls += 1

      if (bid.bidderId.value === 'bidder-cooldown') {
        return Promise.reject(cooldownError)
      }

      const result: PersistBidResult = {
        bid: bid.snapshot(),
        previousLeader: leadingBid,
        previousLeaderReservationId: 'reservation-human',
      }

      return Promise.resolve(result)
    })

    await useCase.execute({ operationId: 'operation-cooldown', leadingBid })

    expect(calls).toBe(2)

    const bidders = persistence.execute.mock.calls.map(
      ([command]) => command.bid.snapshot().bidderId,
    )

    expect(bidders).toEqual(['bidder-cooldown', 'bidder-ok'])
  })
})
