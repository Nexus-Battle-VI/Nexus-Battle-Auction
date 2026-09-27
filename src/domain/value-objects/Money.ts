import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'

const ISO_4217_CODE = /^[A-Z]{3}$/u

export interface MoneyInput {
  readonly amountMinor: number
  readonly currency: string
}

/** Importe exacto expresado en la unidad menor de una moneda ISO 4217. */
export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: string,
  ) {}

  static positive(input: MoneyInput, label = 'precio'): Money {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidMoney,
        `${label} debe ser un entero positivo en unidades monetarias menores.`,
      )
    }
    if (!ISO_4217_CODE.test(input.currency)) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidMoney,
        'La moneda debe usar un codigo ISO 4217 de tres letras mayusculas.',
      )
    }
    return new Money(input.amountMinor, input.currency)
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other)
    return this.amountMinor > other.amountMinor
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.CurrencyMismatch,
        'Los precios minimo e inmediato deben usar la misma moneda.',
      )
    }
  }
}
