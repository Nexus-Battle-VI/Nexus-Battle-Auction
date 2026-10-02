import type { AuctionRepositoryPort, BidHistoryPage } from '../ports/AuctionRepositoryPort'

export interface GetAuctionBidHistoryQuery {
  readonly auctionId: string
  readonly page: number
  readonly pageSize: number
}

/**
 * HU-88. Historial publico y paginado de pujas de una subasta.
 *
 * `null` si la subasta no existe, distinto de una subasta existente sin
 * pujas -esa es una pagina vacia con `total: 0`-. Nunca expone `bidderId`:
 * `listBidHistoryPage` ni siquiera lo consulta a la base de datos. Una
 * subasta GAME_MASTER/REAL_MONEY valida simplemente no tiene filas en
 * `auction_bids` -las oficiales no admiten pujas, solo compra inmediata-, asi
 * que esta misma consulta responde `items: [], total: 0` sin ninguna rama
 * especial para ese caso.
 */
export class GetAuctionBidHistory {
  constructor(private readonly repository: AuctionRepositoryPort) {}

  async execute(query: GetAuctionBidHistoryQuery): Promise<BidHistoryPage | null> {
    const auction = await this.repository.findDetailById(query.auctionId)

    if (auction === null) {
      return null
    }

    return this.repository.listBidHistoryPage(query)
  }
}
