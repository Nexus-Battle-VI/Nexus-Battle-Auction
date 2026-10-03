/**
 * HU-90. Progreso de los DOS efectos externos de una cancelacion manual
 * confirmada localmente: el refund parcial en Wallet y el release del
 * commitment en Player-Inventory. Mismos cuatro valores que ya usa
 * `AuctionInventorySettlementIntentTable.status`/`CaptureStatus` de
 * settlement -no se inventa un vocabulario nuevo-.
 */
export enum AuctionCancellationEffectStatus {
  Pending = 'PENDING',
  Confirmed = 'CONFIRMED',
  Retryable = 'RETRYABLE',
  TerminalError = 'TERMINAL_ERROR',
}

export interface AuctionCancellationSnapshot {
  readonly auctionId: string
  readonly operationId: string
  readonly sellerId: string
  readonly productId: string
  readonly inventoryCommitmentId: string
  readonly feeChargeId: string | null
  readonly refundAmountCredits: number
  readonly walletRefundOperationId: string
  readonly walletRefundStatus: AuctionCancellationEffectStatus
  readonly inventoryReleaseOperationId: string
  readonly inventoryReleaseStatus: AuctionCancellationEffectStatus
  /**
   * Dos campos separados, NO uno compartido: wallet e inventory son efectos
   * independientes que se resuelven uno tras otro en la misma ejecucion
   * (ver `CancelAuction.resumeAfterCommit`). Un solo campo `lastError`
   * haria que el que resuelve SEGUNDO sobreescriba el mensaje del primero
   * en cuanto confirmara (que limpia el error a `null`), perdiendo la causa
   * real de un RETRYABLE/TERMINAL_ERROR del otro efecto.
   */
  readonly walletRefundLastError: string | null
  readonly inventoryReleaseLastError: string | null
  readonly cancelledAt: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateAuctionCancellationInput {
  readonly auctionId: string
  readonly operationId: string
  readonly sellerId: string
  readonly productId: string
  readonly inventoryCommitmentId: string
  readonly feeChargeId: string | null
  readonly refundAmountCredits: number
  readonly walletRefundOperationId: string
  readonly inventoryReleaseOperationId: string
  readonly cancelledAt: Date
}

/**
 * HU-90 (PR3), `7.7.10`. Reclamo durable de cancelaciones con al menos un
 * efecto externo en `PENDING`/`RETRYABLE`, mismo vocabulario que
 * `ClaimDueAuctionSettlementsInput`: no se inventa un patron nuevo.
 */
export interface ClaimPendingAuctionCancellationsInput {
  readonly now: Date
  readonly workerId: string
  readonly leaseUntil: Date
  readonly limit: number
}

export interface AuctionCancellationRepositoryPort {
  getByAuctionId(auctionId: string): Promise<AuctionCancellationSnapshot | null>
  markWalletRefundConfirmed(auctionId: string, updatedAt: Date): Promise<void>
  markWalletRefundRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void>
  markWalletRefundTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void>
  markInventoryReleaseConfirmed(auctionId: string, updatedAt: Date): Promise<void>
  markInventoryReleaseRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void>
  markInventoryReleaseTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void>
  /**
   * Candidatos a reconciliacion: wallet o inventory (o ambos) en
   * `PENDING`/`RETRYABLE`, con el lease libre o vencido. Devuelve el
   * snapshot completo -misma fila que ya tiene todo lo que el reconciler
   * necesita (chargeId, refundAmountCredits, commitment, sellerId,
   * productId, estados)- sin una segunda consulta por fila.
   */
  claimPendingCancellations(
    input: ClaimPendingAuctionCancellationsInput,
  ): Promise<readonly AuctionCancellationSnapshot[]>
}

export const AUCTION_CANCELLATION_REPOSITORY = Symbol('AuctionCancellationRepositoryPort')
