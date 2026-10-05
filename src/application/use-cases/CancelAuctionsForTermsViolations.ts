import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import {
  findAuctionTermsViolation,
  type SellerActiveSanctionsPort,
} from '../ports/SellerSanctionPort'
import {
  AutomaticCancellationOutcome,
  type CancelAuctionAutomatically,
} from './CancelAuctionAutomatically'

export interface CancelAuctionsForTermsViolationsLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  warn(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  error(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

export interface CancelAuctionsForTermsViolationsOptions {
  /** Vendedores por pagina. Un ciclo recorre todas las paginas. */
  readonly batchSize: number
}

export interface CancelAuctionsForTermsViolationsResult {
  readonly processedSellers: number
  readonly triggeredSellers: number
  readonly cancelledAuctions: number
  readonly failed: number
}

type MutableResult = {
  -readonly [Key in keyof CancelAuctionsForTermsViolationsResult]: number
}

const errorNameOf = (error: unknown): string =>
  error instanceof Error ? error.name : 'desconocido'

/**
 * HU-90, CA-05. Un ciclo de sondeo: por cada vendedor con subastas ACTIVE
 * consulta UNA vez a Account y, solo si devuelve una sancion activa con
 * reasonCode AUCTION_TERMS_VIOLATION, cancela automaticamente todas sus
 * subastas ACTIVE.
 *
 * Fail-closed para la cancelacion: si Account no responde, responde con
 * error, no reconoce al vendedor o devuelve un payload invalido, NO se
 * cancela nada y el vendedor se vuelve a consultar en el siguiente ciclo.
 * `hasActiveSanctions = true` sin esa sancion concreta tampoco cancela.
 *
 * Un fallo en un vendedor o en una subasta se cuenta y se registra, pero no
 * detiene el resto del ciclo.
 */
export class CancelAuctionsForTermsViolations {
  constructor(
    private readonly auctions: AuctionRepositoryPort,
    private readonly sanctions: SellerActiveSanctionsPort,
    private readonly cancelAutomatically: Pick<CancelAuctionAutomatically, 'execute'>,
    private readonly logger: CancelAuctionsForTermsViolationsLogger,
    private readonly options: CancelAuctionsForTermsViolationsOptions,
  ) {}

  async runBatch(): Promise<CancelAuctionsForTermsViolationsResult> {
    const result: MutableResult = {
      processedSellers: 0,
      triggeredSellers: 0,
      cancelledAuctions: 0,
      failed: 0,
    }

    let afterSellerId: string | null = null
    for (;;) {
      const sellerIds = await this.auctions.listActiveSellerIds({
        afterSellerId,
        limit: this.options.batchSize,
      })
      for (const sellerId of sellerIds) {
        await this.processSeller(sellerId, result)
      }
      const last = sellerIds.at(-1)
      if (last === undefined || sellerIds.length < this.options.batchSize) break
      afterSellerId = last
    }

    // Solo contadores: ni ids de vendedor ni de sancion. Un ciclo sin
    // vendedores con subastas activas no deja rastro.
    if (result.processedSellers > 0) {
      this.logger.info('auction_terms_violation_cycle_completed', { ...result })
    }
    return result
  }

  private async processSeller(sellerId: string, result: MutableResult): Promise<void> {
    result.processedSellers += 1

    let sanctionId: string
    let auctionIds: readonly string[]
    try {
      const status = await this.sanctions.getActiveSanctions(sellerId)
      const violation = findAuctionTermsViolation(status)
      if (violation === null) return
      sanctionId = violation.id
      auctionIds = await this.auctions.listActiveAuctionIdsBySeller(sellerId)
    } catch (error: unknown) {
      result.failed += 1
      this.logger.warn('auction_terms_violation_seller_check_failed', {
        reason: errorNameOf(error),
      })
      return
    }

    result.triggeredSellers += 1
    for (const auctionId of auctionIds) {
      try {
        const response = await this.cancelAutomatically.execute({ auctionId, sanctionId })
        if (response.outcome === AutomaticCancellationOutcome.Cancelled) {
          result.cancelledAuctions += 1
        }
      } catch (error: unknown) {
        result.failed += 1
        this.logger.error('auction_terms_violation_cancellation_failed', {
          auctionId,
          reason: errorNameOf(error),
        })
      }
    }
  }
}
