import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'
import { AuctionDuration } from '../value-objects/AuctionDuration'
import { AuctionId, ProductId, SellerId } from '../value-objects/AuctionIdentifiers'
import {
  AuctionCurrency,
  AuctionPricing,
  type AuctionPricingInput,
} from '../value-objects/AuctionPricing'
import { AuctionClosingResult, type AuctionClosingResultSnapshot } from './AuctionClosingResult'

export { AuctionClosingOutcome } from './AuctionClosingResult'

export enum AuctionStatus {
  Active = 'ACTIVE',
  Finished = 'FINISHED',
  /** Cerrada de forma anticipada por una compra inmediata ejecutada (HU-64). */
  SoldByBuyNow = 'SOLD',
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
  completion?: AuctionClosingResultSnapshot
}

export interface LeadingBidForClosing {
  readonly auctionId: string
  readonly bidId: string
  readonly bidderId: string
  readonly amountCredits: number
}

export interface FinishAuctionInput {
  readonly finishedAt: Date
  readonly leadingBid: LeadingBidForClosing | null
}
export interface RehydrateAuctionInput extends AuctionSnapshot {
  readonly finishedAt: Date | null
  readonly closingResult: AuctionClosingResultSnapshot | null
}

export class Auction {
  private constructor(
    readonly id: AuctionId,
    readonly sellerId: SellerId,
    readonly productId: ProductId,
    readonly duration: AuctionDuration,
    readonly pricing: AuctionPricing,
    private currentStatus: AuctionStatus,
    readonly publishedAt: Date,
    readonly closesAt: Date,
    private completion: AuctionClosingResult | null = null,
  ) {}

  get status(): AuctionStatus {
    return this.currentStatus
  }
  get finishedAt(): Date | null {
    return this.completion === null ? null : new Date(this.completion.finishedAt)
  }
  get closingResult(): AuctionClosingResultSnapshot | null {
    return this.completion === null ? null : this.completion.snapshot()
  }

  static rehydrate(input: RehydrateAuctionInput): Auction {
    const active = input.status === AuctionStatus.Active
    if (
      (active && (input.finishedAt !== null || input.closingResult !== null)) ||
      (!active && (input.finishedAt === null || input.closingResult === null))
    )
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidFinalizationDate,
        'Estado persistido de cierre incoherente.',
      )
    let completion: AuctionClosingResult | null = null
    if (input.closingResult !== null) {
      const result = input.closingResult
      const finishedAt = input.finishedAt
      if (finishedAt === null) {
        throw new AuctionRuleViolation(
          AuctionRuleCode.InvalidFinalizationDate,
          'Estado persistido de cierre incoherente.',
        )
      }
      const outcome: string = result.outcome
      if (outcome === 'WITH_WINNER') {
        if (
          result.winnerId === null ||
          result.winningBidId === null ||
          result.finalAmountCredits === null ||
          result.finalAmountCredits <= 0
        )
          throw new AuctionRuleViolation(
            AuctionRuleCode.InvalidFinalizationDate,
            'Resultado ganador persistido incoherente.',
          )
        completion = AuctionClosingResult.withWinner({
          finishedAt,
          bidderId: result.winnerId,
          bidId: result.winningBidId,
          amountCredits: result.finalAmountCredits,
        })
      } else if (outcome === 'WITHOUT_BIDS') {
        if (
          result.winnerId !== null ||
          result.winningBidId !== null ||
          result.finalAmountCredits !== null
        )
          throw new AuctionRuleViolation(
            AuctionRuleCode.InvalidFinalizationDate,
            'Resultado sin pujas persistido incoherente.',
          )
        completion = AuctionClosingResult.withoutBids(finishedAt)
      } else
        throw new AuctionRuleViolation(
          AuctionRuleCode.InvalidFinalizationDate,
          'Resultado de cierre desconocido.',
        )
    }
    return new Auction(
      AuctionId.create(input.id),
      SellerId.create(input.sellerId),
      ProductId.create(input.productId),
      AuctionDuration.fromHours(input.durationHours),
      AuctionPricing.create({
        currency: AuctionCurrency.Credits,
        minimumBid: input.minimumBidCredits,
        buyNow: input.buyNowCredits,
      }),
      input.status,
      new Date(input.publishedAt),
      new Date(input.closesAt),
      completion,
    )
  }

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
    const snapshot: AuctionSnapshot = {
      id: this.id.value,
      sellerId: this.sellerId.value,
      productId: this.productId.value,
      durationHours: this.duration.hours,
      publicationFeeCredits: this.duration.publicationFee.value,
      minimumBidCredits: this.pricing.minimumBid.value,
      buyNowCredits: this.pricing.buyNow?.value ?? null,
      status: this.currentStatus,
      publishedAt: new Date(this.publishedAt),
      closesAt: new Date(this.closesAt),
    }

    return this.completion === null
      ? snapshot
      : { ...snapshot, completion: this.completion.snapshot() }
  }

  finish(input: FinishAuctionInput): AuctionClosingResult {
    Auction.assertFinalizationDate(input.finishedAt)

    if (this.currentStatus === AuctionStatus.Finished) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.AuctionAlreadyFinished,
        'Una subasta finalizada no puede finalizarse nuevamente.',
      )
    }

    if (input.finishedAt.getTime() < this.closesAt.getTime()) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.AuctionNotExpired,
        'La subasta solo puede finalizar desde su fecha de vencimiento.',
      )
    }

    if (input.leadingBid !== null && input.leadingBid.auctionId !== this.id.value) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.LeadingBidDoesNotBelongToAuction,
        'La oferta lider debe pertenecer a la subasta que se finaliza.',
      )
    }

    const completion =
      input.leadingBid === null
        ? AuctionClosingResult.withoutBids(input.finishedAt)
        : AuctionClosingResult.withWinner({
            finishedAt: input.finishedAt,
            bidderId: input.leadingBid.bidderId,
            bidId: input.leadingBid.bidId,
            amountCredits: input.leadingBid.amountCredits,
          })

    this.currentStatus = AuctionStatus.Finished
    this.completion = completion

    return completion
  }

  private static assertPublicationDate(publishedAt: Date): void {
    if (Number.isNaN(publishedAt.getTime())) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidPublicationDate,
        'La fecha de publicacion debe ser valida.',
      )
    }
  }

  private static assertFinalizationDate(finishedAt: Date): void {
    if (Number.isNaN(finishedAt.getTime())) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidFinalizationDate,
        'La fecha de finalizacion debe ser valida.',
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
