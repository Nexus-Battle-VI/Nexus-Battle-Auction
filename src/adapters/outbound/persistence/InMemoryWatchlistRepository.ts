import { PersistedAuctionNotFoundError } from '../../../application/errors/AuctionPersistenceError'
import { WatchlistAlreadyExistsError } from '../../../application/errors/WatchlistAlreadyExistsError'
import type { AuctionRepositoryPort } from '../../../application/ports/AuctionRepositoryPort'
import type { WatchlistRepositoryPort } from '../../../application/ports/WatchlistRepositoryPort'
import {
  WatchlistEntry,
  type WatchlistEntrySnapshot,
} from '../../../domain/entities/WatchlistEntry'

/** Doble local con unicidad atomica dentro del proceso e integridad de referencia. */
export class InMemoryWatchlistRepository implements WatchlistRepositoryPort {
  private readonly entries = new Map<string, WatchlistEntrySnapshot>()
  constructor(private readonly auctions: Pick<AuctionRepositoryPort, 'findById'>) {}

  /** Comprueba existencia; no hay await entre la deteccion del duplicado y la escritura. */
  async create(entry: WatchlistEntry): Promise<void> {
    const snapshot = entry.snapshot()
    if ((await this.auctions.findById(snapshot.auctionId)) === null) {
      throw new PersistedAuctionNotFoundError(snapshot.auctionId)
    }
    const key = this.key(snapshot.playerId, snapshot.auctionId)
    if (this.entries.has(key)) throw new WatchlistAlreadyExistsError()
    this.entries.set(key, snapshot)
  }

  /** Recupera una nueva entidad sin compartir fechas mutables con el almacenamiento. */
  find(playerId: string, auctionId: string): Promise<WatchlistEntry | null> {
    const entry = this.entries.get(this.key(playerId, auctionId))
    return Promise.resolve(entry === undefined ? null : WatchlistEntry.create(entry))
  }

  /** Mantiene el mismo orden estable y aislamiento por jugador que PostgreSQL. */
  listByPlayer(playerId: string): Promise<readonly WatchlistEntry[]> {
    return Promise.resolve(
      [...this.entries.values()]
        .filter((entry) => entry.playerId === playerId)
        .sort(
          (a, b) =>
            b.followedAt.getTime() - a.followedAt.getTime() ||
            (a.auctionId < b.auctionId ? -1 : a.auctionId > b.auctionId ? 1 : 0),
        )
        .map((entry) => WatchlistEntry.create(entry)),
    )
  }

  /** Un jugador no elimina relaciones ajenas al retirar su pareja. */
  delete(playerId: string, auctionId: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(this.key(playerId, auctionId)))
  }

  /** Serializar la pareja evita colisiones con separadores permitidos en los IDs. */
  private key(playerId: string, auctionId: string): string {
    return JSON.stringify([playerId, auctionId])
  }
}
