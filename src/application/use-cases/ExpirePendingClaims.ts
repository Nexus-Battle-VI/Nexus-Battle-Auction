import type { AuctionPendingClaimRepositoryPort } from '../ports/AuctionPendingClaimRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

export interface ExpirePendingClaimsLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  warn(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

export interface ExpirePendingClaimsOptions {
  readonly batchSize: number
}

export interface ExpirePendingClaimsResult {
  readonly candidates: number
  readonly expired: number
  readonly skipped: number
}

/**
 * Caso de uso funcional para HU-69.6.
 *
 * A diferencia de ProcessExpiredAuctions (HU-65), esta transicion no llama a
 * ningun servicio externo (Wallet/Inventory): es una escritura local sobre
 * el propio agregado. Por eso no usa el mecanismo de lease/reintentos con
 * backoff de AuctionSettlementWorkRepositoryPort -- ese existe para
 * sobrevivir fallos de red que aqui no pueden ocurrir. La idempotencia y la
 * seguridad ante ejecuciones concurrentes las da el guard
 * `WHERE claim_status = 'PENDING'` dentro de markExpired: un candidato ya
 * vencido por otra instancia simplemente falla aqui y se cuenta como
 * `skipped`, sin abortar el resto del batch.
 *
 * Nunca toca creditos ni Inventory: el producto no vuelve al vendedor ni se
 * reembolsa al ganador, tal como exige CA-04.
 */
export class ExpirePendingClaims {
  constructor(
    private readonly pendingClaims: AuctionPendingClaimRepositoryPort,
    private readonly clock: ClockPort,
    private readonly logger: ExpirePendingClaimsLogger,
    private readonly options: ExpirePendingClaimsOptions,
  ) {}

  async runBatch(): Promise<ExpirePendingClaimsResult> {
    const now = this.clock.now()
    const candidates = await this.pendingClaims.findExpirablePending(now, this.options.batchSize)

    let expired = 0
    let skipped = 0
    for (const candidate of candidates) {
      try {
        await this.pendingClaims.markExpired(candidate.auctionId, now)
        expired += 1
        this.logger.info('auction_pending_claim_expired', { auctionId: candidate.auctionId })
      } catch (error) {
        skipped += 1
        this.logger.warn('auction_pending_claim_expire_skipped', {
          auctionId: candidate.auctionId,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { candidates: candidates.length, expired, skipped }
  }
}
