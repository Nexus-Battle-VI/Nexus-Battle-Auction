import type {
  AuctionWalletPort,
  CaptureAuctionHoldCommand,
  ReleaseAuctionHoldCommand,
  WalletHoldResult,
} from '../../../application/ports/AuctionWalletPort'

const unavailable = (operationId: string, holdId: string): WalletHoldResult => ({
  outcome: 'RETRYABLE',
  operationId,
  holdId,
})

export class UnavailableAuctionWalletClient implements AuctionWalletPort {
  captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> {
    return Promise.resolve(unavailable(command.operationId, command.holdId))
  }

  releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> {
    return Promise.resolve(unavailable(command.operationId, command.holdId))
  }
}
