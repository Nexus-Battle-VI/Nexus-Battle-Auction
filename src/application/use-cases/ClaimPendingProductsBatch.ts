import {
  AuctionPendingClaimRuleCode,
  AuctionPendingClaimRuleViolation,
} from '../../domain/errors/AuctionPendingClaimRuleViolation'
import {
  PendingClaimNotFoundError,
  PendingClaimOwnershipError,
} from '../errors/AuctionPendingClaimError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../errors/ExternalDependencyError'
import type {
  AuctionPendingClaimRepositoryPort,
  AuctionPendingClaimSnapshot,
} from '../ports/AuctionPendingClaimRepositoryPort'
import type { ClaimPendingProduct } from './ClaimPendingProduct'

export type ClaimBatchItemStatus =
  | 'CLAIMED'
  | 'ALREADY_CLAIMED'
  | 'NOT_OWNED'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'INVENTORY_UNAVAILABLE'
  | 'ERROR'

export interface ClaimPendingProductsBatchItemResult {
  readonly auctionId: string
  readonly status: ClaimBatchItemStatus
  readonly claim: AuctionPendingClaimSnapshot | null
  readonly message: string | null
}

export interface ClaimPendingProductsBatchResult {
  readonly results: readonly ClaimPendingProductsBatchItemResult[]
}

export type ClaimPendingProductsBatchInput =
  | { readonly winnerId: string; readonly claimAll: true }
  | {
      readonly winnerId: string
      readonly claimAll?: false
      readonly auctionIds: readonly string[]
    }

/**
 * Caso de uso funcional para HU-69.4.
 *
 * No reimplementa las reglas de HU-69.3: cada item se delega integramente en
 * ClaimPendingProduct.execute(), que ya valida titularidad, estado PENDING y
 * plazo vigente, y que ya es idempotente ante un pending-claim CLAIMED. Este
 * caso de uso solo itera, deduplica auctionIds repetidos (se procesan una
 * sola vez, nunca dos transferencias para el mismo auctionId) y traduce cada
 * resultado o error a un codigo por item.
 *
 * Nunca es todo-o-nada: un fallo individual (titular incorrecto, vencido, ya
 * reclamado, Inventory indisponible) se reporta en el item correspondiente
 * sin abortar ni afectar a los demas.
 *
 * El aislamiento por usuario es estructural, no una validacion extra aqui:
 * en modo explicito, ClaimPendingProduct.execute() ya rechaza (NOT_OWNED)
 * cualquier auctionId que no pertenezca a winnerId; en modo "claimAll", los
 * auctionIds a procesar salen unicamente de
 * pendingClaims.findPendingByWinnerId(winnerId), que por contrato de ese
 * puerto nunca devuelve reclamos de otro titular.
 */
export class ClaimPendingProductsBatch {
  constructor(
    private readonly claimPendingProduct: ClaimPendingProduct,
    private readonly pendingClaims: AuctionPendingClaimRepositoryPort,
  ) {}

  async execute(input: ClaimPendingProductsBatchInput): Promise<ClaimPendingProductsBatchResult> {
    const auctionIds =
      input.claimAll === true
        ? (await this.pendingClaims.findPendingByWinnerId(input.winnerId)).map(
            (claim) => claim.auctionId,
          )
        : dedupe(input.auctionIds)

    const results: ClaimPendingProductsBatchItemResult[] = []
    for (const auctionId of auctionIds) {
      results.push(await this.claimOne(auctionId, input.winnerId))
    }

    return { results }
  }

  private async claimOne(
    auctionId: string,
    winnerId: string,
  ): Promise<ClaimPendingProductsBatchItemResult> {
    // Se lee antes de delegar en ClaimPendingProduct solo para distinguir,
    // en la respuesta, un reclamo nuevo (CLAIMED) de un reintento sobre uno
    // que ya estaba CLAIMED (ALREADY_CLAIMED): ClaimPendingProduct.execute
    // devuelve el mismo snapshot en ambos casos porque ya es idempotente por
    // diseno (HU-69.3), y esa idempotencia es exactamente lo que sostiene la
    // idempotencia de lote pedida aqui.
    const before = await this.pendingClaims.findByAuctionId(auctionId)
    const wasAlreadyClaimed = before?.claimStatus === 'CLAIMED'

    try {
      const claim = await this.claimPendingProduct.execute({ auctionId, winnerId })

      return {
        auctionId,
        status: wasAlreadyClaimed ? 'ALREADY_CLAIMED' : 'CLAIMED',
        claim,
        message: null,
      }
    } catch (error) {
      return { auctionId, ...toFailure(error) }
    }
  }
}

const toFailure = (
  error: unknown,
): { status: ClaimBatchItemStatus; claim: null; message: string | null } => {
  if (error instanceof PendingClaimNotFoundError) {
    return { status: 'NOT_FOUND', claim: null, message: error.message }
  }
  if (error instanceof PendingClaimOwnershipError) {
    return { status: 'NOT_OWNED', claim: null, message: error.message }
  }
  if (error instanceof AuctionPendingClaimRuleViolation) {
    if (error.code === AuctionPendingClaimRuleCode.AlreadyClaimed) {
      return { status: 'ALREADY_CLAIMED', claim: null, message: null }
    }
    return { status: 'EXPIRED', claim: null, message: error.message }
  }
  if (
    error instanceof ExternalDependencyUnavailableError ||
    error instanceof ExternalContractError ||
    error instanceof ExternalResourceNotFoundError
  ) {
    return { status: 'INVENTORY_UNAVAILABLE', claim: null, message: error.message }
  }
  return {
    status: 'ERROR',
    claim: null,
    message: error instanceof Error ? error.message : 'Error desconocido al reclamar.',
  }
}

const dedupe = (auctionIds: readonly string[]): readonly string[] => [...new Set(auctionIds)]
