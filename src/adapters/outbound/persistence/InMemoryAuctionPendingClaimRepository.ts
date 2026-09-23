import type {
  AuctionPendingClaimRepositoryPort,
  AuctionPendingClaimSnapshot,
  CreateAuctionPendingClaimInput,
} from '../../../application/ports/AuctionPendingClaimRepositoryPort'
import { AuctionPendingClaim } from '../../../domain/entities/AuctionPendingClaim'

const clone = (claim: AuctionPendingClaimSnapshot): AuctionPendingClaimSnapshot => ({
  ...claim,
  settledAt: new Date(claim.settledAt),
  claimDeadline: new Date(claim.claimDeadline),
  claimedAt: claim.claimedAt === null ? null : new Date(claim.claimedAt),
  createdAt: new Date(claim.createdAt),
  updatedAt: new Date(claim.updatedAt),
})
const same = (claim: AuctionPendingClaimSnapshot, input: CreateAuctionPendingClaimInput): boolean =>
  claim.winnerId === input.winnerId &&
  claim.productId === input.productId &&
  claim.winningBidId === input.winningBidId &&
  claim.finalAmountCredits === input.finalAmountCredits &&
  claim.settledAt.getTime() === input.settledAt.getTime()
export class InMemoryAuctionPendingClaimRepository implements AuctionPendingClaimRepositoryPort {
  private readonly claims = new Map<string, AuctionPendingClaimSnapshot>()
  createIfAbsent(input: CreateAuctionPendingClaimInput): Promise<AuctionPendingClaimSnapshot> {
    const existing = this.claims.get(input.auctionId)
    if (existing !== undefined) {
      if (!same(existing, input))
        return Promise.reject(new Error(`Conflicto de intent para claim ${input.auctionId}.`))
      return Promise.resolve(clone(existing))
    }
    const claim = AuctionPendingClaim.create(input).snapshot()
    this.claims.set(input.auctionId, claim)
    return Promise.resolve(clone(claim))
  }
  findByAuctionId(auctionId: string): Promise<AuctionPendingClaimSnapshot | null> {
    const claim = this.claims.get(auctionId)
    return Promise.resolve(claim === undefined ? null : clone(claim))
  }
  findPendingByWinnerId(winnerId: string): Promise<readonly AuctionPendingClaimSnapshot[]> {
    return Promise.resolve(
      [...this.claims.values()]
        .filter((claim) => claim.winnerId === winnerId && claim.claimStatus === 'PENDING')
        .sort(
          (a, b) =>
            b.settledAt.getTime() - a.settledAt.getTime() || a.auctionId.localeCompare(b.auctionId),
        )
        .map(clone),
    )
  }
}
