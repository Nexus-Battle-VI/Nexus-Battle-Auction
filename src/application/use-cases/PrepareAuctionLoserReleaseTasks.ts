import type { AuctionSettlementRepositoryPort } from '../ports/AuctionSettlementRepositoryPort'
import type { LoserCreditReleaseAction } from './ClassifyAuctionLoserCredits'

export class PrepareAuctionLoserReleaseTasks {
  constructor(private readonly settlements: AuctionSettlementRepositoryPort) {}

  async execute(actions: readonly LoserCreditReleaseAction[], createdAt: Date): Promise<void> {
    const releasable = actions.filter(
      (
        action,
      ): action is LoserCreditReleaseAction & { holdId: string; releaseOperationId: string } =>
        action.holdId !== null && action.releaseOperationId !== null,
    )
    await Promise.all(
      releasable.map((action) =>
        this.settlements.createReleaseIfAbsent({
          auctionId: action.auctionId,
          bidId: action.bidId,
          holdId: action.holdId,
          operationId: action.releaseOperationId,
          createdAt,
        }),
      ),
    )
  }
}
