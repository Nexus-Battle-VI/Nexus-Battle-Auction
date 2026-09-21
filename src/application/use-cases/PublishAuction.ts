import type { AuctionSnapshot } from '../../domain/entities/Auction'
import { Auction } from '../../domain/entities/Auction'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { CatalogProductPolicyPort } from '../ports/CatalogProductPolicyPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdentifierGeneratorPort } from '../ports/IdentifierGeneratorPort'
import type { ProductInventoryPort } from '../ports/ProductInventoryPort'
import type { SellerSanctionPort } from '../ports/SellerSanctionPort'
import type { PersistAuctionPublication } from './PersistAuctionPublication'

export interface PublishAuctionCommand {
  readonly operationId: string
  readonly sellerId: string
  readonly productId: string
  readonly durationHours: number
  readonly minimumBidCredits: number
  readonly buyNowCredits?: number | null
}

export class PublishAuction {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly catalog: CatalogProductPolicyPort,
    private readonly inventory: ProductInventoryPort,
    private readonly sanctions: SellerSanctionPort,
    private readonly persistence: PersistAuctionPublication,
    private readonly clock: ClockPort,
    private readonly identifiers: IdentifierGeneratorPort,
  ) {}

  async execute(command: PublishAuctionCommand): Promise<AuctionSnapshot> {
    const [inventoryEligibility, catalogPolicy, sellerHasActiveSanctions, activeAuctionCount] =
      await Promise.all([
        this.inventory.inspect(command.sellerId, command.productId),
        this.catalog.getPolicy(command.productId),
        this.sanctions.hasActiveSanctions(command.sellerId),
        this.repository.countActiveBySeller(command.sellerId),
      ])

    const auction = Auction.publish({
      auctionId: this.identifiers.generate(),
      sellerId: command.sellerId,
      productId: command.productId,
      durationHours: command.durationHours,
      minimumBidCredits: command.minimumBidCredits,
      buyNowCredits: command.buyNowCredits,
      publishedAt: this.clock.now(),
      eligibility: {
        productOwnedBySeller: inventoryEligibility.ownedByPlayer,
        productInUse: inventoryEligibility.inUse,
        productTradable: catalogPolicy.tradableInAuction,
        sellerHasActiveSanctions,
        activeAuctionCount,
      },
    })

    return (await this.persistence.execute({ operationId: command.operationId, auction })).auction
  }
}
