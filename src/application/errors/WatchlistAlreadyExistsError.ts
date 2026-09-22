/** Conflicto de unicidad estable, independiente de los codigos SQL y HTTP. */
export class WatchlistAlreadyExistsError extends Error {
  constructor() {
    super('El jugador ya sigue esta subasta.')
    this.name = 'WatchlistAlreadyExistsError'
  }
}
