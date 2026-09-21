export class ActiveAuctionLimitExceededError extends Error {
  constructor() {
    super('El vendedor alcanzo el limite de 10 subastas activas.')
    this.name = 'ActiveAuctionLimitExceededError'
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('La operacion ya fue utilizada con otra solicitud.')
    this.name = 'IdempotencyConflictError'
  }
}

export class PersistedAuctionNotFoundError extends Error {
  constructor(auctionId: string) {
    super(`La subasta persistida ${auctionId} no existe.`)
    this.name = 'PersistedAuctionNotFoundError'
  }
}
