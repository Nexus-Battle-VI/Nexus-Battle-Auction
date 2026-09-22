import { DomainError } from '../errors/DomainError'
import { AuctionId } from '../value-objects/AuctionIdentifiers'
import { WatchlistPlayerId } from '../value-objects/WatchlistPlayerId'

export interface WatchlistEntrySnapshot {
  playerId: string
  auctionId: string
  followedAt: Date
}

/** Relacion jugador-subasta; su identidad es la pareja, sin ID artificial. */
export class WatchlistEntry {
  private constructor(private readonly state: WatchlistEntrySnapshot) {}

  /** Valida identidades y fecha explicita; elegibilidad y autenticacion pertenecen a TASK 68.2. */
  static create(input: WatchlistEntrySnapshot): WatchlistEntry {
    const playerId = WatchlistPlayerId.create(input.playerId).value
    if (Number.isNaN(input.followedAt.getTime())) {
      throw new DomainError('La fecha de seguimiento debe ser valida.')
    }
    return new WatchlistEntry({
      playerId,
      auctionId: AuctionId.create(input.auctionId).value,
      followedAt: new Date(input.followedAt),
    })
  }

  /** Devuelve copia defensiva para impedir que consumidores alteren la fecha interna. */
  snapshot(): WatchlistEntrySnapshot {
    return { ...this.state, followedAt: new Date(this.state.followedAt) }
  }
}
