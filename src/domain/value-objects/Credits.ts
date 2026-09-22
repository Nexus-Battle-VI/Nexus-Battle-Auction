import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'

export class Credits {
  private constructor(readonly value: number) {}

  static positive(value: number, label = 'creditos'): Credits {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidCredits,
        `${label} debe ser un entero positivo.`,
      )
    }
    return new Credits(value)
  }

  isGreaterThan(other: Credits): boolean {
    return this.value > other.value
  }

  equals(other: Credits): boolean {
    return this.value === other.value
  }
}
