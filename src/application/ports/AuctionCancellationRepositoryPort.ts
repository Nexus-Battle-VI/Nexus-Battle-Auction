import type { AuctionCancellationOrigin } from '../../domain/events/AuctionCancelledEventV1'

/**
 * HU-90. Progreso de los efectos externos de una cancelacion confirmada
 * localmente: el refund parcial en Wallet (solo manual), el release del
 * commitment en Player-Inventory y, en una automatica (CA-05), el release de
 * cada reserva de puja. Mismos valores que ya usa
 * `AuctionInventorySettlementIntentTable.status`/`CaptureStatus` de
 * settlement -no se inventa un vocabulario nuevo-.
 */
export enum AuctionCancellationEffectStatus {
  Pending = 'PENDING',
  Confirmed = 'CONFIRMED',
  Retryable = 'RETRYABLE',
  TerminalError = 'TERMINAL_ERROR',
  /**
   * El efecto no aplica a esta cancelacion. Solo lo usa el refund de Wallet
   * de una cancelacion automatica: la comision de publicacion se retiene
   * entera, asi que no hay nada que reembolsar ni que reconciliar.
   */
  NotRequired = 'NOT_REQUIRED',
}

/**
 * HU-90, CA-05. Release en Wallet de UNA reserva de puja que podia seguir
 * activa cuando se cancelo automaticamente la subasta. Una fila por reserva,
 * con su propio `operationId` determinista y su propio estado.
 */
export interface AuctionCancellationReservationReleaseSnapshot {
  readonly reservationId: string
  readonly operationId: string
  readonly status: AuctionCancellationEffectStatus
  readonly lastError: string | null
  readonly updatedAt: Date
}

export interface AuctionCancellationSnapshot {
  readonly auctionId: string
  readonly operationId: string
  /** Por que se cancelo: manual del vendedor o automatica por sancion. */
  readonly origin: AuctionCancellationOrigin
  /** Id de la sancion que disparo una cancelacion automatica; `null` en una manual. */
  readonly triggerReferenceId: string | null
  readonly sellerId: string
  readonly productId: string
  readonly inventoryCommitmentId: string
  readonly feeChargeId: string | null
  /** 0 en una cancelacion automatica: la comision no se reembolsa. */
  readonly refundAmountCredits: number
  /** `null` si y solo si `walletRefundStatus` es `NOT_REQUIRED`. */
  readonly walletRefundOperationId: string | null
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
  /** Siempre vacio en una cancelacion manual (exige cero pujas). */
  readonly reservationReleases: readonly AuctionCancellationReservationReleaseSnapshot[]
  readonly cancelledAt: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Estados de los efectos que SI aplican a la cancelacion (sin `NOT_REQUIRED`).
 * Lo comparten el reconciler y los casos de uso para decidir si queda algo
 * por resolver, sin que cada uno enumere los efectos por su cuenta.
 */
export const applicableCancellationEffectStatuses = (
  cancellation: AuctionCancellationSnapshot,
): readonly AuctionCancellationEffectStatus[] =>
  [
    cancellation.walletRefundStatus,
    cancellation.inventoryReleaseStatus,
    ...cancellation.reservationReleases.map((release) => release.status),
  ].filter((status) => status !== AuctionCancellationEffectStatus.NotRequired)

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

/** HU-90, CA-05. Seguimiento de una cancelacion automatica: sin refund de Wallet. */
export interface CreateAutomaticAuctionCancellationInput {
  readonly auctionId: string
  readonly operationId: string
  readonly triggerReferenceId: string
  readonly sellerId: string
  readonly productId: string
  readonly inventoryCommitmentId: string
  readonly inventoryReleaseOperationId: string
  readonly reservationReleases: readonly {
    readonly reservationId: string
    readonly operationId: string
  }[]
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
  markReservationReleaseConfirmed(
    auctionId: string,
    reservationId: string,
    updatedAt: Date,
  ): Promise<void>
  markReservationReleaseRetryable(
    auctionId: string,
    reservationId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void>
  markReservationReleaseTerminal(
    auctionId: string,
    reservationId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void>
  /**
   * Candidatos a reconciliacion: wallet, inventory o algun release de
   * reserva en `PENDING`/`RETRYABLE`, con el lease libre o vencido. Devuelve el
   * snapshot completo -misma fila que ya tiene todo lo que el reconciler
   * necesita (chargeId, refundAmountCredits, commitment, sellerId,
   * productId, estados)- sin una segunda consulta por fila.
   */
  claimPendingCancellations(
    input: ClaimPendingAuctionCancellationsInput,
  ): Promise<readonly AuctionCancellationSnapshot[]>
}

export const AUCTION_CANCELLATION_REPOSITORY = Symbol('AuctionCancellationRepositoryPort')
