export class ActiveAuctionLimitExceededError extends Error {
  constructor() {
    super('El vendedor alcanzo el limite de 10 subastas activas.')
    this.name = 'ActiveAuctionLimitExceededError'
  }
}

export class InsufficientPublicationFundsError extends Error {
  constructor() {
    super('El vendedor no tiene creditos suficientes para pagar la publicacion.')
    this.name = 'InsufficientPublicationFundsError'
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

export class BidAlreadyExistsError extends Error {
  constructor(bidId: string) {
    super(`La puja ${bidId} ya existe.`)
    this.name = 'BidAlreadyExistsError'
  }
}

export class ConcurrentBidConflictError extends Error {
  constructor() {
    super('La puja dejo de ser valida porque otra oferta se convirtio en lider.')
    this.name = 'ConcurrentBidConflictError'
  }
}

/** Catalog no clasifica el producto como exclusivo, publicable o con marca oficial (HU-66). */
export class ProductNotEligibleForOfficialAuctionError extends Error {
  constructor(readonly productId: string) {
    super(`El producto ${productId} no es elegible para una subasta oficial.`)
    this.name = 'ProductNotEligibleForOfficialAuctionError'
  }
}
