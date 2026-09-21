import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import type { ProductInventoryPort } from '../../src/application/ports/ProductInventoryPort'
import type { PublicationFeePort } from '../../src/application/ports/PublicationFeePort'
import { PersistAuctionPublication } from '../../src/application/use-cases/PersistAuctionPublication'
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
    commit: jest.fn(() => Promise.resolve({ commitmentId: 'commitment-1' })),
    release: jest.fn(() => Promise.resolve()),
  } as unknown as jest.Mocked<ProductInventoryPort>
  const fees = {
    charge: jest.fn(() => Promise.resolve({ chargeId: 'charge-1' })),
    refund: jest.fn(() => Promise.resolve()),
  } as unknown as jest.Mocked<PublicationFeePort>
  const useCase = new PersistAuctionPublication(repository, inventory, fees, { now: () => now })
  return { repository, inventory, fees, useCase }
}

describe('PersistAuctionPublication', () => {
  it('coordina cobro, compromiso y persistencia con la misma operacion', async () => {
    const { repository, inventory, fees, useCase } = dependencies()
    const entity = auction()

    await expect(
      useCase.execute({ operationId: 'operation-1', auction: entity }),
    ).resolves.toMatchObject({ replayed: false })

    expect(fees.charge).toHaveBeenCalledWith({
      operationId: 'operation-1',
      sellerId: 'seller-1',
      amount: 1,
    })
    expect(inventory.commit).toHaveBeenCalledWith({
      operationId: 'operation-1',
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

  it('devuelve el cobro y registra evidencia si falla el bloqueo', async () => {
    const { repository, inventory, fees, useCase } = dependencies()
    inventory.commit.mockRejectedValue(new Error('inventory unavailable'))

    await expect(
      useCase.execute({ operationId: 'operation-1', auction: auction() }),
    ).rejects.toThrow('inventory unavailable')

    expect(fees.refund).toHaveBeenCalledWith('operation-1', 'charge-1')
    expect(inventory.release).not.toHaveBeenCalled()
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'COMMITTING_INVENTORY',
        feeRefunded: true,
        inventoryReleased: true,
      }),
    )
  })

  it('libera inventario, devuelve cobro y registra evidencia si falla persistencia', async () => {
    const { repository, inventory, fees, useCase } = dependencies()
    repository.publish.mockRejectedValue(new Error('database unavailable'))

    await expect(
      useCase.execute({ operationId: 'operation-1', auction: auction() }),
    ).rejects.toThrow('database unavailable')

    expect(inventory.release).toHaveBeenCalledWith('operation-1', 'commitment-1')
    expect(fees.refund).toHaveBeenCalledWith('operation-1', 'charge-1')
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'PERSISTING_AUCTION',
        inventoryReleased: true,
        feeRefunded: true,
      }),
    )
  })

  it('deja pendiente la compensacion que tambien falla', async () => {
    const { repository, inventory, fees, useCase } = dependencies()
    repository.publish.mockRejectedValue('persistence failure')
    inventory.release.mockRejectedValue(new Error('release failure'))
    fees.refund.mockRejectedValue(new Error('refund failure'))

    await expect(useCase.execute({ operationId: 'operation-1', auction: auction() })).rejects.toBe(
      'persistence failure',
    )
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'persistence failure',
        inventoryReleased: false,
        feeRefunded: false,
      }),
    )
  })
})
