import { BidRuleCode, BidRuleViolation } from '../errors/BidRuleViolation'
import { AuctionId } from '../value-objects/AuctionIdentifiers'
import { BidAmount } from '../value-objects/BidAmount'
import { BidderId, BidId } from '../value-objects/BidIdentifiers'

export const BID_COOLDOWN_SECONDS = 5
export const MAX_ACTIVE_BIDS_PER_BIDDER = 50

export interface BidEligibility {
  auctionStatus: string
  sellerId: string
  currentBidCredits: number | null
  minimumIncrementCredits: number
  lastBidAtByBidder: Date | null
  activeBidCount: number
}

export interface RegisterBidInput {
  bidId: string
  auctionId: string
  bidderId: string
  amountCredits: number
  placedAt: Date
  eligibility: BidEligibility
}

export interface BidSnapshot {
  id: string
  auctionId: string
  bidderId: string
  amountCredits: number
  placedAt: Date
  creditReservationId?: string | null
}

export class Bid {
  private constructor(
    readonly id: BidId,
    readonly auctionId: AuctionId,
    readonly bidderId: BidderId,
    readonly amount: BidAmount,
    readonly placedAt: Date,
  ) {}

  static register(input: RegisterBidInput): Bid {
    Bid.assertValidDate(input.placedAt)

    Bid.assertAuctionActive(input.eligibility.auctionStatus)

    Bid.assertBidderIsNotSeller(input.bidderId, input.eligibility.sellerId)

    Bid.assertActiveBidLimit(input.eligibility.activeBidCount)

    Bid.assertCooldown(input.placedAt, input.eligibility.lastBidAtByBidder)

    const amount = BidAmount.positive(input.amountCredits)

    const minimumIncrement = BidAmount.positive(
      input.eligibility.minimumIncrementCredits,
      'incremento minimo',
    )

    Bid.assertAmount(amount, input.eligibility.currentBidCredits, minimumIncrement)

    return new Bid(
      BidId.create(input.bidId),
      AuctionId.create(input.auctionId),
      BidderId.create(input.bidderId),
      amount,
      new Date(input.placedAt),
    )
  }

  /**
   * Reconstruye una puja cuya intencion ya fue aceptada y almacenada
   * previamente.
   *
   * No vuelve a ejecutar reglas de elegibilidad porque esas reglas
   * corresponden al momento de registrar una puja nueva. Este metodo
   * existe para reanudar de forma idempotente una operacion durable.
   */
  static restore(snapshot: BidSnapshot): Bid {
    Bid.assertValidDate(snapshot.placedAt)

    return new Bid(
      BidId.create(snapshot.id),
      AuctionId.create(snapshot.auctionId),
      BidderId.create(snapshot.bidderId),
      BidAmount.positive(snapshot.amountCredits),
      new Date(snapshot.placedAt),
    )
  }

  snapshot(): BidSnapshot {
    return {
      id: this.id.value,
      auctionId: this.auctionId.value,
      bidderId: this.bidderId.value,
      amountCredits: this.amount.value,
      placedAt: new Date(this.placedAt),
    }
  }

  private static assertValidDate(placedAt: Date): void {
    if (Number.isNaN(placedAt.getTime())) {
      throw new BidRuleViolation(BidRuleCode.InvalidBidDate, 'La fecha de la puja debe ser valida.')
    }
  }

  private static assertAuctionActive(status: string): void {
    if (status !== 'ACTIVE') {
      throw new BidRuleViolation(
        BidRuleCode.AuctionNotActive,
        'La subasta debe estar activa para registrar una puja.',
      )
    }
  }

  private static assertBidderIsNotSeller(bidderId: string, sellerId: string): void {
    if (bidderId.trim() === sellerId.trim()) {
      throw new BidRuleViolation(
        BidRuleCode.SellerCannotBid,
        'El vendedor no puede pujar en su propia subasta.',
      )
    }
  }

  private static assertActiveBidLimit(activeBidCount: number): void {
    if (
      !Number.isSafeInteger(activeBidCount) ||
      activeBidCount < 0 ||
      activeBidCount >= MAX_ACTIVE_BIDS_PER_BIDDER
    ) {
      throw new BidRuleViolation(
        BidRuleCode.ActiveBidLimitReached,
        'El jugador alcanzo el limite de 50 pujas activas.',
      )
    }
  }

  private static assertCooldown(placedAt: Date, lastBidAtByBidder: Date | null): void {
    if (lastBidAtByBidder === null) {
      return
    }

    if (Number.isNaN(lastBidAtByBidder.getTime())) {
      throw new BidRuleViolation(
        BidRuleCode.InvalidBidDate,
        'La fecha de la ultima puja debe ser valida.',
      )
    }

    const elapsedMs = placedAt.getTime() - lastBidAtByBidder.getTime()

    if (elapsedMs < BID_COOLDOWN_SECONDS * 1000) {
      throw new BidRuleViolation(
        BidRuleCode.BidCooldownActive,
        'Debe esperar al menos 5 segundos entre pujas consecutivas.',
      )
    }
  }

  private static assertAmount(
    amount: BidAmount,
    currentBidCredits: number | null,
    minimumIncrement: BidAmount,
  ): void {
    if (currentBidCredits === null) {
      return
    }

    const currentBid = BidAmount.positive(currentBidCredits, 'oferta actual')

    if (!amount.isGreaterThan(currentBid)) {
      throw new BidRuleViolation(BidRuleCode.BidTooLow, 'La puja debe superar la oferta actual.')
    }

    const minimumAllowed = currentBid.add(minimumIncrement)

    if (!amount.isGreaterThanOrEqual(minimumAllowed)) {
      throw new BidRuleViolation(
        BidRuleCode.MinimumIncrementNotMet,
        'La puja no cumple el incremento minimo configurado.',
      )
    }
  }
}
