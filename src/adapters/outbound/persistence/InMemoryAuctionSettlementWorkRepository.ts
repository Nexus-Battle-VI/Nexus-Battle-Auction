import {
  AuctionSettlementStatus,
  type AuctionSettlementRepositoryPort,
} from '../../../application/ports/AuctionSettlementRepositoryPort'
import {
  AuctionSettlementWorkStatus,
  type AuctionSettlementCandidateReaderPort,
  type AuctionSettlementWorkRepositoryPort,
  type AuctionSettlementWorkSnapshot,
  type ClaimDueAuctionSettlementsInput,
  type MarkAuctionSettlementRetryableInput,
  type MarkAuctionSettlementTerminalInput,
  type MarkAuctionSettlementWorkInput,
} from '../../../application/ports/AuctionSettlementWorkRepositoryPort'
import { AuctionStatus } from '../../../domain/entities/Auction'

const retryableSettlementStatuses: readonly AuctionSettlementStatus[] = [
  AuctionSettlementStatus.Pending,
  AuctionSettlementStatus.CapturePending,
  AuctionSettlementStatus.Captured,
  AuctionSettlementStatus.LoserReleasesPending,
  AuctionSettlementStatus.FailedRetryable,
]

const clone = (work: AuctionSettlementWorkSnapshot): AuctionSettlementWorkSnapshot => ({
  ...work,
  availableAt: new Date(work.availableAt),
  leaseUntil: work.leaseUntil === null ? null : new Date(work.leaseUntil),
  createdAt: new Date(work.createdAt),
  updatedAt: new Date(work.updatedAt),
  completedAt: work.completedAt === null ? null : new Date(work.completedAt),
  terminalAt: work.terminalAt === null ? null : new Date(work.terminalAt),
})

export class InMemoryAuctionSettlementWorkRepository implements AuctionSettlementWorkRepositoryPort {
  private readonly work = new Map<string, AuctionSettlementWorkSnapshot>()

  private readonly closesAt = new Map<string, Date>()

  constructor(
    private readonly candidates: AuctionSettlementCandidateReaderPort,
    private readonly settlements: AuctionSettlementRepositoryPort,
  ) {}

  async claimDue(
    input: ClaimDueAuctionSettlementsInput,
  ): Promise<readonly AuctionSettlementWorkSnapshot[]> {
    await this.discover(input.now)

    return [...this.work.values()]
      .filter(
        (work) =>
          ((work.status === AuctionSettlementWorkStatus.Ready ||
            work.status === AuctionSettlementWorkStatus.Retryable) &&
            work.availableAt.getTime() <= input.now.getTime()) ||
          (work.status === AuctionSettlementWorkStatus.Leased &&
            work.leaseUntil !== null &&
            work.leaseUntil.getTime() <= input.now.getTime()),
      )
      .sort(
        (left, right) =>
          (this.closesAt.get(left.auctionId)?.getTime() ?? 0) -
            (this.closesAt.get(right.auctionId)?.getTime() ?? 0) ||
          left.auctionId.localeCompare(right.auctionId),
      )
      .slice(0, input.limit)
      .map((work) => {
        const leased: AuctionSettlementWorkSnapshot = {
          ...work,
          status: AuctionSettlementWorkStatus.Leased,
          leaseOwner: input.workerId,
          leaseUntil: new Date(input.leaseUntil),
          attempts: work.attempts + 1,
          lastError: null,
          updatedAt: new Date(input.now),
        }
        this.work.set(work.auctionId, leased)
        return clone(leased)
      })
  }

  markCompleted(input: MarkAuctionSettlementWorkInput): Promise<AuctionSettlementWorkSnapshot> {
    const current = this.work.get(input.auctionId)
    if (current?.status === AuctionSettlementWorkStatus.Completed) {
      return Promise.resolve(clone(current))
    }
    return this.updateOwnedLease(input, {
      status: AuctionSettlementWorkStatus.Completed,
      lastError: null,
      completedAt: input.now,
      terminalAt: null,
    })
  }

  markRetryable(
    input: MarkAuctionSettlementRetryableInput,
  ): Promise<AuctionSettlementWorkSnapshot> {
    return this.updateOwnedLease(input, {
      status: AuctionSettlementWorkStatus.Retryable,
      availableAt: input.availableAt,
      lastError: input.error,
      completedAt: null,
      terminalAt: null,
    })
  }

  markTerminal(input: MarkAuctionSettlementTerminalInput): Promise<AuctionSettlementWorkSnapshot> {
    return this.updateOwnedLease(input, {
      status: AuctionSettlementWorkStatus.Terminal,
      lastError: input.error,
      completedAt: null,
      terminalAt: input.now,
    })
  }

  getByAuctionId(auctionId: string): Promise<AuctionSettlementWorkSnapshot | null> {
    const work = this.work.get(auctionId)
    return Promise.resolve(work === undefined ? null : clone(work))
  }

  private async discover(now: Date): Promise<void> {
    const candidates = await this.candidates.findSettlementCandidates(now)

    for (const candidate of candidates) {
      if (this.work.has(candidate.auctionId)) continue

      if (candidate.status === AuctionStatus.Finished) {
        const settlement = await this.settlements.getByAuctionId(candidate.auctionId)
        if (settlement === null || !retryableSettlementStatuses.includes(settlement.status))
          continue
      }

      const created: AuctionSettlementWorkSnapshot = {
        auctionId: candidate.auctionId,
        status: AuctionSettlementWorkStatus.Ready,
        availableAt: new Date(now),
        leaseOwner: null,
        leaseUntil: null,
        attempts: 0,
        lastError: null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        completedAt: null,
        terminalAt: null,
      }
      this.closesAt.set(candidate.auctionId, new Date(candidate.closesAt))
      this.work.set(candidate.auctionId, created)
    }
  }

  private updateOwnedLease(
    input: MarkAuctionSettlementWorkInput,
    patch: Partial<AuctionSettlementWorkSnapshot>,
  ): Promise<AuctionSettlementWorkSnapshot> {
    const current = this.work.get(input.auctionId)
    if (
      current?.status !== AuctionSettlementWorkStatus.Leased ||
      current.leaseOwner !== input.workerId
    ) {
      return Promise.reject(
        new Error(
          `El trabajo de settlement ${input.auctionId} no esta arrendado por ${input.workerId}.`,
        ),
      )
    }

    const updated: AuctionSettlementWorkSnapshot = {
      ...current,
      ...patch,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(input.now),
    }
    this.work.set(input.auctionId, updated)
    return Promise.resolve(clone(updated))
  }
}
