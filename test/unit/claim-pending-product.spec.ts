import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { Auction } from '../../src/domain/entities/Auction'
import { CLAIM_PERIOD_MS } from '../../src/domain/entities/AuctionPendingClaim'
import { AuctionPendingClaimRuleCode } from '../../src/domain/errors/AuctionPendingClaimRuleViolation'
import {
  PendingClaimNotFoundError,
  PendingClaimOwnershipError,
} from '../../src/application/errors/AuctionPendingClaimError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  ConfirmInventoryProductClaimCommand,
  ClaimedInventoryProductCommitment,
  ProductInventoryPort,
} from '../../src/application/ports/ProductInventoryPort'
import { ClaimPendingProduct } from '../../src/application/use-cases/ClaimPendingProduct'

const settledAt = new Date('2026-09-01T12:00:00.000Z')
let now = new Date(settledAt)
const clock: ClockPort = { now: () => new Date(now) }

class FakeInventory implements ProductInventoryPort {
  outcomes: readonly ('SUCCESS' | 'UNAVAILABLE')[] = ['SUCCESS']
  private callIndex = 0

  readonly confirmClaim = jest.fn(
    (command: ConfirmInventoryProductClaimCommand): Promise<ClaimedInventoryProductCommitment> => {
      const outcome = this.outcomes[Math.min(this.callIndex, this.outcomes.length - 1)]
      this.callIndex += 1
      if (outcome === 'UNAVAILABLE') {
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
  const useCase = new ClaimPendingProduct(pendingClaims, auctions, inventory, clock)
  return { auctions, pendingClaims, inventory, useCase }
}

const seedClaim = async (
  pendingClaims: InMemoryAuctionPendingClaimRepository,
  auctionId: string,
  overrides: Partial<{ winnerId: string; settledAt: Date }> = {},
): Promise<void> => {
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

describe('ClaimPendingProduct', () => {
  beforeEach(() => {
    now = new Date(settledAt)
  })

  it('reclama exitosamente y confirma la entrega en Inventory', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-ok'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)

    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).resolves.toMatchObject({
      auctionId,
      claimStatus: 'CLAIMED',
      claimedAt: now,
    })
    expect(inventory.confirmClaim).toHaveBeenCalledWith({
      operationId: `auction:${auctionId}:inventory:claim`,
      commitmentId: `commitment-${auctionId}`,
      auctionId,
      winnerId: 'winner-1',
      productId: `product-${auctionId}`,
    })
  })

  it('rechaza cuando el titular no coincide', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-wrong-owner'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)

    await expect(useCase.execute({ auctionId, winnerId: 'otro-jugador' })).rejects.toBeInstanceOf(
      PendingClaimOwnershipError,
    )
    expect(inventory.confirmClaim).not.toHaveBeenCalled()
  })

  it('rechaza cuando no existe un pending-claim para la subasta', async () => {
    const { useCase } = setup()

    await expect(
      useCase.execute({ auctionId: 'auction-inexistente', winnerId: 'winner-1' }),
    ).rejects.toBeInstanceOf(PendingClaimNotFoundError)
  })

  it('rechaza un reclamo despues del dia 7 y no llama a Inventory', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-expired'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS + 1)

    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).rejects.toMatchObject({
      code: AuctionPendingClaimRuleCode.ClaimDeadlineExpired,
    })
    expect(inventory.confirmClaim).not.toHaveBeenCalled()
    await expect(pendingClaims.findByAuctionId(auctionId)).resolves.toMatchObject({
      claimStatus: 'PENDING',
    })
  })

  it('acepta el limite exacto del dia 7 (inclusive)', async () => {
    const { auctions, pendingClaims, useCase } = setup()
    const auctionId = 'auction-claim-boundary'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)
    now = new Date(settledAt.getTime() + CLAIM_PERIOD_MS)

    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).resolves.toMatchObject({
      claimStatus: 'CLAIMED',
    })
  })

  it('es idempotente ante un pending-claim ya CLAIMED: no vuelve a llamar a Inventory', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-already-claimed'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)
    await pendingClaims.markClaimed(auctionId, now)

    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).resolves.toMatchObject({
      claimStatus: 'CLAIMED',
    })
    expect(inventory.confirmClaim).not.toHaveBeenCalled()
  })

  it('solicitud duplicada: repetir el mismo reclamo exitoso es idempotente', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-duplicate-request'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)

    const first = await useCase.execute({ auctionId, winnerId: 'winner-1' })
    const second = await useCase.execute({ auctionId, winnerId: 'winner-1' })

    expect(second).toEqual(first)
    expect(inventory.confirmClaim).toHaveBeenCalledTimes(1)
  })

  it('si Inventory no esta disponible, el reclamo permanece PENDING', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-inventory-down'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)
    inventory.outcomes = ['UNAVAILABLE']

    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
    await expect(pendingClaims.findByAuctionId(auctionId)).resolves.toMatchObject({
      claimStatus: 'PENDING',
      claimedAt: null,
    })
  })

  it('reintento tras fallo de Inventory: el segundo intento completa el reclamo', async () => {
    const { auctions, pendingClaims, inventory, useCase } = setup()
    const auctionId = 'auction-claim-retry'
    await publish(auctions, auctionId)
    await seedClaim(pendingClaims, auctionId)
    inventory.outcomes = ['UNAVAILABLE', 'SUCCESS']

    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
    await expect(useCase.execute({ auctionId, winnerId: 'winner-1' })).resolves.toMatchObject({
      claimStatus: 'CLAIMED',
    })
    expect(inventory.confirmClaim).toHaveBeenCalledTimes(2)
    expect(inventory.confirmClaim.mock.calls[0]?.[0].operationId).toBe(
      inventory.confirmClaim.mock.calls[1]?.[0].operationId,
    )
  })
})
