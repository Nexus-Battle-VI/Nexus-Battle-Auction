import { AuctionRuleCode, AuctionRuleViolation } from '../errors/AuctionRuleViolation'

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/

abstract class AuctionIdentifier {
  protected constructor(readonly value: string) {}

  protected static validate(value: string, label: string): string {
    const normalized = value.trim()
    if (!ID_PATTERN.test(normalized)) {
      throw new AuctionRuleViolation(
        AuctionRuleCode.InvalidIdentifier,
        `${label} debe ser un identificador no vacio de maximo 128 caracteres.`,
      )
    }
    return normalized
  }

  equals(other: AuctionIdentifier): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export class AuctionId extends AuctionIdentifier {
  static create(value: string): AuctionId {
    return new AuctionId(AuctionIdentifier.validate(value, 'auctionId'))
  }
}

export class SellerId extends AuctionIdentifier {
  static create(value: string): SellerId {
    return new SellerId(AuctionIdentifier.validate(value, 'sellerId'))
  }
}

export class ProductId extends AuctionIdentifier {
  static create(value: string): ProductId {
    return new ProductId(AuctionIdentifier.validate(value, 'productId'))
  }
}
