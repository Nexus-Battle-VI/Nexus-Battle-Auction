import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import {
  AuctionSettlementStatus,
  CaptureStatus,
  ReleaseStatus,
} from '../../src/application/ports/AuctionSettlementRepositoryPort'

const now = new Date('2026-09-23T12:00:00.000Z')
const winner = (auctionId = 'auction-1') => ({
  auctionId,
  resultType: 'WITH_WINNER' as const,
  sellerId: 'seller-1',
  winningBidId: 'bid-winner',
  winnerId: 'winner-1',
  winningHoldId: 'hold-winner',
  finalAmountCredits: 30,
  captureOperationId: `auction:${auctionId}:settlement:capture`,
  createdAt: now,
})

describe('InMemoryAuctionSettlementRepository', () => {
  it('crea WITH_WINNER idempotentemente y devuelve snapshots defensivos', async () => {
    const repository = new InMemoryAuctionSettlementRepository()
    const first = await repository.createIfAbsent(winner())
    const replay = await repository.createIfAbsent({
      ...winner(),
      createdAt: new Date('2027-01-01'),
    })

    expect(first).toMatchObject({
      status: AuctionSettlementStatus.CapturePending,
      captureStatus: CaptureStatus.Pending,
      finalAmountCredits: 30,
    })
    expect(replay.createdAt).toEqual(now)
    first.createdAt.setFullYear(2000)
    expect((await repository.getByAuctionId('auction-1'))?.createdAt).toEqual(now)
  })

  it('crea WITHOUT_BIDS sin captura y permite completarlo', async () => {
    const repository = new InMemoryAuctionSettlementRepository()
    await repository.createIfAbsent({
      auctionId: 'auction-empty',
      resultType: 'WITHOUT_BIDS',
      sellerId: 'seller-1',
      createdAt: now,
    })
    await repository.markCompleted('auction-empty', now)

    await expect(repository.getByAuctionId('auction-empty')).resolves.toMatchObject({
      status: AuctionSettlementStatus.Completed,
      captureStatus: CaptureStatus.NotRequired,
      winningBidId: null,
      winnerId: null,
      winningHoldId: null,
      finalAmountCredits: null,
      captureOperationId: null,
    })
  })

  it('persiste las transiciones de captura y no permite revertir confirmacion', async () => {
    const repository = new InMemoryAuctionSettlementRepository()
    await repository.createIfAbsent(winner())
    await repository.markCaptureRetryable('auction-1', 'timeout', now)
    await repository.markCaptureConfirmed('auction-1', now)

    await expect(repository.getByAuctionId('auction-1')).resolves.toMatchObject({
      status: AuctionSettlementStatus.Captured,
      captureStatus: CaptureStatus.Confirmed,
      lastError: null,
    })
    await expect(repository.markCaptureRetryable('auction-1', 'again', now)).rejects.toThrow()
  })

  it('persiste error terminal de captura', async () => {
    const repository = new InMemoryAuctionSettlementRepository()
    await repository.createIfAbsent(winner())
    await repository.markCaptureTerminal('auction-1', 'denied', now)

    await expect(repository.getByAuctionId('auction-1')).resolves.toMatchObject({
      status: AuctionSettlementStatus.FailedTerminal,
      captureStatus: CaptureStatus.TerminalError,
      lastError: 'denied',
    })
  })

  it('persiste releases idempotentes, transiciones y completado', async () => {
    const repository = new InMemoryAuctionSettlementRepository()
    await repository.createIfAbsent(winner())
    await repository.markCaptureConfirmed('auction-1', now)
    const release = {
      auctionId: 'auction-1',
      bidId: 'bid-loser',
      holdId: 'hold-loser',
      operationId: 'release-1',
      createdAt: now,
    }
    await repository.createReleaseIfAbsent(release)
    await expect(
      repository.createReleaseIfAbsent({ ...release, operationId: 'other' }),
    ).resolves.toMatchObject({ operationId: 'release-1' })
    await repository.markReleaseRetryable('auction-1', 'bid-loser', 'timeout', now)
    await expect(repository.listPendingReleaseTasks('auction-1')).resolves.toHaveLength(1)
    await repository.markReleaseConfirmed('auction-1', 'bid-loser', now)
    await expect(repository.listReleaseTasks('auction-1')).resolves.toMatchObject([
      { status: ReleaseStatus.Released },
    ])
    await expect(
      repository.markReleaseRetryable('auction-1', 'bid-loser', 'again', now),
    ).rejects.toThrow()
    await repository.markCompleted('auction-1', now)
    await expect(repository.getByAuctionId('auction-1')).resolves.toMatchObject({
      status: AuctionSettlementStatus.Completed,
    })
  })

  it('persiste release terminal y bloquea completion', async () => {
    const repository = new InMemoryAuctionSettlementRepository()
    await repository.createIfAbsent(winner())
    await repository.markCaptureConfirmed('auction-1', now)
    await repository.createReleaseIfAbsent({
      auctionId: 'auction-1',
      bidId: 'bid-loser',
      holdId: 'hold-loser',
      operationId: 'release-1',
      createdAt: now,
    })
    await repository.markReleaseTerminal('auction-1', 'bid-loser', 'denied', now)
    await expect(repository.markCompleted('auction-1', now)).rejects.toThrow()
    await expect(repository.listReleaseTasks('auction-1')).resolves.toMatchObject([
      { status: ReleaseStatus.TerminalError },
    ])
  })
})
