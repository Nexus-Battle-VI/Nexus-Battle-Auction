export class PendingClaimNotFoundError extends Error {
  constructor(auctionId: string) {
    super(`No existe un producto pendiente de reclamo para la subasta ${auctionId}.`)
    this.name = 'PendingClaimNotFoundError'
  }
}

export class PendingClaimOwnershipError extends Error {
  constructor(auctionId: string) {
    super(`La identidad autenticada no es titular del reclamo de la subasta ${auctionId}.`)
    this.name = 'PendingClaimOwnershipError'
  }
}
