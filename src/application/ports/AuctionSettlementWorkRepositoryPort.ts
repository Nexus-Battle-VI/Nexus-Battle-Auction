import type { AuctionStatus } from '../../domain/entities/Auction'

export const AuctionSettlementWorkStatus = {
  Ready: 'READY',
  Leased: 'LEASED',
  Retryable: 'RETRYABLE',
  Completed: 'COMPLETED',
  Terminal: 'TERMINAL',
} as const

export type AuctionSettlementWorkStatus =
  (typeof AuctionSettlementWorkStatus)[keyof typeof AuctionSettlementWorkStatus]

export interface AuctionSettlementCandidate {
  readonly auctionId: string
  readonly status: AuctionStatus
  readonly closesAt: Date
}

export interface AuctionSettlementCandidateReaderPort {
  findSettlementCandidates(now: Date): Promise<readonly AuctionSettlementCandidate[]>
}

export interface AuctionSettlementWorkSnapshot {
  readonly auctionId: string
  readonly status: AuctionSettlementWorkStatus
  readonly availableAt: Date
  readonly leaseOwner: string | null
  readonly leaseUntil: Date | null
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly completedAt: Date | null
  readonly terminalAt: Date | null
}

export interface ClaimDueAuctionSettlementsInput {
  readonly now: Date
  readonly workerId: string
  readonly leaseUntil: Date
  readonly limit: number
}

export interface MarkAuctionSettlementWorkInput {
  readonly auctionId: string
  readonly workerId: string
  readonly now: Date
}

export interface MarkAuctionSettlementRetryableInput extends MarkAuctionSettlementWorkInput {
  readonly availableAt: Date
  readonly error: string
}

export interface MarkAuctionSettlementTerminalInput extends MarkAuctionSettlementWorkInput {
  readonly error: string
}

export interface AuctionSettlementWorkRepositoryPort {
  claimDue(
    input: ClaimDueAuctionSettlementsInput,
  ): Promise<readonly AuctionSettlementWorkSnapshot[]>
  markCompleted(input: MarkAuctionSettlementWorkInput): Promise<AuctionSettlementWorkSnapshot>
  markRetryable(input: MarkAuctionSettlementRetryableInput): Promise<AuctionSettlementWorkSnapshot>
  markTerminal(input: MarkAuctionSettlementTerminalInput): Promise<AuctionSettlementWorkSnapshot>
  getByAuctionId(auctionId: string): Promise<AuctionSettlementWorkSnapshot | null>
}

export const AUCTION_SETTLEMENT_WORK_REPOSITORY = Symbol('AuctionSettlementWorkRepositoryPort')
