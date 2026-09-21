import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { IdempotencyConflictError } from '../../src/application/errors/AuctionPersistenceError'
import { Auction } from '../../src/domain/entities/Auction'

const command = (auctionId: string, operationId = 'operation-1', minimumBidCredits = 10) => ({
  operationId,
  auction: Auction.publish({
    auctionId,
    sellerId: 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits,
    publishedAt: new Date(),
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  }),
  inventoryCommitmentId: 'commitment-1',
  feeChargeId: 'charge-1',
})

describe('InMemoryAuctionRepository', () => {
  it('reproduce la misma publicacion ante un reintento con datos generados distintos', async () => {
    const repository = new InMemoryAuctionRepository()
    await expect(repository.publish(command('auction-first'))).resolves.toMatchObject({
      replayed: false,
    })
    await expect(repository.publish(command('auction-regenerated'))).resolves.toMatchObject({
      replayed: true,
      auction: { id: 'auction-first' },
    })
    await expect(repository.findById('auction-first')).resolves.toMatchObject({
      id: 'auction-first',
    })
  })

  it('rechaza reutilizar la operacion con otra intencion funcional', async () => {
    const repository = new InMemoryAuctionRepository()
    await repository.publish(command('auction-first'))
    await expect(
      repository.publish(command('auction-second', 'operation-1', 11)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })
})
