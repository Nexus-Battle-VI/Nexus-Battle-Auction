export interface CaptureAuctionHoldCommand {
  holdId: string
  operationId: string
  beneficiaryPlayerId: string
  auctionId: string
  winningBidId: string
}
export interface ReleaseAuctionHoldCommand {
  holdId: string
  operationId: string
  reason: 'AUCTION_SETTLEMENT_LOST' | 'AUCTION_OUTBID'
}
export type WalletHoldOutcome =
  | 'SUCCESS'
  | 'TERMINAL_NOT_FOUND'
  | 'TERMINAL_CONFLICT'
  | 'TERMINAL_RULE_ERROR'
  | 'RETRYABLE'
  | 'INVALID_RESPONSE'
export interface WalletHoldResult {
  outcome: WalletHoldOutcome
  operationId: string
  holdId: string
  holdStatus?: string
  applied?: boolean
  beneficiaryPlayerId?: string
}
export interface AuctionWalletPort {
  captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult>
  releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult>
}

export const AUCTION_WALLET = Symbol('AuctionWalletPort')
