import {
  AuctionPendingClaimRuleCode,
  AuctionPendingClaimRuleViolation,
} from '../errors/AuctionPendingClaimRuleViolation'
import { AuctionId, ProductId } from '../value-objects/AuctionIdentifiers'
import { Credits } from '../value-objects/Credits'
import { BidId, BidderId } from '../value-objects/BidIdentifiers'

export { AuctionPendingClaimRuleCode, AuctionPendingClaimRuleViolation }

/** Siete dias exactos expresados en milisegundos UTC. */
export const CLAIM_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

export const AuctionPendingClaimStatus = {
  Pending: 'PENDING',
  Claimed: 'CLAIMED',
  Expired: 'EXPIRED',
} as const

export type AuctionPendingClaimStatus =
  (typeof AuctionPendingClaimStatus)[keyof typeof AuctionPendingClaimStatus]

export interface AuctionPendingClaimSnapshot {
  readonly auctionId: string
  readonly winnerId: string
  readonly productId: string
  readonly winningBidId: string
  readonly finalAmountCredits: number
  readonly settledAt: Date
  readonly claimDeadline: Date
  readonly claimStatus: AuctionPendingClaimStatus
  readonly claimedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateAuctionPendingClaimInput {
  readonly auctionId: string
  readonly winnerId: string
  readonly productId: string
  readonly winningBidId: string
  readonly finalAmountCredits: number
  readonly settledAt: Date
  readonly createdAt: Date
}

type RestoreAuctionPendingClaimInput = Omit<AuctionPendingClaimSnapshot, 'claimDeadline'>

/**
 * Producto ganado que permanece pendiente de reclamo despues de liquidar una
 * subasta. El vencimiento se deriva de settledAt y no se persiste como una
 * segunda fecha mutable.
 */
export class AuctionPendingClaim {
  private constructor(
    private readonly auctionId: AuctionId,
    private readonly winnerId: BidderId,
    private readonly productId: ProductId,
    private readonly winningBidId: BidId,
    private readonly finalAmountCredits: Credits,
    private readonly settledAt: Date,
    private readonly createdAt: Date,
    private claimStatus: AuctionPendingClaimStatus,
    private claimedAt: Date | null,
    private updatedAt: Date,
  ) {}

  static create(input: CreateAuctionPendingClaimInput): AuctionPendingClaim {
    AuctionPendingClaim.assertDate(input.settledAt, AuctionPendingClaimRuleCode.InvalidSettledAt)
    AuctionPendingClaim.assertDate(input.createdAt, AuctionPendingClaimRuleCode.InvalidCreatedAt)

    return new AuctionPendingClaim(
      AuctionId.create(input.auctionId),
      BidderId.create(input.winnerId),
      ProductId.create(input.productId),
      BidId.create(input.winningBidId),
      AuctionPendingClaim.createCredits(input.finalAmountCredits),
      new Date(input.settledAt),
      new Date(input.createdAt),
      AuctionPendingClaimStatus.Pending,
      null,
      new Date(input.createdAt),
    )
  }

  /** Reconstruye el mismo agregado sin ejecutar operaciones externas. */
  static restore(input: RestoreAuctionPendingClaimInput): AuctionPendingClaim {
    AuctionPendingClaim.assertDate(input.settledAt, AuctionPendingClaimRuleCode.InvalidSettledAt)
    AuctionPendingClaim.assertDate(input.createdAt, AuctionPendingClaimRuleCode.InvalidCreatedAt)
    AuctionPendingClaim.assertDate(input.updatedAt, AuctionPendingClaimRuleCode.InvalidUpdatedAt)

    if (!AuctionPendingClaim.isStatus(input.claimStatus)) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.InvalidStatus,
        'El estado del reclamo no es valido.',
      )
    }

    if (input.claimedAt !== null) {
      AuctionPendingClaim.assertDate(input.claimedAt, AuctionPendingClaimRuleCode.InvalidClaimedAt)
    }

    if (
      (input.claimStatus === AuctionPendingClaimStatus.Pending && input.claimedAt !== null) ||
      (input.claimStatus === AuctionPendingClaimStatus.Expired && input.claimedAt !== null) ||
      (input.claimStatus === AuctionPendingClaimStatus.Claimed && input.claimedAt === null)
    ) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.InvalidStatus,
        'El estado del reclamo no coincide con claimedAt.',
      )
    }

    return new AuctionPendingClaim(
      AuctionId.create(input.auctionId),
      BidderId.create(input.winnerId),
      ProductId.create(input.productId),
      BidId.create(input.winningBidId),
      AuctionPendingClaim.createCredits(input.finalAmountCredits),
      new Date(input.settledAt),
      new Date(input.createdAt),
      input.claimStatus,
      input.claimedAt === null ? null : new Date(input.claimedAt),
      new Date(input.updatedAt),
    )
  }

  get status(): AuctionPendingClaimStatus {
    return this.claimStatus
  }

  get deadline(): Date {
    return this.claimDeadline
  }

  get claimDeadline(): Date {
    return this.calculateClaimDeadline()
  }

  /** Indica si el reclamo sigue abierto en el instante indicado. */
  isClaimableAt(at: Date): boolean {
    AuctionPendingClaim.assertTransitionDate(at)
    return (
      this.claimStatus === AuctionPendingClaimStatus.Pending &&
      at.getTime() <= this.claimDeadline.getTime()
    )
  }

  /** Alias semantico para consumidores que expresan la regla como elegibilidad. */
  canClaimAt(at: Date): boolean {
    return this.isClaimableAt(at)
  }

  claim(at: Date): AuctionPendingClaimSnapshot {
    AuctionPendingClaim.assertTransitionDate(at)

    if (this.claimStatus === AuctionPendingClaimStatus.Claimed) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.AlreadyClaimed,
        'El producto ya fue reclamado.',
      )
    }
    if (this.claimStatus === AuctionPendingClaimStatus.Expired) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.AlreadyExpired,
        'El plazo de reclamo ya expiro.',
      )
    }
    if (at.getTime() > this.claimDeadline.getTime()) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.ClaimDeadlineExpired,
        'El plazo de reclamo ya expiro.',
      )
    }

    this.claimStatus = AuctionPendingClaimStatus.Claimed
    this.claimedAt = new Date(at)
    this.updatedAt = new Date(at)
    return this.snapshot()
  }

  markClaimed(at: Date): AuctionPendingClaimSnapshot {
    return this.claim(at)
  }

  expire(at: Date): AuctionPendingClaimSnapshot {
    AuctionPendingClaim.assertTransitionDate(at)

    if (this.claimStatus === AuctionPendingClaimStatus.Claimed) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.AlreadyClaimed,
        'Un producto reclamado no puede expirar.',
      )
    }
    if (this.claimStatus === AuctionPendingClaimStatus.Expired) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.AlreadyExpired,
        'El producto ya esta expirado.',
      )
    }
    if (at.getTime() <= this.claimDeadline.getTime()) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.ClaimPeriodStillOpen,
        'El plazo de reclamo aun esta abierto.',
      )
    }

    this.claimStatus = AuctionPendingClaimStatus.Expired
    this.updatedAt = new Date(at)
    return this.snapshot()
  }

  markExpired(at: Date): AuctionPendingClaimSnapshot {
    return this.expire(at)
  }

  snapshot(): AuctionPendingClaimSnapshot {
    return {
      auctionId: this.auctionId.value,
      winnerId: this.winnerId.value,
      productId: this.productId.value,
      winningBidId: this.winningBidId.value,
      finalAmountCredits: this.finalAmountCredits.value,
      settledAt: new Date(this.settledAt),
      claimDeadline: this.claimDeadline,
      claimStatus: this.claimStatus,
      claimedAt: this.claimedAt === null ? null : new Date(this.claimedAt),
      createdAt: new Date(this.createdAt),
      updatedAt: new Date(this.updatedAt),
    }
  }

  private calculateClaimDeadline(): Date {
    return new Date(this.settledAt.getTime() + CLAIM_PERIOD_MS)
  }

  private static createCredits(value: number): Credits {
    try {
      return Credits.positive(value, 'importe final')
    } catch {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.InvalidAmount,
        'El importe final debe ser un entero positivo.',
      )
    }
  }

  private static assertDate(
    value: Date,
    code:
      | AuctionPendingClaimRuleCode.InvalidSettledAt
      | AuctionPendingClaimRuleCode.InvalidCreatedAt
      | AuctionPendingClaimRuleCode.InvalidUpdatedAt
      | AuctionPendingClaimRuleCode.InvalidClaimedAt,
  ): void {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AuctionPendingClaimRuleViolation(code, 'La fecha debe ser un instante valido.')
    }
  }

  private static assertTransitionDate(value: Date): void {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.InvalidTransitionDate,
        'La fecha de transicion debe ser un instante valido.',
      )
    }
  }

  private static isStatus(value: string): value is AuctionPendingClaimStatus {
    return Object.values(AuctionPendingClaimStatus).includes(value as AuctionPendingClaimStatus)
  }
}
