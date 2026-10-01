import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { AuctionSnapshot } from '../../domain/entities/Auction'
import type { BidSnapshot } from '../../domain/entities/Bid'

export interface AuctionDetail {
  readonly auction: AuctionSnapshot
  readonly currentBid: BidSnapshot | null
  /** Total real de pujas persistidas; no se deriva de `currentBid`. */
  readonly bidCount: number
}

/**
 * Consulta funcional utilizada por HU-63.6.
 *
 * La Web necesita conocer el estado de la subasta,
 * el incremento minimo configurado y la puja lider
 * vigente sin replicar reglas del dominio en frontend.
 */
export class GetAuctionDetail {
  constructor(private readonly repository: AuctionRepositoryPort) {}

  async execute(auctionId: string): Promise<AuctionDetail | null> {
    const auction = await this.repository.findById(auctionId)

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
