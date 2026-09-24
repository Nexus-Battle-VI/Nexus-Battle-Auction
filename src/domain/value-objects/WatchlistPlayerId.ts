import { DomainError } from '../errors/DomainError'

/** Identidad local de jugador compartida por alta, consulta y retirada de seguimiento. */
export class WatchlistPlayerId {
  private constructor(readonly value: string) {}

  /** Aplica la convencion de IDs de Auction; no consulta Account ni interpreta tokens. */
  static create(value: string): WatchlistPlayerId {
    const normalized = value.trim()
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/.test(normalized)) {
      throw new DomainError('playerId debe ser un identificador valido de maximo 128 caracteres.')
    }
    return new WatchlistPlayerId(normalized)
  }
}
