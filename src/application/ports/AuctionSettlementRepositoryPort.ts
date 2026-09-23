export enum AuctionSettlementStatus {
  Pending = 'PENDING',
  CapturePending = 'CAPTURE_PENDING',
  Captured = 'CAPTURED',
  LoserReleasesPending = 'LOSER_RELEASES_PENDING',
  Completed = 'COMPLETED',
  FailedRetryable = 'FAILED_RETRYABLE',
  FailedTerminal = 'FAILED_TERMINAL',
}

export enum CaptureStatus {
  NotRequired = 'NOT_REQUIRED',
  Pending = 'PENDING',
  Confirmed = 'CONFIRMED',
  Retryable = 'RETRYABLE',
  TerminalError = 'TERMINAL_ERROR',
}

export enum ReleaseStatus {
  Pending = 'PENDING',
  Released = 'RELEASED',
  Retryable = 'RETRYABLE',
  TerminalError = 'TERMINAL_ERROR',
}

export interface AuctionSettlementSnapshot {
  readonly auctionId: string
  readonly status: AuctionSettlementStatus
  readonly resultType: 'WITH_WINNER' | 'WITHOUT_BIDS'
  readonly winningBidId: string | null
  readonly winnerId: string | null
  readonly winningHoldId: string | null
  readonly sellerId: string
  readonly finalAmountCredits: number | null
  readonly captureOperationId: string | null
  readonly captureStatus: CaptureStatus
  readonly lastError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly settledAt: Date | null
}
export type CompleteAuctionSettlementInput =
  | {
      readonly auctionId: string
      readonly productId: string
      readonly settledAt: Date
      readonly resultType: 'WITHOUT_BIDS'
    }
  | {
      readonly auctionId: string
      readonly productId: string
      readonly settledAt: Date
      readonly resultType: 'WITH_WINNER'
      readonly winnerId: string
      readonly winningBidId: string
      readonly finalAmountCredits: number
    }

export interface AuctionSettlementReleaseSnapshot {
  readonly auctionId: string
  readonly bidId: string
  readonly holdId: string
  readonly operationId: string
  readonly reason: 'AUCTION_SETTLEMENT_LOST'
  readonly status: ReleaseStatus
  readonly lastError: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type CreateAuctionSettlementInput =
  | {
      readonly auctionId: string
      readonly resultType: 'WITHOUT_BIDS'
      readonly sellerId: string
      readonly createdAt: Date
      readonly winningBidId?: never
      readonly winnerId?: never
      readonly winningHoldId?: never
      readonly finalAmountCredits?: never
      readonly captureOperationId?: never
    }
  | {
      readonly auctionId: string
      readonly resultType: 'WITH_WINNER'
      readonly sellerId: string
      readonly winningBidId: string
      readonly winnerId: string
      readonly winningHoldId: string
      readonly finalAmountCredits: number
      readonly captureOperationId: string
      readonly createdAt: Date
    }

export interface CreateAuctionSettlementReleaseInput {
  readonly auctionId: string
  readonly bidId: string
  readonly holdId: string
  readonly operationId: string
  readonly createdAt: Date
}

export interface AuctionSettlementRepositoryPort {
  getByAuctionId(auctionId: string): Promise<AuctionSettlementSnapshot | null>
  createIfAbsent(input: CreateAuctionSettlementInput): Promise<AuctionSettlementSnapshot>
  markCaptureConfirmed(auctionId: string, updatedAt: Date): Promise<void>
  markCaptureRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void>
  markCaptureTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void>
  markLoserReleasesPending(auctionId: string, updatedAt: Date): Promise<void>
  markLoserReleasesTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void>
  createReleaseIfAbsent(
    input: CreateAuctionSettlementReleaseInput,
  ): Promise<AuctionSettlementReleaseSnapshot>
  listReleaseTasks(auctionId: string): Promise<readonly AuctionSettlementReleaseSnapshot[]>
  listPendingReleaseTasks(auctionId: string): Promise<readonly AuctionSettlementReleaseSnapshot[]>
  markReleaseConfirmed(auctionId: string, bidId: string, updatedAt: Date): Promise<void>
  markReleaseRetryable(
    auctionId: string,
    bidId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void>
  markReleaseTerminal(
    auctionId: string,
    bidId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void>
  completeSettlement(input: CompleteAuctionSettlementInput): Promise<AuctionSettlementSnapshot>
  markCompleted(auctionId: string, updatedAt: Date): Promise<void>
}

export const AUCTION_SETTLEMENT_REPOSITORY = Symbol('AuctionSettlementRepositoryPort')
