import { AutoBidRuleCode, AutoBidRuleViolation } from '../errors/AutoBidRuleViolation'

export class AutoBidLimit {
  private constructor(readonly value: number) {}

  static positive(value: number): AutoBidLimit {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AutoBidRuleViolation(
        AutoBidRuleCode.InvalidAutoBidLimit,
        'El limite maximo de puja automatica debe ser un entero positivo.',
      )
    }

    return new AutoBidLimit(value)
  }

  /**
   * El limite alcanza para cubrir el monto candidato de un incremento
   * automatico (HU-67.2).
   */
  canAfford(amountCredits: number): boolean {
    return this.value >= amountCredits
  }

  equals(other: AutoBidLimit): boolean {
    return this.value === other.value
  }
}
