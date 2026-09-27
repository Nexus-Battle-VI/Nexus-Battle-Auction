/**
 * El `auctionId` de la ruta no corresponde a ninguna subasta.
 *
 * Distinto de `PersistedAuctionNotFoundError`: aquella es una violacion de
 * integridad interna (un identificador ya validado que deberia existir y no
 * aparece); esta es, sencillamente, el dato que el cliente envio.
 */
export class AuctionNotFoundError extends Error {
  constructor(readonly auctionId: string) {
    super(`No existe ninguna subasta con id ${auctionId}.`)
    this.name = 'AuctionNotFoundError'
  }
}
