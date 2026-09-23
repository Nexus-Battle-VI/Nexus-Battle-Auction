import { InMemoryAuctionInventorySettlementIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'

const now = new Date('2026-09-23T12:00:00.000Z')
const release = {
  auctionId: 'auction-1',
  operationId: 'auction:auction-1:inventory:release',
  action: 'RELEASE' as const,
  commitmentId: 'commitment-1',
  sellerId: 'seller-1',
  productId: 'product-1',
  createdAt: now,
}
const pendingClaim = {
  auctionId: 'auction-2',
  operationId: 'auction:auction-2:inventory:pending-claim',
  action: 'PENDING_CLAIM' as const,
  commitmentId: 'commitment-2',
  sellerId: 'seller-2',
  winnerId: 'winner-2',
  productId: 'product-2',
  createdAt: now,
}

describe('InMemoryAuctionInventorySettlementIntentRepository', () => {
  it('crea y reproduce RELEASE sin ganador', async () => {
    const repository = new InMemoryAuctionInventorySettlementIntentRepository()
    const first = await repository.getOrCreate(release)
    const replay = await repository.getOrCreate(release)
    expect(replay).toEqual(first)
    expect(first).toMatchObject({ action: 'RELEASE', winnerId: null, status: 'PENDING' })
  })

  it('crea y recupera PENDING_CLAIM con ganador durable', async () => {
    const repository = new InMemoryAuctionInventorySettlementIntentRepository()
    await repository.getOrCreate(pendingClaim)
    await expect(repository.getByAuctionId('auction-2')).resolves.toMatchObject({
      action: 'PENDING_CLAIM',
      winnerId: 'winner-2',
      status: 'PENDING',
    })
  })

  it('rechaza un intent incompatible para la misma subasta', async () => {
    const repository = new InMemoryAuctionInventorySettlementIntentRepository()
    await repository.getOrCreate(release)
    await expect(
      repository.getOrCreate({ ...release, action: 'PENDING_CLAIM', winnerId: 'winner-1' }),
    ).rejects.toThrow('Conflicto')
  })

  it('permite PENDING a RETRYABLE y despues CONFIRMED', async () => {
    const repository = new InMemoryAuctionInventorySettlementIntentRepository()
    await repository.getOrCreate(release)
    await expect(repository.markRetryable('auction-1', 'timeout', now)).resolves.toMatchObject({
      status: 'RETRYABLE',
      lastError: 'timeout',
    })
    await expect(repository.markConfirmed('auction-1', now)).resolves.toMatchObject({
      status: 'CONFIRMED',
      confirmedAt: now,
      lastError: null,
    })
  })

  it('mantiene la confirmacion idempotente', async () => {
    const repository = new InMemoryAuctionInventorySettlementIntentRepository()
    await repository.getOrCreate(release)
    const first = await repository.markConfirmed('auction-1', now)
    const replay = await repository.markConfirmed('auction-1', new Date('2026-09-24T12:00:00.000Z'))
    expect(replay.confirmedAt).toEqual(first.confirmedAt)
  })

  it('persiste un error terminal', async () => {
    const repository = new InMemoryAuctionInventorySettlementIntentRepository()
    await repository.getOrCreate(release)
    await expect(repository.markTerminalError('auction-1', 'conflict', now)).resolves.toMatchObject(
      { status: 'TERMINAL_ERROR', lastError: 'conflict' },
    )
  })
})
