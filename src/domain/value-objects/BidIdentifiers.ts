import { BidRuleCode, BidRuleViolation } from '../errors/BidRuleViolation'

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/

abstract class BidIdentifier {
  protected constructor(readonly value: string) {}

  protected static validate(value: string, label: string): string {
    const normalized = value.trim()

    if (!ID_PATTERN.test(normalized)) {
      throw new BidRuleViolation(
        BidRuleCode.InvalidIdentifier,
        `${label} debe ser un identificador no vacio de maximo 128 caracteres.`,
      )
    }

    return normalized
  }

  equals(other: BidIdentifier): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export class BidId extends BidIdentifier {
  static create(value: string): BidId {
    return new BidId(BidIdentifier.validate(value, 'bidId'))
  }
}

export class BidderId extends BidIdentifier {
  static create(value: string): BidderId {
    return new BidderId(BidIdentifier.validate(value, 'bidderId'))
  }
}