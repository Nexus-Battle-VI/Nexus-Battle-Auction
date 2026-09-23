import type { Kysely, Selectable } from 'kysely'
import type {
  AuctionPendingClaimRepositoryPort,
  AuctionPendingClaimSnapshot,
  CreateAuctionPendingClaimInput,
} from '../../../application/ports/AuctionPendingClaimRepositoryPort'
import type { Database } from './schema'

type Row = Selectable<Database['auction_pending_claims']>
const toSnapshot = (row: Row): AuctionPendingClaimSnapshot => ({
  auctionId: row.auction_id,
  winnerId: row.winner_id,
  productId: row.product_id,
  winningBidId: row.winning_bid_id,
  finalAmountCredits: Number(row.final_amount_credits),
  settledAt: new Date(row.settled_at),
  claimStatus: row.claim_status,
  claimedAt: row.claimed_at === null ? null : new Date(row.claimed_at),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
})
const same = (claim: AuctionPendingClaimSnapshot, input: CreateAuctionPendingClaimInput): boolean =>
  claim.winnerId === input.winnerId &&
  claim.productId === input.productId &&
  claim.winningBidId === input.winningBidId &&
  claim.finalAmountCredits === input.finalAmountCredits &&
  claim.settledAt.getTime() === input.settledAt.getTime()

export class PostgresAuctionPendingClaimRepository implements AuctionPendingClaimRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}
  async createIfAbsent(
    input: CreateAuctionPendingClaimInput,
  ): Promise<AuctionPendingClaimSnapshot> {
    await this.db
      .insertInto('auction_pending_claims')
      .values({
        auction_id: input.auctionId,
        winner_id: input.winnerId,
        product_id: input.productId,
        winning_bid_id: input.winningBidId,
        final_amount_credits: input.finalAmountCredits,
        settled_at: input.settledAt,
        claim_status: 'PENDING',
        claimed_at: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      })
      .onConflict((conflict) => conflict.column('auction_id').doNothing())
      .execute()
    const claim = await this.findByAuctionId(input.auctionId)
    if (claim === null) throw new Error(`No se pudo crear claim ${input.auctionId}.`)
    if (!same(claim, input)) throw new Error(`Conflicto de intent para claim ${input.auctionId}.`)
    return claim
  }
  async findByAuctionId(auctionId: string): Promise<AuctionPendingClaimSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_pending_claims')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()
    return row === undefined ? null : toSnapshot(row)
  }
  async findPendingByWinnerId(winnerId: string): Promise<readonly AuctionPendingClaimSnapshot[]> {
    return (
      await this.db
        .selectFrom('auction_pending_claims')
        .selectAll()
        .where('winner_id', '=', winnerId)
        .where('claim_status', '=', 'PENDING')
        .orderBy('settled_at', 'desc')
        .orderBy('auction_id')
        .execute()
    ).map(toSnapshot)
  }
}
