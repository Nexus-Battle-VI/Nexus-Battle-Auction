import { sql, type Kysely, type Selectable } from 'kysely'
import { PersistedAuctionNotFoundError } from '../../../application/errors/AuctionPersistenceError'
import { WatchlistAlreadyExistsError } from '../../../application/errors/WatchlistAlreadyExistsError'
import type { WatchlistRepositoryPort } from '../../../application/ports/WatchlistRepositoryPort'
import { WatchlistEntry } from '../../../domain/entities/WatchlistEntry'
import type { AuctionWatchlistTable, Database } from './schema'

/** Traduce la fila persistida validando de nuevo las invariantes del dominio. */
const fromRow = (row: Selectable<AuctionWatchlistTable>): WatchlistEntry =>
  WatchlistEntry.create({
    playerId: row.player_id,
    auctionId: row.auction_id,
    followedAt: row.followed_at,
  })

/** El indice unico del motor arbitra solicitudes concurrentes entre procesos. */
export class PostgresWatchlistRepository implements WatchlistRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  /** Una insercion SQL atomica; solo los conflictos conocidos se traducen. */
  async create(entry: WatchlistEntry): Promise<void> {
    const snapshot = entry.snapshot()
    try {
      await this.db
        .insertInto('auction_watchlist')
        .values({
          player_id: snapshot.playerId,
          auction_id: snapshot.auctionId,
          followed_at: snapshot.followedAt,
        })
        .execute()
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && 'constraint' in error) {
        if (error.code === '23505' && error.constraint === 'auction_watchlist_pkey')
          throw new WatchlistAlreadyExistsError()
        if (error.code === '23503' && error.constraint === 'auction_watchlist_auction_fk')
          throw new PersistedAuctionNotFoundError(snapshot.auctionId)
      }
      throw error
    }
  }

  /** La lectura siempre acota ambos miembros de la identidad compuesta. */
  async find(playerId: string, auctionId: string): Promise<WatchlistEntry | null> {
    const row = await this.db
      .selectFrom('auction_watchlist')
      .selectAll()
      .where('player_id', '=', playerId)
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()
    return row === undefined ? null : fromRow(row)
  }

  /** Orden estable independiente de la configuracion regional del motor. */
  async listByPlayer(playerId: string): Promise<readonly WatchlistEntry[]> {
    const rows = await this.db
      .selectFrom('auction_watchlist')
      .selectAll()
      .where('player_id', '=', playerId)
      .orderBy('followed_at', 'desc')
      .orderBy(sql`auction_id collate "C"`, 'asc')
      .execute()
    return rows.map(fromRow)
  }

  /** La eliminacion repetida es inocua y nunca amplia el alcance a otro jugador. */
  async delete(playerId: string, auctionId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('auction_watchlist')
      .where('player_id', '=', playerId)
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()
    return result.numDeletedRows > 0n
  }
}
