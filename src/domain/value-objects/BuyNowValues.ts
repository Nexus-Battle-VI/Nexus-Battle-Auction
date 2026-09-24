import { BuyNowRuleCode, BuyNowRuleViolation } from '../errors/BuyNowRuleViolation'

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/

export class BuyerId {
  private constructor(readonly value: string) {}

  static create(value: string): BuyerId {
    const normalized = value.trim()

    if (!ID_PATTERN.test(normalized)) {
      throw new BuyNowRuleViolation(
        BuyNowRuleCode.InvalidIdentifier,
        'buyerId debe ser un identificador no vacio de maximo 128 caracteres.',
      )
    }

    return new BuyerId(normalized)
  }

  equals(other: BuyerId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

/**
 * Saldo de creditos del comprador informado al dominio. Admite cero, a
 * diferencia de `Credits`, que solo representa importes positivos.
 */
export class CreditBalance {
  private constructor(readonly value: number) {}

  static of(value: number): CreditBalance {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BuyNowRuleViolation(
        BuyNowRuleCode.InvalidCreditBalance,
        'El saldo del comprador debe ser un entero no negativo.',
      )
    }

    return new CreditBalance(value)
  }
}
