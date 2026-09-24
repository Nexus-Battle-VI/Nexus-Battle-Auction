import { WatchlistPlayerId } from '../../domain/value-objects/WatchlistPlayerId'
import type { FollowedAuctionsDto } from '../dto/WatchlistDto'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { WatchlistRepositoryPort } from '../ports/WatchlistRepositoryPort'

/** Lectura de la lista propia, conservando orden y enriqueciendo sin duplicar persistencia. */
export class ListFollowedAuctions {
  constructor(
    private readonly watchlist: WatchlistRepositoryPort,
    private readonly auctions: Pick<AuctionRepositoryPort, 'findById'>,
  ) {}

  /** No descarta subastas vencidas ni transforma fallos de lectura en una lista vacia. */
  async execute(playerId: string): Promise<FollowedAuctionsDto> {
    const entries = await this.watchlist.listByPlayer(WatchlistPlayerId.create(playerId).value)
    const items = await Promise.all(
      entries.map(async (entry) => {
        const { auctionId, followedAt } = entry.snapshot()
        const auction = await this.auctions.findById(auctionId)
        if (auction === null) throw new Error('Seguimiento referencia una subasta inexistente.')
        return { auctionId, followedAt, auction }
      }),
    )
    return { items }
  }
}
