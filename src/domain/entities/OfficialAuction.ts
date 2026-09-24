import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'
import { AuctionDuration } from '../value-objects/AuctionDuration'
import { AuctionId, ProductId, SellerId } from '../value-objects/AuctionIdentifiers'
import {
  AuctionPriceKind,
  AuctionPublisherType,
  createAuctionPublicationPricing,
  type RealMoneyPrice,
  type RealMoneyPriceInput,
} from '../value-objects/AuctionPublicationPricing'
import { AuctionStatus } from './Auction'

export { AuctionPublisherType } from '../value-objects/AuctionPublicationPricing'

export enum OfficialAuctionMark {
  Official = 'OFFICIAL',
  Premium = 'PREMIUM',
}

export interface PublishOfficialAuctionInput {
  readonly auctionId: string
  readonly publisherId: string
  readonly publisherType: AuctionPublisherType
  readonly productId: string
  readonly durationHours: number
  readonly pricing: RealMoneyPriceInput
  readonly mark: OfficialAuctionMark
  readonly publishedAt: Date
}

export interface OfficialAuctionSnapshot {
  readonly id: string
  readonly publisherId: string
  readonly publisherType: AuctionPublisherType.GameMaster
  readonly productId: string
  readonly durationHours: 24 | 48
  readonly publicationFeeCredits: 0
  readonly currency: string
  readonly minimumBidAmountMinor: number
  readonly buyNowAmountMinor: number | null
  readonly mark: OfficialAuctionMark
  readonly status: AuctionStatus
  readonly publishedAt: Date
  readonly closesAt: Date
}

export class OfficialAuction {
  private constructor(
    readonly id: AuctionId,
    readonly publisherId: SellerId,
    readonly productId: ProductId,
    readonly duration: AuctionDuration,
    readonly pricing: RealMoneyPrice,
    readonly mark: OfficialAuctionMark,
    readonly publishedAt: Date,
    readonly closesAt: Date,
  ) {}

  static publish(input: PublishOfficialAuctionInput): OfficialAuction {
    if (Number.isNaN(input.publishedAt.getTime())) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidPublicationDate,
        'La fecha de publicacion debe ser valida.',
      )
    }
    if (!Object.values(OfficialAuctionMark).includes(input.mark)) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidOfficialMark,
        'La marca de una publicacion oficial debe ser OFFICIAL o PREMIUM.',
      )
    }
    if (input.publisherType !== AuctionPublisherType.GameMaster) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.UnsupportedCurrency,
        'Solo GAME_MASTER puede construir una publicacion oficial.',
      )
    }

    const duration = AuctionDuration.fromHours(input.durationHours)
    const pricing = createAuctionPublicationPricing(input.publisherType, input.pricing)
    if (pricing.kind !== AuctionPriceKind.RealMoney) {
      throw new AuctionRuleViolation(AuctionRuleCode.UnsupportedCurrency, 'La subasta es invalida.')
    }

    return new OfficialAuction(
      AuctionId.create(input.auctionId),
      SellerId.create(input.publisherId),
      ProductId.create(input.productId),
      duration,
      pricing,
      input.mark,
      new Date(input.publishedAt),
      duration.calculateClosingTime(input.publishedAt),
    )
  }

  snapshot(): OfficialAuctionSnapshot {
    return {
      id: this.id.value,
      publisherId: this.publisherId.value,
      publisherType: AuctionPublisherType.GameMaster,
      productId: this.productId.value,
      durationHours: this.duration.hours,
      publicationFeeCredits: 0,
      currency: this.pricing.minimumBid.currency,
      minimumBidAmountMinor: this.pricing.minimumBid.amountMinor,
      buyNowAmountMinor: this.pricing.buyNow?.amountMinor ?? null,
      mark: this.mark,
      status: AuctionStatus.Active,
      publishedAt: new Date(this.publishedAt),
      closesAt: new Date(this.closesAt),
    }
  }
}
