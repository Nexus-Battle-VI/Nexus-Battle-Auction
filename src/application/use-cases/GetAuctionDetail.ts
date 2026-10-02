import type { AuctionDetailSnapshot, AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { BidSnapshot } from '../../domain/entities/Bid'

export interface AuctionDetail {
  readonly auction: AuctionDetailSnapshot
  readonly currentBid: BidSnapshot | null
  /** Total real de pujas persistidas; no se deriva de `currentBid`. */
  readonly bidCount: number
}

/**
 * Consulta funcional utilizada por HU-63.6 y extendida por HU-88.
 *
 * La Web necesita conocer el estado de la subasta -PLAYER/CREDITS u oficial
 * GAME_MASTER/REAL_MONEY, en cualquier estado, no solo `ACTIVE`-, el
 * incremento minimo o el precio oficial configurado y la puja lider vigente,
 * sin replicar reglas del dominio en frontend. `findDetailById` no reemplaza
 * `findById`: ese sigue siendo CREDITS-only para la logica de negocio de
 * puja/auto-puja/compra/publicacion/watchlist.
 */
export class GetAuctionDetail {
  constructor(private readonly repository: AuctionRepositoryPort) {}

  async execute(auctionId: string): Promise<AuctionDetail | null> {
    const auction = await this.repository.findDetailById(auctionId)

    if (auction === null) {
      return null
    }

    const [currentBid, bidCount] = await Promise.all([
      this.repository.findLeadingBid(auctionId),
      this.repository.countBids(auctionId),
    ])

    return {
      auction,
      currentBid,
      bidCount,
    }
  }
}
