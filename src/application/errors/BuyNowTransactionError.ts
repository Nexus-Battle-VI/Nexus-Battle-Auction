/**
 * La subasta dejo de estar activa entre la validacion de dominio (HU-64.2) y el
 * cierre efectivo: otra compra inmediata la cerro primero, o expiro. Quien
 * pagó ya fue reembolsado antes de que este error se propague.
 */
export class AuctionAlreadyClosedError extends Error {
  constructor(auctionId: string) {
    super(`La subasta ${auctionId} ya no esta activa; no se puede completar la compra inmediata.`)
    this.name = 'AuctionAlreadyClosedError'
  }
}

export class BuyNowIdempotencyConflictError extends Error {
  constructor() {
    super('La operacion de compra inmediata ya fue utilizada con otra solicitud.')
    this.name = 'BuyNowIdempotencyConflictError'
  }
}
