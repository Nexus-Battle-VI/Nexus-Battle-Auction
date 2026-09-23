import type { Kysely, Selectable } from 'kysely'
import type {
  AuctionPendingClaimRepositoryPort,
  AuctionPendingClaimSnapshot,
  CreateAuctionPendingClaimInput,
} from '../../../application/ports/AuctionPendingClaimRepositoryPort'
import { AuctionPendingClaim, CLAIM_PERIOD_MS } from '../../../domain/entities/AuctionPendingClaim'
import {
  AuctionPendingClaimRuleCode,
  AuctionPendingClaimRuleViolation,
} from '../../../domain/errors/AuctionPendingClaimRuleViolation'
import type { Database } from './schema'

type Row = Selectable<Database['auction_pending_claims']>
const toSnapshot = (row: Row): AuctionPendingClaimSnapshot =>
  AuctionPendingClaim.restore({
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
  }).snapshot()
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
  async markClaimed(auctionId: string, claimedAt: Date): Promise<AuctionPendingClaimSnapshot> {
    const current = await this.findByAuctionId(auctionId)
    if (current === null) throw new Error(`No existe pending-claim para ${auctionId}.`)
    // Aplica la regla de dominio (estado + plazo vigente) antes de escribir;
    // el guard `claim_status = 'PENDING'` de abajo cubre la carrera entre esta
    // lectura y el UPDATE.
    const claimed = AuctionPendingClaim.restore(current).claim(claimedAt)
    const result = await this.db
      .updateTable('auction_pending_claims')
      .set({
        claim_status: claimed.claimStatus,
        claimed_at: claimed.claimedAt,
        updated_at: claimed.updatedAt,
      })
      .where('auction_id', '=', auctionId)
      .where('claim_status', '=', 'PENDING')
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n)
      throw new AuctionPendingClaimRuleViolation(
        AuctionPendingClaimRuleCode.AlreadyClaimed,
        'El producto ya fue reclamado.',
      )
    return claimed
  }
  async findExpirablePending(
    now: Date,
    limit: number,
  ): Promise<readonly AuctionPendingClaimSnapshot[]> {
    const cutoff = new Date(now.getTime() - CLAIM_PERIOD_MS)
    return (
      await this.db
        .selectFrom('auction_pending_claims')
        .selectAll()
        .where('claim_status', '=', 'PENDING')
        .where('settled_at', '<', cutoff)
        .orderBy('settled_at')
        .orderBy('auction_id')
        .limit(limit)
        .execute()
    ).map(toSnapshot)
  }
  async markExpired(auctionId: string, expiredAt: Date): Promise<AuctionPendingClaimSnapshot> {
    const current = await this.findByAuctionId(auctionId)
    if (current === null) throw new Error(`No existe pending-claim para ${auctionId}.`)
    // Aplica la regla de dominio (estado + plazo vencido) antes de escribir;
    // el guard `claim_status = 'PENDING'` de abajo cubre la carrera entre esta
    // lectura y el UPDATE.
    const expired = AuctionPendingClaim.restore(current).expire(expiredAt)
    return this.db.transaction().execute(async (transaction) => {
      const result = await transaction
        .updateTable('auction_pending_claims')
        .set({
          claim_status: expired.claimStatus,
          claimed_at: expired.claimedAt,
          updated_at: expired.updatedAt,
        })
        .where('auction_id', '=', auctionId)
        .where('claim_status', '=', 'PENDING')
        .executeTakeFirst()
      if (result.numUpdatedRows === 0n)
        throw new Error(
          `El pending-claim ${auctionId} ya no admite expiracion (cambio de estado concurrentemente).`,
        )
      // Trazabilidad del vencimiento (HU-69.6): mismo patron de auditoria que
      // ya usa completeSettlement para AUCTION_SETTLED, sin outbox_events
      // porque el issue no pide publicar un evento externo, solo historial.
      await transaction
        .insertInto('auction_audit_log')
        .values({
          auction_id: auctionId,
          operation_id: `auction:${auctionId}:pending-claim:expire`,
          action: 'AUCTION_PENDING_CLAIM_EXPIRED',
          actor_id: expired.winnerId,
          occurred_at: expiredAt,
          details: {
            auctionId,
            winnerId: expired.winnerId,
            productId: expired.productId,
            winningBidId: expired.winningBidId,
            finalAmountCredits: expired.finalAmountCredits,
            settledAt: expired.settledAt.toISOString(),
            claimDeadline: expired.claimDeadline.toISOString(),
          },
        })
        .execute()
      return expired
    })
  }
}
