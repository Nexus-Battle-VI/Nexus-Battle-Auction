import { BuyNowAuction, type BuyNowAuctionInput } from '../entities/BuyNowAuction'
import { BuyNowRuleCode, BuyNowRuleViolation } from '../errors/BuyNowRuleViolation'
import {
  requireBuyNowPrice,
  requireConfirmation,
  requireSufficientBalance,
} from '../validators/BuyNowValidators'
import { BuyerId, CreditBalance } from '../value-objects/BuyNowValues'

export interface BuyNowRequest {
  buyerId: string
  auction: BuyNowAuctionInput
  /** Casilla "Confirmo la compra inmediata" marcada por el comprador. */
  confirmed: boolean
  /** Creditos disponibles del comprador; los calcula y entrega Wallet. */
  buyerAvailableCredits: number
  requestedAt: Date
}

export interface BuyNowApproval {
  auctionId: string
  sellerId: string
  productId: string
  buyerId: string
  priceCredits: number
  availableCredits: number
  remainingCredits: number
  requestedAt: Date
}

/**
 * Decide si una compra inmediata puede ejecutarse. No debita, no cierra la
 * subasta ni notifica: entrega una aprobacion con los importes que el proceso de
 * transaccion (HU-64.3) necesita.
 *
 * Orden de las reglas, de la mas barata a la que depende de datos externos, de
 * modo que ante varias fallas se informe siempre la misma:
 * 1. datos de entrada validos;
 * 2. subasta activa;
 * 3. precio de compra inmediata existente y valido (CA-03);
 * 4. confirmacion marcada (CA-04);
 * 5. saldo suficiente (CA-02).
 */
export class BuyNowDomainService {
  evaluate(request: BuyNowRequest): BuyNowApproval {
    BuyNowDomainService.assertValidDate(request.requestedAt)

    const buyerId = BuyerId.create(request.buyerId)
    const auction = BuyNowAuction.from(request.auction)
    const balance = CreditBalance.of(request.buyerAvailableCredits)

    BuyNowDomainService.assertAuctionActive(auction)

    const price = requireBuyNowPrice(auction)

    requireConfirmation(request.confirmed)

    const remainingCredits = requireSufficientBalance(price, balance)

    return {
      auctionId: auction.id.value,
      sellerId: auction.sellerId.value,
      productId: auction.productId.value,
      buyerId: buyerId.value,
      priceCredits: price.value,
      availableCredits: balance.value,
      remainingCredits,
      requestedAt: new Date(request.requestedAt),
    }
  }

  private static assertValidDate(requestedAt: Date): void {
    if (Number.isNaN(requestedAt.getTime())) {
      throw new BuyNowRuleViolation(
        BuyNowRuleCode.InvalidPurchaseDate,
        'La fecha de la compra debe ser valida.',
      )
    }
  }

  private static assertAuctionActive(auction: BuyNowAuction): void {
    if (!auction.isActive) {
      throw new BuyNowRuleViolation(
        BuyNowRuleCode.AuctionNotActive,
        'La subasta debe estar activa para ejecutar la compra inmediata.',
      )
    }
  }
}
