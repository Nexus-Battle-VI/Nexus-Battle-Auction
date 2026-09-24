import type { BuyNowAuction } from '../entities/BuyNowAuction'
import {
  BuyNowRuleCode,
  BuyNowRuleViolation,
  InsufficientCreditsViolation,
} from '../errors/BuyNowRuleViolation'
import { Credits } from '../value-objects/Credits'
import type { CreditBalance } from '../value-objects/BuyNowValues'

/**
 * Existencia y validez del precio de compra inmediata (CA-03).
 * Devuelve el precio ya como `Credits` para que el resto del flujo no lo
 * vuelva a interpretar.
 */
export function requireBuyNowPrice(auction: BuyNowAuction): Credits {
  const price = auction.buyNowCredits

  if (price === null) {
    throw new BuyNowRuleViolation(
      BuyNowRuleCode.BuyNowPriceUnavailable,
      'El vendedor no configuro un precio de compra inmediata para esta subasta.',
    )
  }

  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new BuyNowRuleViolation(
      BuyNowRuleCode.InvalidBuyNowPrice,
      'El precio de compra inmediata debe ser un entero positivo.',
    )
  }

  return Credits.positive(price, 'precio de compra inmediata')
}

/**
 * Confirmacion obligatoria (CA-04). Solo `true` confirma: cualquier otro valor,
 * incluido uno que llegue mal tipado desde fuera del dominio, se rechaza.
 */
export function requireConfirmation(confirmed: boolean): void {
  if ((confirmed as unknown) !== true) {
    throw new BuyNowRuleViolation(
      BuyNowRuleCode.ConfirmationRequired,
      'Debe confirmar la compra inmediata antes de ejecutarla.',
    )
  }
}

/**
 * Saldo suficiente del comprador (CA-02). Un saldo igual al precio alcanza.
 * Devuelve el saldo que quedaria tras el debito.
 */
export function requireSufficientBalance(price: Credits, balance: CreditBalance): number {
  if (balance.value < price.value) {
    throw new InsufficientCreditsViolation({
      requiredCredits: price.value,
      availableCredits: balance.value,
      missingCredits: price.value - balance.value,
    })
  }

  return balance.value - price.value
}
