import { AuctionId, ProductId, SellerId } from '../value-objects/AuctionIdentifiers'
import { AuctionStatus } from './Auction'

const ACTIVE_STATUS: string = AuctionStatus.Active

export interface BuyNowAuctionInput {
  auctionId: string
  sellerId: string
  productId: string
  status: string
  /** Precio de compra inmediata configurado por el vendedor; `null` si no lo definio. */
  buyNowCredits: number | null
}

export interface BuyNowAuctionSnapshot {
  auctionId: string
  sellerId: string
  productId: string
  status: string
  buyNowCredits: number | null
  buyNowAvailable: boolean
}

/**
 * Vista de una subasta desde la compra inmediata: su precio y su disponibilidad.
 *
 * No valida el precio: la existencia y validez del precio (CA-03) son una regla
 * de la compra y viven en `requireBuyNowPrice`. Aqui solo se guarda lo que
 * publico el vendedor, con los identificadores ya normalizados.
 */
export class BuyNowAuction {
  private constructor(
    readonly id: AuctionId,
    readonly sellerId: SellerId,
    readonly productId: ProductId,
    readonly status: string,
    readonly buyNowCredits: number | null,
  ) {}

  static from(input: BuyNowAuctionInput): BuyNowAuction {
    return new BuyNowAuction(
      AuctionId.create(input.auctionId),
      SellerId.create(input.sellerId),
      ProductId.create(input.productId),
      input.status,
      input.buyNowCredits,
    )
  }

  get isActive(): boolean {
    return this.status === ACTIVE_STATUS
  }

  /** La opcion existe solo con la subasta activa y un precio configurado. */
  get isBuyNowAvailable(): boolean {
    return this.isActive && this.buyNowCredits !== null
  }

  snapshot(): BuyNowAuctionSnapshot {
    return {
      auctionId: this.id.value,
      sellerId: this.sellerId.value,
      productId: this.productId.value,
      status: this.status,
      buyNowCredits: this.buyNowCredits,
      buyNowAvailable: this.isBuyNowAvailable,
    }
  }
}
