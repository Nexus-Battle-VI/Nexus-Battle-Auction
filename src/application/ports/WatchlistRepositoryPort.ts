import type { WatchlistEntry } from '../../domain/entities/WatchlistEntry'

/** Persistencia de seguimiento, con identidades canonicas recibidas de la aplicacion. */
export interface WatchlistRepositoryPort {
  /** Inserta una pareja unica; rechaza duplicados y referencias a subastas inexistentes. */
  create(entry: WatchlistEntry): Promise<void>
  /** Recupera una pareja exacta, o null; nunca busca solo por auctionId. */
  find(playerId: string, auctionId: string): Promise<WatchlistEntry | null>
  /** Lista solo el jugador indicado, por fecha descendente y auctionId ascendente. */
  listByPlayer(playerId: string): Promise<readonly WatchlistEntry[]>
  /** Lista seguidores de una subasta para resolver destinatarios de eventos. */
  listByAuction(auctionId: string): Promise<readonly WatchlistEntry[]>
  /** Elimina solo la pareja indicada; false significa que no existia. */
  delete(playerId: string, auctionId: string): Promise<boolean>
}

export const WATCHLIST_REPOSITORY = Symbol('WatchlistRepositoryPort')
