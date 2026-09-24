import { DomainError } from '../errors/DomainError'

/** La subasta existe pero su estado o plazo impiden un nuevo seguimiento. */
export class AuctionNotFollowableError extends DomainError {
  readonly code = 'AUCTION_NOT_FOLLOWABLE'
  constructor() {
    super('Solo se pueden seguir subastas activas cuyo plazo no haya vencido.')
    this.name = 'AuctionNotFollowableError'
  }
}

/** Evalua el limite de cierre de forma determinista, incluyendo el instante exacto. */
export const assertAuctionFollowable = (
  auction: { readonly status: string; readonly closesAt: Date },
  now: Date,
): void => {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(auction.closesAt.getTime())) {
    throw new Error('Fecha de reloj o cierre invalida al evaluar seguimiento.')
  }
  if (auction.status !== 'ACTIVE' || now.getTime() >= auction.closesAt.getTime()) {
    throw new AuctionNotFollowableError()
  }
}
