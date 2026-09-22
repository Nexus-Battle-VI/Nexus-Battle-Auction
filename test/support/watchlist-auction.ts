import { Auction } from '../../src/domain/entities/Auction'

/** Publicacion valida de HU-62 para probar integridad local sin servicios externos. */
export const watchlistAuction = (id: string) => ({
  operationId: `operation-${id}`,
  auction: Auction.publish({
    auctionId: id,
    sellerId: 'seller-1',
    productId: `product-${id}`,
    durationHours: 24,
    minimumBidCredits: 10,
    publishedAt: new Date('2026-09-21T10:00:00Z'),
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  }),
  inventoryCommitmentId: `commitment-${id}`,
  feeChargeId: `fee-${id}`,
})
