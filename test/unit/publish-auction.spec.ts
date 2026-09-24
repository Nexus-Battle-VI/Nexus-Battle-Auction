import type { AuctionRepositoryPort } from '../../src/application/ports/AuctionRepositoryPort'
import type { CatalogProductPolicyPort } from '../../src/application/ports/CatalogProductPolicyPort'
import type { ProductInventoryPort } from '../../src/application/ports/ProductInventoryPort'
import type { SellerSanctionPort } from '../../src/application/ports/SellerSanctionPort'
import type { PersistAuctionPublication } from '../../src/application/use-cases/PersistAuctionPublication'
import { PublishAuction } from '../../src/application/use-cases/PublishAuction'
import { InMemoryAuctionPublicationIntentRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionPublicationIntentRepository'

describe('PublishAuction', () => {
  it('consulta elegibilidad, construye el agregado y delega la persistencia', async () => {
    const repository = {
      countActiveBySeller: jest.fn(() => Promise.resolve(2)),
    } as unknown as jest.Mocked<AuctionRepositoryPort>
    const catalog = {
      getPolicy: jest.fn(() => Promise.resolve({ tradableInAuction: true })),
    } as unknown as jest.Mocked<CatalogProductPolicyPort>
    const inventory = {
      inspect: jest.fn(() => Promise.resolve({ ownedByPlayer: true, inUse: false })),
    } as unknown as jest.Mocked<ProductInventoryPort>
    const sanctions = {
      hasActiveSanctions: jest.fn(() => Promise.resolve(false)),
    } as unknown as jest.Mocked<SellerSanctionPort>
    const persistence = {
      execute: jest.fn(({ auction }) =>
        Promise.resolve({ auction: auction.snapshot(), replayed: false }),
      ),
    } as unknown as jest.Mocked<PersistAuctionPublication>

    const useCase = new PublishAuction(
      repository,
      catalog,
      inventory,
      sanctions,
      persistence,
      { now: () => new Date('2026-09-21T12:00:00.000Z') },
      { generate: () => 'auction-1' },
      new InMemoryAuctionPublicationIntentRepository(),
    )

    await expect(
      useCase.execute({
        operationId: 'operation-1',
        sellerId: 'seller-from-token',
        productId: 'product-1',
        durationHours: 48,
        minimumBidCredits: 10,
        buyNowCredits: 20,
      }),
    ).resolves.toMatchObject({
      id: 'auction-1',
      sellerId: 'seller-from-token',
      publicationFeeCredits: 3,
      closesAt: new Date('2026-09-23T12:00:00.000Z'),
    })

    expect(inventory.inspect).toHaveBeenCalledWith('seller-from-token', 'product-1')
    expect(catalog.getPolicy).toHaveBeenCalledWith('product-1')
    expect(sanctions.hasActiveSanctions).toHaveBeenCalledWith('seller-from-token')
    expect(repository.countActiveBySeller).toHaveBeenCalledWith('seller-from-token')
    expect(persistence.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-1' }),
    )
  })
})
