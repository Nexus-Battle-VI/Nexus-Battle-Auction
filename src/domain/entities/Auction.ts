import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'
import { AuctionDuration } from '../value-objects/AuctionDuration'
import { AuctionId, ProductId, SellerId } from '../value-objects/AuctionIdentifiers'
import {
  AuctionCurrency,
  AuctionPricing,
  type AuctionPricingInput,
} from '../value-objects/AuctionPricing'

export enum AuctionStatus {
  Active = 'ACTIVE',
}

export const MAX_ACTIVE_AUCTIONS_PER_SELLER = 10

export interface AuctionPublicationEligibility {
  productOwnedBySeller: boolean
  productInUse: boolean
  productTradable: boolean
  sellerHasActiveSanctions: boolean
  activeAuctionCount: number
}

export interface PublishAuctionInput {
  auctionId: string
  sellerId: string
  productId: string
  durationHours: number
  minimumBidCredits: number
  buyNowCredits?: number | null
  currency?: AuctionCurrency
  publishedAt: Date
  eligibility: AuctionPublicationEligibility
}

export interface AuctionSnapshot {
  id: string
  sellerId: string
  productId: string
  durationHours: 24 | 48
  publicationFeeCredits: number
  minimumBidCredits: number
  buyNowCredits: number | null
  status: AuctionStatus
  publishedAt: Date
  closesAt: Date
}

export class Auction {
  private constructor(
    readonly id: AuctionId,
    readonly sellerId: SellerId,
    readonly productId: ProductId,
    readonly duration: AuctionDuration,
    readonly pricing: AuctionPricing,
    readonly status: AuctionStatus,
    readonly publishedAt: Date,
    readonly closesAt: Date,
  ) {}

  static publish(input: PublishAuctionInput): Auction {
    Auction.assertPublicationDate(input.publishedAt)
    Auction.assertEligibility(input.eligibility)

    const duration = AuctionDuration.fromHours(input.durationHours)
    const pricingInput: AuctionPricingInput = {
      currency: input.currency ?? AuctionCurrency.Credits,
      minimumBid: input.minimumBidCredits,
      buyNow: input.buyNowCredits,
    }

    return new Auction(
      AuctionId.create(input.auctionId),
      SellerId.create(input.sellerId),
      ProductId.create(input.productId),
      duration,
      AuctionPricing.create(pricingInput),
      AuctionStatus.Active,
      new Date(input.publishedAt),
      duration.calculateClosingTime(input.publishedAt),
    )
  }

  snapshot(): AuctionSnapshot {
    return {
      id: this.id.value,
      sellerId: this.sellerId.value,
      productId: this.productId.value,
      durationHours: this.duration.hours,
      publicationFeeCredits: this.duration.publicationFee.value,
      minimumBidCredits: this.pricing.minimumBid.value,
      buyNowCredits: this.pricing.buyNow?.value ?? null,
      status: this.status,
      publishedAt: new Date(this.publishedAt),
      closesAt: new Date(this.closesAt),
    }
  }

  private static assertPublicationDate(publishedAt: Date): void {
    if (Number.isNaN(publishedAt.getTime())) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidPublicationDate,
        'La fecha de publicacion debe ser valida.',
      )
    }
  }

  private static assertEligibility(eligibility: AuctionPublicationEligibility): void {
    if (!eligibility.productOwnedBySeller) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.ProductNotOwned,
        'El producto debe pertenecer al vendedor.',
      )
    }
    if (eligibility.productInUse) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.ProductInUse,
        'Un producto en uso no puede publicarse en subasta.',
      )
    }
    if (!eligibility.productTradable) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.ProductNotTradable,
        'El producto no admite comercializacion en subasta.',
      )
    }
    if (eligibility.sellerHasActiveSanctions) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.SellerSanctioned,
        'Un vendedor con sanciones activas no puede publicar subastas.',
      )
    }
    if (
      !Number.isSafeInteger(eligibility.activeAuctionCount) ||
      eligibility.activeAuctionCount < 0 ||
      eligibility.activeAuctionCount >= MAX_ACTIVE_AUCTIONS_PER_SELLER
    ) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.ActiveAuctionLimitReached,
        'El vendedor alcanzo el limite de 10 subastas activas.',
      )
    }
  }
}
