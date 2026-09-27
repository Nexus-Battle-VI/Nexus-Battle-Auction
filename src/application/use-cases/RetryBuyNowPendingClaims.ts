import type { AuctionInventorySettlementIntentRepositoryPort } from '../ports/AuctionInventorySettlementIntentRepositoryPort'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { BuyNowPendingClaimRegistrationService } from '../services/BuyNowPendingClaimRegistrationService'

export interface RetryBuyNowPendingClaimsOptions {
  readonly batchSize: number
}
export interface RetryBuyNowPendingClaimsResult {
  claimed: number
  confirmed: number
  retryable: number
  terminal: number
  unexpectedErrors: number
}

/** HU-64: recupera solo intents vinculados a una compra inmediata durable. */
export class RetryBuyNowPendingClaims {
  constructor(
    private readonly intents: AuctionInventorySettlementIntentRepositoryPort,
    private readonly auctions: AuctionRepositoryPort,
    private readonly registration: BuyNowPendingClaimRegistrationService,
    private readonly options: RetryBuyNowPendingClaimsOptions,
  ) {}

  async runBatch(): Promise<RetryBuyNowPendingClaimsResult> {
    const result: RetryBuyNowPendingClaimsResult = {
      claimed: 0,
      confirmed: 0,
      retryable: 0,
      terminal: 0,
      unexpectedErrors: 0,
    }
    for (const intent of await this.intents.findRetryablePendingClaims(this.options.batchSize)) {
      const operation = await this.auctions.findBuyNowOperationByAuctionId(intent.auctionId)
      if (operation === null) continue // HU-65: no hay evidencia durable de buy-now.
      result.claimed += 1
      try {
        const resolved = await this.registration.retryClaim(intent, operation)
        if (resolved.status === 'CONFIRMED') result.confirmed += 1
        else if (resolved.status === 'RETRYABLE') result.retryable += 1
        else if (resolved.status === 'TERMINAL_ERROR') result.terminal += 1
      } catch {
        result.unexpectedErrors += 1
      }
    }
    return result
  }
}
