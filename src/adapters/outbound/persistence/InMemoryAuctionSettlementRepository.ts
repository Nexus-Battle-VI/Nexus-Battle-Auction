import {
  AuctionSettlementStatus,
  CaptureStatus,
  ReleaseStatus,
  type AuctionSettlementReleaseSnapshot,
  type AuctionSettlementRepositoryPort,
  type AuctionSettlementSnapshot,
  type CreateAuctionSettlementInput,
  type CreateAuctionSettlementReleaseInput,
  type CompleteAuctionSettlementInput,
} from '../../../application/ports/AuctionSettlementRepositoryPort'
import { InMemoryAuctionPendingClaimRepository } from './InMemoryAuctionPendingClaimRepository'

const cloneSettlement = (snapshot: AuctionSettlementSnapshot): AuctionSettlementSnapshot => ({
  ...snapshot,
  createdAt: new Date(snapshot.createdAt),
  updatedAt: new Date(snapshot.updatedAt),
  settledAt: snapshot.settledAt === null ? null : new Date(snapshot.settledAt),
})

const cloneRelease = (
  snapshot: AuctionSettlementReleaseSnapshot,
): AuctionSettlementReleaseSnapshot => ({
  ...snapshot,
  createdAt: new Date(snapshot.createdAt),
  updatedAt: new Date(snapshot.updatedAt),
})

export class InMemoryAuctionSettlementRepository implements AuctionSettlementRepositoryPort {
  private readonly settlements = new Map<string, AuctionSettlementSnapshot>()
  private readonly releases = new Map<string, AuctionSettlementReleaseSnapshot>()

  constructor(readonly pendingClaims = new InMemoryAuctionPendingClaimRepository()) {}

  getByAuctionId(auctionId: string): Promise<AuctionSettlementSnapshot | null> {
    const settlement = this.settlements.get(auctionId)
    return Promise.resolve(settlement === undefined ? null : cloneSettlement(settlement))
  }

  createIfAbsent(input: CreateAuctionSettlementInput): Promise<AuctionSettlementSnapshot> {
    const existing = this.settlements.get(input.auctionId)
    if (existing !== undefined) return Promise.resolve(cloneSettlement(existing))

    const withoutBids = input.resultType === 'WITHOUT_BIDS'
    const snapshot: AuctionSettlementSnapshot = {
      auctionId: input.auctionId,
      status: withoutBids
        ? AuctionSettlementStatus.Pending
        : AuctionSettlementStatus.CapturePending,
      resultType: input.resultType,
      winningBidId: withoutBids ? null : input.winningBidId,
      winnerId: withoutBids ? null : input.winnerId,
      winningHoldId: withoutBids ? null : input.winningHoldId,
      sellerId: input.sellerId,
      finalAmountCredits: withoutBids ? null : input.finalAmountCredits,
      captureOperationId: withoutBids ? null : input.captureOperationId,
      captureStatus: withoutBids ? CaptureStatus.NotRequired : CaptureStatus.Pending,
      lastError: null,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      settledAt: null,
    }
    this.settlements.set(snapshot.auctionId, snapshot)
    return Promise.resolve(cloneSettlement(snapshot))
  }

  markCaptureConfirmed(auctionId: string, updatedAt: Date): Promise<void> {
    const settlement = this.requireSettlement(auctionId)
    if (![CaptureStatus.Pending, CaptureStatus.Retryable].includes(settlement.captureStatus)) {
      return Promise.reject(new Error('La captura no admite confirmacion en su estado actual.'))
    }
    this.settlements.set(auctionId, {
      ...settlement,
      status: AuctionSettlementStatus.Captured,
      captureStatus: CaptureStatus.Confirmed,
      lastError: null,
      updatedAt: new Date(updatedAt),
    })
    return Promise.resolve()
  }

  markCaptureRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    const settlement = this.requireSettlement(auctionId)
    if (settlement.captureStatus !== CaptureStatus.Pending) {
      return Promise.reject(new Error('La captura no admite reintento en su estado actual.'))
    }
    this.settlements.set(auctionId, {
      ...settlement,
      status: AuctionSettlementStatus.FailedRetryable,
      captureStatus: CaptureStatus.Retryable,
      lastError: error,
      updatedAt: new Date(updatedAt),
    })
    return Promise.resolve()
  }

  markCaptureTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    const settlement = this.requireSettlement(auctionId)
    if (![CaptureStatus.Pending, CaptureStatus.Retryable].includes(settlement.captureStatus)) {
      return Promise.reject(new Error('La captura no admite error terminal en su estado actual.'))
    }
    this.settlements.set(auctionId, {
      ...settlement,
      status: AuctionSettlementStatus.FailedTerminal,
      captureStatus: CaptureStatus.TerminalError,
      lastError: error,
      updatedAt: new Date(updatedAt),
    })
    return Promise.resolve()
  }

  markLoserReleasesPending(auctionId: string, updatedAt: Date): Promise<void> {
    const settlement = this.requireSettlement(auctionId)
    if (settlement.captureStatus !== CaptureStatus.Confirmed) {
      return Promise.reject(new Error('Los releases requieren una captura confirmada.'))
    }
    this.settlements.set(auctionId, {
      ...settlement,
      status: AuctionSettlementStatus.LoserReleasesPending,
      updatedAt: new Date(updatedAt),
    })
    return Promise.resolve()
  }

  markLoserReleasesTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    const settlement = this.requireSettlement(auctionId)
    if (settlement.captureStatus !== CaptureStatus.Confirmed) {
      return Promise.reject(new Error('Los releases requieren una captura confirmada.'))
    }
    this.settlements.set(auctionId, {
      ...settlement,
      status: AuctionSettlementStatus.FailedTerminal,
      lastError: error,
      updatedAt: new Date(updatedAt),
    })
    return Promise.resolve()
  }

  createReleaseIfAbsent(
    input: CreateAuctionSettlementReleaseInput,
  ): Promise<AuctionSettlementReleaseSnapshot> {
    const key = `${input.auctionId}:${input.bidId}`
    const existing = this.releases.get(key)
    if (existing !== undefined) return Promise.resolve(cloneRelease(existing))
    const snapshot: AuctionSettlementReleaseSnapshot = {
      ...input,
      reason: 'AUCTION_SETTLEMENT_LOST',
      status: ReleaseStatus.Pending,
      lastError: null,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
    }
    this.releases.set(key, snapshot)
    return Promise.resolve(cloneRelease(snapshot))
  }

  listReleaseTasks(auctionId: string): Promise<readonly AuctionSettlementReleaseSnapshot[]> {
    return Promise.resolve(
      [...this.releases.values()]
        .filter((release) => release.auctionId === auctionId)
        .map(cloneRelease),
    )
  }

  listPendingReleaseTasks(auctionId: string): Promise<readonly AuctionSettlementReleaseSnapshot[]> {
    return Promise.resolve(
      [...this.releases.values()]
        .filter(
          (release) =>
            release.auctionId === auctionId &&
            [ReleaseStatus.Pending, ReleaseStatus.Retryable].includes(release.status),
        )
        .map(cloneRelease),
    )
  }

  markReleaseConfirmed(auctionId: string, bidId: string, updatedAt: Date): Promise<void> {
    return this.updateRelease(auctionId, bidId, [ReleaseStatus.Pending, ReleaseStatus.Retryable], {
      status: ReleaseStatus.Released,
      lastError: null,
      updatedAt,
    })
  }

  markReleaseRetryable(
    auctionId: string,
    bidId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.updateRelease(auctionId, bidId, [ReleaseStatus.Pending], {
      status: ReleaseStatus.Retryable,
      lastError: error,
      updatedAt,
    })
  }

  markReleaseTerminal(
    auctionId: string,
    bidId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.updateRelease(auctionId, bidId, [ReleaseStatus.Pending, ReleaseStatus.Retryable], {
      status: ReleaseStatus.TerminalError,
      lastError: error,
      updatedAt,
    })
  }

  async completeSettlement(
    input: CompleteAuctionSettlementInput,
  ): Promise<AuctionSettlementSnapshot> {
    const auctionId = input.auctionId
    const settlement = this.requireSettlement(auctionId)
    if (settlement.status === AuctionSettlementStatus.Completed) return cloneSettlement(settlement)
    const releases = await this.listReleaseTasks(auctionId)
    const capturesReady =
      settlement.resultType === 'WITHOUT_BIDS'
        ? settlement.captureStatus === CaptureStatus.NotRequired
        : settlement.captureStatus === CaptureStatus.Confirmed
    if (!capturesReady || releases.some((release) => release.status !== ReleaseStatus.Released)) {
      throw new Error('El settlement aun tiene trabajo obligatorio pendiente.')
    }
    if (input.resultType === 'WITH_WINNER') {
      await this.pendingClaims.createIfAbsent({
        auctionId,
        winnerId: input.winnerId,
        productId: input.productId,
        winningBidId: input.winningBidId,
        finalAmountCredits: input.finalAmountCredits,
        settledAt: input.settledAt,
        createdAt: input.settledAt,
      })
    }
    const completed = {
      ...settlement,
      status: AuctionSettlementStatus.Completed,
      updatedAt: new Date(input.settledAt),
      settledAt: new Date(input.settledAt),
    }
    this.settlements.set(auctionId, completed)
    return cloneSettlement(completed)
  }
  async markCompleted(auctionId: string, updatedAt: Date): Promise<void> {
    const settlement = this.requireSettlement(auctionId)
    const releases = await this.listReleaseTasks(auctionId)
    if (
      (settlement.captureStatus !== CaptureStatus.NotRequired &&
        settlement.captureStatus !== CaptureStatus.Confirmed) ||
      releases.some((release) => release.status !== ReleaseStatus.Released)
    )
      throw new Error('El settlement aun tiene trabajo obligatorio pendiente.')
    this.settlements.set(auctionId, {
      ...settlement,
      status: AuctionSettlementStatus.Completed,
      updatedAt: new Date(updatedAt),
    })
  }

  private requireSettlement(auctionId: string): AuctionSettlementSnapshot {
    const settlement = this.settlements.get(auctionId)
    if (settlement === undefined) throw new Error(`El settlement ${auctionId} no existe.`)
    return settlement
  }

  private updateRelease(
    auctionId: string,
    bidId: string,
    allowed: readonly ReleaseStatus[],
    patch: Pick<AuctionSettlementReleaseSnapshot, 'status' | 'lastError'> & { updatedAt: Date },
  ): Promise<void> {
    const key = `${auctionId}:${bidId}`
    const release = this.releases.get(key)
    if (release === undefined) return Promise.reject(new Error(`El release ${key} no existe.`))
    if (!allowed.includes(release.status))
      return Promise.reject(new Error('El release no admite esa transicion.'))
    this.releases.set(key, { ...release, ...patch, updatedAt: new Date(patch.updatedAt) })
    return Promise.resolve()
  }
}
