import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { CLAIM_PERIOD_MS } from '../../src/domain/entities/AuctionPendingClaim'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { ExpirePendingClaims } from '../../src/application/use-cases/ExpirePendingClaims'

const settledAt = new Date('2026-09-01T12:00:00.000Z')
let now = new Date(settledAt)
const clock: ClockPort = { now: () => new Date(now) }

const logger = (): jest.Mocked<{ info: jest.Mock; warn: jest.Mock }> => ({
  info: jest.fn(),
  warn: jest.fn(),
})

const seed = async (
  pendingClaims: InMemoryAuctionPendingClaimRepository,
  auctionId: string,
  overrides: Partial<{ winnerId: string; settledAt: Date }> = {},
): Promise<void> => {
  const claimSettledAt = overrides.settledAt ?? settledAt
  await pendingClaims.createIfAbsent({
    auctionId,
    winnerId: overrides.winnerId ?? 'winner-1',
    productId: `product-${auctionId}`,
    winningBidId: 'bid-1',
    finalAmountCredits: 30,
    settledAt: claimSettledAt,
    createdAt: claimSettledAt,
  })
}

describe('ExpirePendingClaims', () => {
  beforeEach(() => {
    now = new Date(settledAt)
  })

  it('no procesa nada cuando no hay candidatos vencidos', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-fresh')
    const useCase = new ExpirePendingClaims(pendingClaims, clock, logger(), { batchSize: 10 })

    await expect(useCase.runBatch()).resolves.toEqual({ candidates: 0, expired: 0, skipped: 0 })
  })

  it('el limite exacto del dia 7 no expira (todavia reclamable)', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-boundary')
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS)
    const useCase = new ExpirePendingClaims(pendingClaims, clock, logger(), { batchSize: 10 })

    await useCase.runBatch()

    await expect(pendingClaims.findByAuctionId('auction-boundary')).resolves.toMatchObject({
      claimStatus: 'PENDING',
    })
  })

  it('procesa automaticamente un pendiente 1 ms despues del limite', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-expired')
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)
    const useCase = new ExpirePendingClaims(pendingClaims, clock, logger(), { batchSize: 10 })

    await expect(useCase.runBatch()).resolves.toEqual({ candidates: 1, expired: 1, skipped: 0 })
    await expect(pendingClaims.findByAuctionId('auction-expired')).resolves.toMatchObject({
      claimStatus: 'EXPIRED',
      claimedAt: null,
    })
  })

  it('varios productos vencidos se procesan en una misma ejecucion', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-a')
    await seed(pendingClaims, 'auction-b')
    await seed(pendingClaims, 'auction-fresh', {
      settledAt: new Date(settledAt.getTime() + CLAIM_PERIOD_MS),
    })
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)
    const useCase = new ExpirePendingClaims(pendingClaims, clock, logger(), { batchSize: 10 })

    await expect(useCase.runBatch()).resolves.toEqual({ candidates: 2, expired: 2, skipped: 0 })
    await expect(pendingClaims.findByAuctionId('auction-a')).resolves.toMatchObject({
      claimStatus: 'EXPIRED',
    })
    await expect(pendingClaims.findByAuctionId('auction-b')).resolves.toMatchObject({
      claimStatus: 'EXPIRED',
    })
    await expect(pendingClaims.findByAuctionId('auction-fresh')).resolves.toMatchObject({
      claimStatus: 'PENDING',
    })
  })

  it('reintentar sobre un producto ya expirado es idempotente: no revierte ni duplica trabajo', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-expired')
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)
    const useCase = new ExpirePendingClaims(pendingClaims, clock, logger(), { batchSize: 10 })
    await useCase.runBatch()

    await expect(useCase.runBatch()).resolves.toEqual({ candidates: 0, expired: 0, skipped: 0 })
    await expect(pendingClaims.findByAuctionId('auction-expired')).resolves.toMatchObject({
      claimStatus: 'EXPIRED',
    })
  })

  it('respeta el batchSize configurado', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-a')
    await seed(pendingClaims, 'auction-b')
    await seed(pendingClaims, 'auction-c')
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)
    const useCase = new ExpirePendingClaims(pendingClaims, clock, logger(), { batchSize: 2 })

    await expect(useCase.runBatch()).resolves.toEqual({ candidates: 2, expired: 2, skipped: 0 })
  })

  it('un fallo en un candidato (carrera con otro proceso) no aborta el resto del batch', async () => {
    const pendingClaims = new InMemoryAuctionPendingClaimRepository()
    await seed(pendingClaims, 'auction-race')
    await seed(pendingClaims, 'auction-ok')
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)
    const log = logger()
    const useCase = new ExpirePendingClaims(pendingClaims, clock, log, { batchSize: 10 })
    // Simula que otro proceso reclamo auction-race justo entre el descubrimiento
    // de candidatos y el intento de expirarlo.
    jest
      .spyOn(pendingClaims, 'markExpired')
      .mockImplementationOnce(() => Promise.reject(new Error('carrera simulada')))
      .mockImplementation((auctionId, expiredAt) =>
        InMemoryAuctionPendingClaimRepository.prototype.markExpired.call(
          pendingClaims,
          auctionId,
          expiredAt,
        ),
      )

    await expect(useCase.runBatch()).resolves.toEqual({ candidates: 2, expired: 1, skipped: 1 })
    expect(log.warn).toHaveBeenCalledWith(
      'auction_pending_claim_expire_skipped',
      expect.objectContaining({ detail: 'carrera simulada' }),
    )
  })
})
