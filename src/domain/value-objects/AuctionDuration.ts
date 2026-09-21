import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'
import { Credits } from './Credits'

export type AuctionDurationHours = 24 | 48

const HOUR_IN_MILLISECONDS = 60 * 60 * 1000

export class AuctionDuration {
  private constructor(
    readonly hours: AuctionDurationHours,
    readonly publicationFee: Credits,
  ) {}

  static fromHours(hours: number): AuctionDuration {
    if (hours === 24) return new AuctionDuration(24, Credits.positive(1, 'comision'))
    if (hours === 48) return new AuctionDuration(48, Credits.positive(3, 'comision'))

    throw new AuctionRuleViolation(
      AuctionRuleCode.InvalidDuration,
      'La duracion de la subasta debe ser de 24 o 48 horas.',
    )
  }

  calculateClosingTime(publishedAt: Date): Date {
    return new Date(publishedAt.getTime() + this.hours * HOUR_IN_MILLISECONDS)
  }
}
