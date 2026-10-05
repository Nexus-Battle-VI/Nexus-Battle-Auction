import type {
  AuctionCancellationRepositoryPort,
  AuctionCancellationSnapshot,
  ClaimPendingAuctionCancellationsInput,
  CreateAuctionCancellationInput,
  CreateAutomaticAuctionCancellationInput,
} from '../../../application/ports/AuctionCancellationRepositoryPort'
import {
  AuctionCancellationEffectStatus,
  applicableCancellationEffectStatuses,
} from '../../../application/ports/AuctionCancellationRepositoryPort'
import { AuctionCancellationOrigin } from '../../../domain/events/AuctionCancelledEventV1'

const isPendingOrRetryable = (status: AuctionCancellationEffectStatus): boolean =>
  status === AuctionCancellationEffectStatus.Pending ||
  status === AuctionCancellationEffectStatus.Retryable

export class InMemoryAuctionCancellationRepository implements AuctionCancellationRepositoryPort {
  private readonly cancellations = new Map<string, AuctionCancellationSnapshot>()

  /** Lease del reconciler, aparte del snapshot publico -ver equivalente Postgres-. */
  private readonly leaseUntil = new Map<string, Date>()

  /** Usado solo por el doble en memoria de `AuctionRepositoryPort.cancelAuction`. */
  createIfAbsent(input: CreateAuctionCancellationInput): AuctionCancellationSnapshot {
    const existing = this.cancellations.get(input.auctionId)
    if (existing !== undefined) return existing
    const created: AuctionCancellationSnapshot = {
      auctionId: input.auctionId,
      operationId: input.operationId,
      origin: AuctionCancellationOrigin.Manual,
      triggerReferenceId: null,
      sellerId: input.sellerId,
      productId: input.productId,
      inventoryCommitmentId: input.inventoryCommitmentId,
      feeChargeId: input.feeChargeId,
      refundAmountCredits: input.refundAmountCredits,
      walletRefundOperationId: input.walletRefundOperationId,
      walletRefundStatus: AuctionCancellationEffectStatus.Pending,
      inventoryReleaseOperationId: input.inventoryReleaseOperationId,
      inventoryReleaseStatus: AuctionCancellationEffectStatus.Pending,
      walletRefundLastError: null,
      inventoryReleaseLastError: null,
      reservationReleases: [],
      cancelledAt: input.cancelledAt,
      createdAt: input.cancelledAt,
      updatedAt: input.cancelledAt,
    }
    this.cancellations.set(input.auctionId, created)
    return created
  }

  /** Usado solo por el doble en memoria de `AuctionRepositoryPort.cancelAuctionAutomatically`. */
  createAutomaticIfAbsent(
    input: CreateAutomaticAuctionCancellationInput,
  ): AuctionCancellationSnapshot {
    const existing = this.cancellations.get(input.auctionId)
    if (existing !== undefined) return existing
    const created: AuctionCancellationSnapshot = {
      auctionId: input.auctionId,
      operationId: input.operationId,
      origin: AuctionCancellationOrigin.TermsViolation,
      triggerReferenceId: input.triggerReferenceId,
      sellerId: input.sellerId,
      productId: input.productId,
      inventoryCommitmentId: input.inventoryCommitmentId,
      feeChargeId: null,
      refundAmountCredits: 0,
      walletRefundOperationId: null,
      walletRefundStatus: AuctionCancellationEffectStatus.NotRequired,
      inventoryReleaseOperationId: input.inventoryReleaseOperationId,
      inventoryReleaseStatus: AuctionCancellationEffectStatus.Pending,
      walletRefundLastError: null,
      inventoryReleaseLastError: null,
      reservationReleases: input.reservationReleases.map((release) => ({
        reservationId: release.reservationId,
        operationId: release.operationId,
        status: AuctionCancellationEffectStatus.Pending,
        lastError: null,
        updatedAt: input.cancelledAt,
      })),
      cancelledAt: input.cancelledAt,
      createdAt: input.cancelledAt,
      updatedAt: input.cancelledAt,
    }
    this.cancellations.set(input.auctionId, created)
    return created
  }

  getByAuctionId(auctionId: string): Promise<AuctionCancellationSnapshot | null> {
    return Promise.resolve(this.cancellations.get(auctionId) ?? null)
  }

  private update(
    auctionId: string,
    patch: Partial<
      Pick<
        AuctionCancellationSnapshot,
        | 'walletRefundStatus'
        | 'inventoryReleaseStatus'
        | 'walletRefundLastError'
        | 'inventoryReleaseLastError'
        | 'updatedAt'
      >
    >,
  ): void {
    const current = this.cancellations.get(auctionId)
    if (current === undefined) throw new Error(`No existe cancelacion durable para ${auctionId}.`)
    this.cancellations.set(auctionId, { ...current, ...patch })
    this.leaseUntil.delete(auctionId)
  }

  markWalletRefundConfirmed(auctionId: string, updatedAt: Date): Promise<void> {
    this.update(auctionId, {
      walletRefundStatus: AuctionCancellationEffectStatus.Confirmed,
      walletRefundLastError: null,
      updatedAt,
    })
    return Promise.resolve()
  }

  markWalletRefundRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    this.update(auctionId, {
      walletRefundStatus: AuctionCancellationEffectStatus.Retryable,
      walletRefundLastError: error,
      updatedAt,
    })
    return Promise.resolve()
  }

  markWalletRefundTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    this.update(auctionId, {
      walletRefundStatus: AuctionCancellationEffectStatus.TerminalError,
      walletRefundLastError: error,
      updatedAt,
    })
    return Promise.resolve()
  }

  markInventoryReleaseConfirmed(auctionId: string, updatedAt: Date): Promise<void> {
    this.update(auctionId, {
      inventoryReleaseStatus: AuctionCancellationEffectStatus.Confirmed,
      inventoryReleaseLastError: null,
      updatedAt,
    })
    return Promise.resolve()
  }

  markInventoryReleaseRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    this.update(auctionId, {
      inventoryReleaseStatus: AuctionCancellationEffectStatus.Retryable,
      inventoryReleaseLastError: error,
      updatedAt,
    })
    return Promise.resolve()
  }

  markInventoryReleaseTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    this.update(auctionId, {
      inventoryReleaseStatus: AuctionCancellationEffectStatus.TerminalError,
      inventoryReleaseLastError: error,
      updatedAt,
    })
    return Promise.resolve()
  }

  private updateReservationRelease(
    auctionId: string,
    reservationId: string,
    status: AuctionCancellationEffectStatus,
    lastError: string | null,
    updatedAt: Date,
  ): Promise<void> {
    const current = this.cancellations.get(auctionId)
    if (current === undefined) throw new Error(`No existe cancelacion durable para ${auctionId}.`)
    this.cancellations.set(auctionId, {
      ...current,
      reservationReleases: current.reservationReleases.map((release) =>
        release.reservationId === reservationId
          ? { ...release, status, lastError, updatedAt }
          : release,
      ),
      updatedAt,
    })
    this.leaseUntil.delete(auctionId)
    return Promise.resolve()
  }

  markReservationReleaseConfirmed(
    auctionId: string,
    reservationId: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.updateReservationRelease(
      auctionId,
      reservationId,
      AuctionCancellationEffectStatus.Confirmed,
      null,
      updatedAt,
    )
  }

  markReservationReleaseRetryable(
    auctionId: string,
    reservationId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.updateReservationRelease(
      auctionId,
      reservationId,
      AuctionCancellationEffectStatus.Retryable,
      error,
      updatedAt,
    )
  }

  markReservationReleaseTerminal(
    auctionId: string,
    reservationId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.updateReservationRelease(
      auctionId,
      reservationId,
      AuctionCancellationEffectStatus.TerminalError,
      error,
      updatedAt,
    )
  }

  claimPendingCancellations(
    input: ClaimPendingAuctionCancellationsInput,
  ): Promise<readonly AuctionCancellationSnapshot[]> {
    const candidates = Array.from(this.cancellations.values())
      .filter((cancellation) =>
        applicableCancellationEffectStatuses(cancellation).some(isPendingOrRetryable),
      )
      .filter((cancellation) => {
        const until = this.leaseUntil.get(cancellation.auctionId)
        return until === undefined || until.getTime() <= input.now.getTime()
      })
      .sort(
        (a, b) =>
          a.updatedAt.getTime() - b.updatedAt.getTime() || a.auctionId.localeCompare(b.auctionId),
      )
      .slice(0, input.limit)

    for (const candidate of candidates) this.leaseUntil.set(candidate.auctionId, input.leaseUntil)
    return Promise.resolve(candidates)
  }
}
