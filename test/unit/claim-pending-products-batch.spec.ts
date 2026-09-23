import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { Auction } from '../../src/domain/entities/Auction'
import { CLAIM_PERIOD_MS } from '../../src/domain/entities/AuctionPendingClaim'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  ConfirmInventoryProductClaimCommand,
  ClaimedInventoryProductCommitment,
  ProductInventoryPort,
} from '../../src/application/ports/ProductInventoryPort'
import { ClaimPendingProduct } from '../../src/application/use-cases/ClaimPendingProduct'
import { ClaimPendingProductsBatch } from '../../src/application/use-cases/ClaimPendingProductsBatch'

const settledAt = new Date('2026-09-01T12:00:00.000Z')
let now = new Date(settledAt)
const clock: ClockPort = { now: () => new Date(now) }

class FakeInventory implements ProductInventoryPort {
  readonly failingAuctionIds = new Set<string>()

  readonly confirmClaim = jest.fn(
    (command: ConfirmInventoryProductClaimCommand): Promise<ClaimedInventoryProductCommitment> => {
      if (this.failingAuctionIds.has(command.auctionId)) {
        return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
      }
      return Promise.resolve({
        operationId: command.operationId,
        commitmentId: command.commitmentId,
        status: 'CLAIMED',
        winnerId: command.winnerId,
        applied: true,
      })
    },
  )

  inspect(): Promise<never> {
    return Promise.reject(new Error('No debe invocarse inspect durante el reclamo.'))
  }

  commit(): Promise<never> {
    return Promise.reject(new Error('No debe invocarse commit durante el reclamo.'))
  }

  release(): Promise<never> {
    return Promise.reject(new Error('No debe invocarse release durante el reclamo.'))
  }

  markPendingClaim(): Promise<never> {
    return Promise.reject(new Error('No debe invocarse markPendingClaim durante el reclamo.'))
  }
}

const publish = async (repository: InMemoryAuctionRepository, auctionId: string): Promise<void> => {
  await repository.publish({
    operationId: `publish-${auctionId}`,
    auction: Auction.publish({
      auctionId,
      sellerId: 'seller-1',
      productId: `product-${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      publishedAt: new Date('2026-08-30T12:00:00.000Z'),
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    }),
    inventoryCommitmentId: `commitment-${auctionId}`,
    feeChargeId: `charge-${auctionId}`,
  })
}

const setup = () => {
  const auctions = new InMemoryAuctionRepository()
  const pendingClaims = new InMemoryAuctionPendingClaimRepository()
  const inventory = new FakeInventory()
  const claimPendingProduct = new ClaimPendingProduct(pendingClaims, auctions, inventory, clock)
  const useCase = new ClaimPendingProductsBatch(claimPendingProduct, pendingClaims)
  return { auctions, pendingClaims, inventory, useCase }
}

const seedClaim = async (
  auctions: InMemoryAuctionRepository,
  pendingClaims: InMemoryAuctionPendingClaimRepository,
  auctionId: string,
  overrides: Partial<{ winnerId: string; settledAt: Date }> = {},
): Promise<void> => {
  await publish(auctions, auctionId)
  await pendingClaims.createIfAbsent({
    auctionId,
    winnerId: overrides.winnerId ?? 'winner-1',
    productId: `product-${auctionId}`,
    winningBidId: 'bid-1',
    finalAmountCredits: 30,
    settledAt: overrides.settledAt ?? settledAt,
    createdAt: overrides.settledAt ?? settledAt,
  })
}

const byAuctionId = (
  results: readonly { auctionId: string }[],
  auctionId: string,
): { auctionId: string } | undefined => results.find((item) => item.auctionId === auctionId)

describe('ClaimPendingProductsBatch', () => {
  beforeEach(() => {
    now = new Date(settledAt)
  })

  it('reclama en bloque 100% exitoso', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-a')
    await seedClaim(auctions, pendingClaims, 'auction-b')
    await seedClaim(auctions, pendingClaims, 'auction-c')

    const result = await useCase.execute({
      winnerId: 'winner-1',
      auctionIds: ['auction-a', 'auction-b', 'auction-c'],
    })

    expect(result.results).toHaveLength(3)
    expect(result.results.every((item) => item.status === 'CLAIMED')).toBe(true)
    expect(inventory.confirmClaim).toHaveBeenCalledTimes(3)
  })

  it('reclama en bloque parcialmente exitoso sin abortar por un fallo individual', async () => {
    const { auctions, pendingClaims, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-ok')
    await seedClaim(auctions, pendingClaims, 'auction-expired', {
      settledAt: new Date(now.getTime() - CLAIM_PERIOD_MS - 1),
    })
    await seedClaim(auctions, pendingClaims, 'auction-not-owned', { winnerId: 'otro-jugador' })
    await seedClaim(auctions, pendingClaims, 'auction-already-claimed')
    await pendingClaims.markClaimed('auction-already-claimed', now)

    const result = await useCase.execute({
      winnerId: 'winner-1',
      auctionIds: ['auction-ok', 'auction-expired', 'auction-not-owned', 'auction-already-claimed'],
    })

    expect(result.results).toHaveLength(4)
    expect(byAuctionId(result.results, 'auction-ok')).toMatchObject({ status: 'CLAIMED' })
    expect(byAuctionId(result.results, 'auction-expired')).toMatchObject({ status: 'EXPIRED' })
    expect(byAuctionId(result.results, 'auction-not-owned')).toMatchObject({ status: 'NOT_OWNED' })
    expect(byAuctionId(result.results, 'auction-already-claimed')).toMatchObject({
      status: 'ALREADY_CLAIMED',
    })
    await expect(pendingClaims.findByAuctionId('auction-ok')).resolves.toMatchObject({
      claimStatus: 'CLAIMED',
    })
  })

  it('deduplica auctionIds repetidos: nunca reclama dos veces el mismo item', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-dup')

    const result = await useCase.execute({
      winnerId: 'winner-1',
      auctionIds: ['auction-dup', 'auction-dup', 'auction-dup'],
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ auctionId: 'auction-dup', status: 'CLAIMED' })
    expect(inventory.confirmClaim).toHaveBeenCalledTimes(1)
  })

  it('devuelve results vacio para un lote explicito vacio', async () => {
    const { useCase } = setup()

    const result = await useCase.execute({ winnerId: 'winner-1', auctionIds: [] })

    expect(result.results).toEqual([])
  })

  it('claimAll reclama todos los pendientes del titular y nada mas', async () => {
    const { auctions, pendingClaims, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-mine-1')
    await seedClaim(auctions, pendingClaims, 'auction-mine-2')
    await seedClaim(auctions, pendingClaims, 'auction-other', { winnerId: 'otro-jugador' })

    const result = await useCase.execute({ winnerId: 'winner-1', claimAll: true })

    expect(result.results).toHaveLength(2)
    expect(result.results.map((item) => item.auctionId).sort()).toEqual([
      'auction-mine-1',
      'auction-mine-2',
    ])
    expect(result.results.every((item) => item.status === 'CLAIMED')).toBe(true)
  })

  it('claimAll devuelve results vacio cuando el titular no tiene pendientes', async () => {
    const { useCase } = setup()

    const result = await useCase.execute({ winnerId: 'winner-sin-pendientes', claimAll: true })

    expect(result.results).toEqual([])
  })

  it('aisla por usuario: un auctionId de otro titular incluido en el lote nunca se reclama', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-ajeno', { winnerId: 'otro-jugador' })

    const result = await useCase.execute({ winnerId: 'winner-1', auctionIds: ['auction-ajeno'] })

    expect(result.results).toEqual([
      expect.objectContaining({ auctionId: 'auction-ajeno', status: 'NOT_OWNED' }),
    ])
    expect(inventory.confirmClaim).not.toHaveBeenCalled()
    await expect(pendingClaims.findByAuctionId('auction-ajeno')).resolves.toMatchObject({
      claimStatus: 'PENDING',
      winnerId: 'otro-jugador',
    })
  })

  it('es idempotente a nivel de lote: reenviar el mismo lote no repite la transferencia', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-retry-a')
    await seedClaim(auctions, pendingClaims, 'auction-retry-b')
    inventory.failingAuctionIds.add('auction-retry-b')

    const first = await useCase.execute({
      winnerId: 'winner-1',
      auctionIds: ['auction-retry-a', 'auction-retry-b'],
    })
    expect(byAuctionId(first.results, 'auction-retry-a')).toMatchObject({ status: 'CLAIMED' })
    expect(byAuctionId(first.results, 'auction-retry-b')).toMatchObject({
      status: 'INVENTORY_UNAVAILABLE',
    })

    inventory.failingAuctionIds.delete('auction-retry-b')
    inventory.confirmClaim.mockClear()

    const second = await useCase.execute({
      winnerId: 'winner-1',
      auctionIds: ['auction-retry-a', 'auction-retry-b'],
    })

    expect(byAuctionId(second.results, 'auction-retry-a')).toMatchObject({
      status: 'ALREADY_CLAIMED',
    })
    expect(byAuctionId(second.results, 'auction-retry-b')).toMatchObject({ status: 'CLAIMED' })
    // Solo el que seguia PENDING (auction-retry-b) vuelve a llamar a Inventory.
    expect(inventory.confirmClaim).toHaveBeenCalledTimes(1)
    expect(inventory.confirmClaim).toHaveBeenCalledWith(
      expect.objectContaining({ auctionId: 'auction-retry-b' }),
    )
  })

  it('Inventory indisponible para un item no afecta a los demas del lote', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    await seedClaim(auctions, pendingClaims, 'auction-down')
    await seedClaim(auctions, pendingClaims, 'auction-up')
    inventory.failingAuctionIds.add('auction-down')

    const result = await useCase.execute({
      winnerId: 'winner-1',
      auctionIds: ['auction-down', 'auction-up'],
    })

    expect(byAuctionId(result.results, 'auction-down')).toMatchObject({
      status: 'INVENTORY_UNAVAILABLE',
    })
    expect(byAuctionId(result.results, 'auction-up')).toMatchObject({ status: 'CLAIMED' })
    await expect(pendingClaims.findByAuctionId('auction-down')).resolves.toMatchObject({
      claimStatus: 'PENDING',
    })
    await expect(pendingClaims.findByAuctionId('auction-up')).resolves.toMatchObject({
      claimStatus: 'CLAIMED',
    })
  })
})
