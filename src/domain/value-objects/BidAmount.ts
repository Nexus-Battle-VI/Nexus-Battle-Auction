import { BidRuleCode, BidRuleViolation } from '../errors/BidRuleViolation'

export class BidAmount {
  private constructor(readonly value: number) {}

  static positive(value: number, label = 'monto de la puja'): BidAmount {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BidRuleViolation(
        BidRuleCode.InvalidBidAmount,
        `${label} debe ser un entero positivo.`,
      )
    }

    return new BidAmount(value)
  }

  isGreaterThan(other: BidAmount): boolean {
    return this.value > other.value
  }

  isGreaterThanOrEqual(other: BidAmount): boolean {
    return this.value >= other.value
  }

  add(other: BidAmount): BidAmount {
    return BidAmount.positive(this.value + other.value)
  }

  equals(other: BidAmount): boolean {
    return this.value === other.value
  }
}
