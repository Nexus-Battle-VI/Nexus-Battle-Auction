export interface BidCreditBalance {
  readonly availableCredits: number
}

export interface ReserveBidCreditsCommand {
  readonly operationId: string
  readonly bidderId: string
  readonly bidId: string
  readonly auctionId: string
  readonly amount: number
  readonly expiresAt: Date
}

export interface BidCreditReservation {
  readonly reservationId: string
}

export interface BidCreditsPort {
  getAvailableCredits(bidderId: string): Promise<BidCreditBalance>

  reserve(command: ReserveBidCreditsCommand): Promise<BidCreditReservation>

  release(operationId: string, reservationId: string): Promise<void>
}

export const BID_CREDITS = Symbol('BidCreditsPort')
