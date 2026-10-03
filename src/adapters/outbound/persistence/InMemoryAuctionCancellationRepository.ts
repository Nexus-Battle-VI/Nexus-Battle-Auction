import type {
  AuctionCancellationRepositoryPort,
  AuctionCancellationSnapshot,
  ClaimPendingAuctionCancellationsInput,
  CreateAuctionCancellationInput,
} from '../../../application/ports/AuctionCancellationRepositoryPort'
import { AuctionCancellationEffectStatus } from '../../../application/ports/AuctionCancellationRepositoryPort'

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

  claimPendingCancellations(
    input: ClaimPendingAuctionCancellationsInput,
  ): Promise<readonly AuctionCancellationSnapshot[]> {
    const candidates = Array.from(this.cancellations.values())
      .filter(
        (cancellation) =>
          isPendingOrRetryable(cancellation.walletRefundStatus) ||
          isPendingOrRetryable(cancellation.inventoryReleaseStatus),
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
