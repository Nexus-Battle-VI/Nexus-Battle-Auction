import { BidderId, BidId } from '../value-objects/BidIdentifiers'
import { Credits } from '../value-objects/Credits'

export enum AuctionClosingOutcome {
  WithWinner = 'WITH_WINNER',
  WithoutBids = 'WITHOUT_BIDS',
}

export interface AuctionClosingResultSnapshot {
  readonly outcome: AuctionClosingOutcome
  readonly finishedAt: Date
  readonly winnerId: string | null
  readonly winningBidId: string | null
  readonly finalAmountCredits: number | null
}

export class AuctionClosingResult {
  private constructor(
    readonly outcome: AuctionClosingOutcome,
    readonly finishedAt: Date,
    readonly winnerId: BidderId | null,
    readonly winningBidId: BidId | null,
    readonly finalAmount: Credits | null,
  ) {}

  static withWinner(input: {
    readonly finishedAt: Date
    readonly bidderId: string
    readonly bidId: string
    readonly amountCredits: number
  }): AuctionClosingResult {
    return new AuctionClosingResult(
      AuctionClosingOutcome.WithWinner,
      new Date(input.finishedAt),
      BidderId.create(input.bidderId),
      BidId.create(input.bidId),
      Credits.positive(input.amountCredits, 'importe final'),
    )
  }

  static withoutBids(finishedAt: Date): AuctionClosingResult {
    return new AuctionClosingResult(
      AuctionClosingOutcome.WithoutBids,
      new Date(finishedAt),
      null,
      null,
      null,
    )
  }

  snapshot(): AuctionClosingResultSnapshot {
    return {
      outcome: this.outcome,
      finishedAt: new Date(this.finishedAt),
      winnerId: this.winnerId?.value ?? null,
      winningBidId: this.winningBidId?.value ?? null,
      finalAmountCredits: this.finalAmount?.value ?? null,
    }
  }
}
