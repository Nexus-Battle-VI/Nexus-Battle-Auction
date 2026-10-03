/**
 * El `auctionId` de la ruta no corresponde a ninguna subasta.
 *
 * Distinto de `PersistedAuctionNotFoundError`: aquella es una violacion de
 * integridad interna; esta es, sencillamente, el dato que el cliente envio
 * (mismo criterio que `AuctionNotFoundError` de compra inmediata).
 */
export class AuctionCancellationNotFoundError extends Error {
  constructor(readonly auctionId: string) {
    super(`No existe ninguna subasta con id ${auctionId}.`)
    this.name = 'AuctionCancellationNotFoundError'
  }
}

/**
 * La identidad autenticada no es el vendedor propietario de la subasta.
 *
 * El mensaje no revela mas que el propio `auctionId` que el solicitante ya
 * conocia (mismo criterio que `PendingClaimOwnershipError`).
 */
export class AuctionCancellationOwnershipError extends Error {
  constructor(readonly auctionId: string) {
    super(`La identidad autenticada no es el vendedor de la subasta ${auctionId}.`)
    this.name = 'AuctionCancellationOwnershipError'
  }
}
