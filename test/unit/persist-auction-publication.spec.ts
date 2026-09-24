import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import type { ProductInventoryPort } from '../../src/application/ports/ProductInventoryPort'
import type { PublicationFeePort } from '../../src/application/ports/PublicationFeePort'
import { PersistAuctionPublication } from '../../src/application/use-cases/PersistAuctionPublication'
import { InMemoryAuctionPublicationIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPublicationIntentRepository'
import { Auction } from '../../src/domain/entities/Auction'

const now = new Date('2026-09-21T12:00:00.000Z')

const auction = () =>
  Auction.publish({
    auctionId: 'auction-1',
    sellerId: 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits: 10,
    publishedAt: now,
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  })

const dependencies = () => {
  const repository = {
    publish: jest.fn(({ auction: entity }) =>
      Promise.resolve({ auction: entity.snapshot(), replayed: false }),
    ),
    recordFailure: jest.fn(() => Promise.resolve()),
    findById: jest.fn(() => Promise.resolve(null)),
    countActiveBySeller: jest.fn(() => Promise.resolve(0)),
  } as unknown as jest.Mocked<AuctionRepositoryPort>
  const inventory = {
    inspect: jest.fn(),
    commit: jest.fn(() =>
      Promise.resolve({
        operationId: 'auction:auction-1:inventory:commit',
        commitmentId: 'commitment-1',
        status: 'ACTIVE' as const,
        applied: true,
      }),
    ),
    release: jest.fn(() =>
      Promise.resolve({
        operationId: 'auction:auction-1:inventory:release',
        commitmentId: 'commitment-1',
        status: 'RELEASED' as const,
        applied: true,
      }),
    ),
  } as unknown as jest.Mocked<ProductInventoryPort>
  const fees = {
    charge: jest.fn(() => Promise.resolve({ chargeId: 'charge-1' })),
    refund: jest.fn(() => Promise.resolve()),
  } as unknown as jest.Mocked<PublicationFeePort>
  const intents = new InMemoryAuctionPublicationIntentRepository()
  const useCase = new PersistAuctionPublication(
    repository,
    inventory,
    fees,
    { now: () => now },
    intents,
  )
  return { repository, inventory, fees, intents, useCase }
}

describe('PersistAuctionPublication', () => {
  it('coordina cobro, compromiso y persistencia con la misma operacion', async () => {
    const { repository, inventory, fees, intents, useCase } = dependencies()
    const entity = auction()
    await intents.getOrCreate({
      operationId: 'operation-1',
      auctionId: 'auction-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      closesAt: entity.closesAt,
      createdAt: now,
    })

    await expect(
      useCase.execute({ operationId: 'operation-1', auction: entity }),
    ).resolves.toMatchObject({ replayed: false })

    expect(fees.charge).toHaveBeenCalledWith({
      operationId: 'operation-1',
      sellerId: 'seller-1',
      amount: 1,
    })
    expect(inventory.commit).toHaveBeenCalledWith({
      operationId: 'auction:auction-1:inventory:commit',
      auctionId: 'auction-1',
      ownerId: 'seller-1',
      productId: 'product-1',
      expiresAt: new Date('2026-09-22T12:00:00.000Z'),
    })
    expect(repository.publish).toHaveBeenCalledWith({
      operationId: 'operation-1',
      auction: entity,
      inventoryCommitmentId: 'commitment-1',
      feeChargeId: 'charge-1',
    })
    expect(repository.recordFailure).not.toHaveBeenCalled()
  })

  it('conserva la intencion pendiente si falla el bloqueo', async () => {
    const { repository, inventory, fees, intents, useCase } = dependencies()
    const entity = auction()
    await intents.getOrCreate({
      operationId: 'operation-1',
      auctionId: 'auction-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      closesAt: entity.closesAt,
      createdAt: now,
    })
    inventory.commit.mockRejectedValue(new Error('inventory unavailable'))

    await expect(useCase.execute({ operationId: 'operation-1', auction: entity })).rejects.toThrow(
      'inventory unavailable',
    )

    expect(fees.refund).not.toHaveBeenCalled()
    expect(inventory.release).not.toHaveBeenCalled()
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'COMMITTING_INVENTORY',
        feeRefunded: false,
        inventoryReleased: true,
      }),
    )
  })

  it('no compensa Inventory ante un fallo retryable posterior al commitment', async () => {
    const { repository, inventory, fees, intents, useCase } = dependencies()
    const entity = auction()
    await intents.getOrCreate({
      operationId: 'operation-1',
      auctionId: 'auction-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      closesAt: entity.closesAt,
      createdAt: now,
    })
    repository.publish.mockRejectedValue(new Error('database unavailable'))

    await expect(useCase.execute({ operationId: 'operation-1', auction: entity })).rejects.toThrow(
      'database unavailable',
    )

    expect(inventory.release).not.toHaveBeenCalled()
    expect(fees.refund).not.toHaveBeenCalled()
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'PERSISTING_AUCTION',
        inventoryReleased: false,
        feeRefunded: false,
      }),
    )
  })

  it('persiste el commitment y permite continuar tras un fallo de persistencia', async () => {
    const { repository, intents, useCase } = dependencies()
    const entity = auction()
    await intents.getOrCreate({
      operationId: 'operation-1',
      auctionId: 'auction-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      closesAt: entity.closesAt,
      createdAt: now,
    })
    repository.publish.mockRejectedValue('persistence failure')

    await expect(useCase.execute({ operationId: 'operation-1', auction: entity })).rejects.toBe(
      'persistence failure',
    )
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'persistence failure',
        inventoryReleased: false,
        feeRefunded: false,
      }),
    )
    await expect(intents.getByOperationId('operation-1')).resolves.toMatchObject({
      inventoryCommitmentId: 'commitment-1',
      inventoryStatus: 'COMMITTED',
      publicationStatus: 'PENDING',
    })
  })

  it('reanuda tras restart sin recommit Inventory', async () => {
    const { repository, inventory, fees, intents, useCase } = dependencies()
    const entity = auction()
    await intents.getOrCreate({
      operationId: 'operation-1',
      auctionId: 'auction-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      closesAt: entity.closesAt,
      createdAt: now,
    })
    repository.publish.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(useCase.execute({ operationId: 'operation-1', auction: entity })).rejects.toThrow(
      'database unavailable',
    )
    const restarted = new PersistAuctionPublication(
      repository,
      inventory,
      fees,
      { now: () => now },
      intents,
    )
    await expect(
      restarted.execute({ operationId: 'operation-1', auction: entity }),
    ).resolves.toMatchObject({ replayed: false })
    expect(inventory.commit).toHaveBeenCalledTimes(1)
  })
})
