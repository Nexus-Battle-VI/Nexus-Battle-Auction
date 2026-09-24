import type {
  AuctionPendingClaimRepositoryPort,
  AuctionPendingClaimSnapshot,
} from '../ports/AuctionPendingClaimRepositoryPort'

/**
 * Consulta funcional utilizada por HU-69.2.
 *
 * Devuelve los productos ganados que el titular todavia puede reclamar,
 * reutilizando el claimDeadline ya calculado por el agregado (HU-69.1)
 * en vez de reimplementar la regla de los siete dias.
 */
export class GetPendingClaims {
  constructor(private readonly pendingClaims: AuctionPendingClaimRepositoryPort) {}

  execute(winnerId: string): Promise<readonly AuctionPendingClaimSnapshot[]> {
    return this.pendingClaims.findPendingByWinnerId(winnerId)
  }
}
