import { AuctionId } from '../../domain/value-objects/AuctionIdentifiers'
import { WatchlistPlayerId } from '../../domain/value-objects/WatchlistPlayerId'
import type { WatchlistRepositoryPort } from '../ports/WatchlistRepositoryPort'

/** Retirada privada e idempotente, independiente del estado actual de la subasta. */
export class UnfollowAuction {
  constructor(private readonly watchlist: WatchlistRepositoryPort) {}

  /** Elimina exclusivamente la pareja propia y no revela relaciones de otros jugadores. */
  async execute(playerId: string, auctionId: string): Promise<void> {
    await this.watchlist.delete(
      WatchlistPlayerId.create(playerId).value,
      AuctionId.create(auctionId).value,
    )
  }
}
