import { AutoBidRuleCode, AutoBidRuleViolation } from '../errors/AutoBidRuleViolation'
import { AuctionId } from '../value-objects/AuctionIdentifiers'
import { AutoBidLimit } from '../value-objects/AutoBidLimit'
import { BidderId } from '../value-objects/BidIdentifiers'

export interface AutoBidEligibility {
  auctionStatus: string
  sellerId: string
}

export interface ConfigureAutoBidInput {
  auctionId: string
  bidderId: string
  maxAmountCredits: number
  configuredAt: Date
  eligibility: AutoBidEligibility
}

export interface AutoBidConfigSnapshot {
  auctionId: string
  bidderId: string
  maxAmountCredits: number
  configuredAt: Date
  isActive: boolean
}

/**
 * Configuracion de puja automatica de HU-67.
 *
 * A diferencia de Bid, no expone un metodo `restore()`: una puja es un evento
 * inmutable cuyo registro debe reanudarse identico durante una saga en curso
 * (ver Bid.restore y RegisterBid.resumeExistingOperation), mientras que una
 * configuracion de puja automatica es estado mutable con como maximo una fila
 * activa por (auctionId, bidderId). Un reintento de la misma solicitud vuelve
 * a llamar a `configure()` con la misma intencion y produce el mismo
 * resultado sin necesitar reconstruir un objeto de dominio previo.
 */
export class AutoBidConfig {
  private constructor(
    readonly auctionId: AuctionId,
    readonly bidderId: BidderId,
    readonly maxAmount: AutoBidLimit,
    readonly configuredAt: Date,
    private active: boolean,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  static configure(input: ConfigureAutoBidInput): AutoBidConfig {
    AutoBidConfig.assertValidDate(input.configuredAt)

    AutoBidConfig.assertAuctionActive(input.eligibility.auctionStatus)

    AutoBidConfig.assertBidderIsNotSeller(input.bidderId, input.eligibility.sellerId)

    const maxAmount = AutoBidLimit.positive(input.maxAmountCredits)

    return new AutoBidConfig(
      AuctionId.create(input.auctionId),
      BidderId.create(input.bidderId),
      maxAmount,
      new Date(input.configuredAt),
      true,
    )
  }

  snapshot(): AutoBidConfigSnapshot {
    return {
      auctionId: this.auctionId.value,
      bidderId: this.bidderId.value,
      maxAmountCredits: this.maxAmount.value,
      configuredAt: new Date(this.configuredAt),
      isActive: this.active,
    }
  }

  private static assertValidDate(configuredAt: Date): void {
    if (Number.isNaN(configuredAt.getTime())) {
      throw new AutoBidRuleViolation(
        AutoBidRuleCode.InvalidConfigurationDate,
        'La fecha de configuracion debe ser valida.',
      )
    }
  }

  private static assertAuctionActive(status: string): void {
    if (status !== 'ACTIVE') {
      throw new AutoBidRuleViolation(
        AutoBidRuleCode.AuctionNotActive,
        'La subasta debe estar activa para configurar una puja automatica.',
      )
    }
  }

  private static assertBidderIsNotSeller(bidderId: string, sellerId: string): void {
    if (bidderId.trim() === sellerId.trim()) {
      throw new AutoBidRuleViolation(
        AutoBidRuleCode.SellerCannotConfigure,
        'El vendedor no puede configurar una puja automatica en su propia subasta.',
      )
    }
  }
}
