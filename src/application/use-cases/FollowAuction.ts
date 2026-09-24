import { WatchlistEntry } from '../../domain/entities/WatchlistEntry'
import { assertAuctionFollowable } from '../../domain/services/watchlist-eligibility'
import { AuctionId } from '../../domain/value-objects/AuctionIdentifiers'
import { WatchlistPlayerId } from '../../domain/value-objects/WatchlistPlayerId'
import type { WatchlistDto } from '../dto/WatchlistDto'
import { PersistedAuctionNotFoundError } from '../errors/AuctionPersistenceError'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { WatchlistRepositoryPort } from '../ports/WatchlistRepositoryPort'

/** Coordina elegibilidad y persistencia; no conoce HTTP, JWT ni el motor de datos. */
export class FollowAuction {
  constructor(
    private readonly watchlist: WatchlistRepositoryPort,
    private readonly auctions: Pick<AuctionRepositoryPort, 'findById'>,
    private readonly clock: ClockPort,
  ) {}

  /** Sigue una subasta al instante validado; la unicidad concurrente se decide en persistencia. */
  async execute(playerId: string, auctionId: string): Promise<WatchlistDto> {
    const player = WatchlistPlayerId.create(playerId).value
    const id = AuctionId.create(auctionId).value
    const auction = await this.auctions.findById(id)
    if (auction === null) throw new PersistedAuctionNotFoundError(id)
    // La lectura puede demorar: se evalua el plazo con el reloj posterior a ella.
    const now = this.clock.now()
    assertAuctionFollowable(auction, now)
    const entry = WatchlistEntry.create({ playerId: player, auctionId: id, followedAt: now })
    await this.watchlist.create(entry)
    return { auctionId: id, followedAt: entry.snapshot().followedAt }
  }
}
