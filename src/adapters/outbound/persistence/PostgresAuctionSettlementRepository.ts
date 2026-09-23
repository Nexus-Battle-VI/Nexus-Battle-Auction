import type { Kysely } from 'kysely'
import { type Selectable } from 'kysely'

import {
  AuctionSettlementStatus,
  CaptureStatus,
  ReleaseStatus,
  type AuctionSettlementReleaseSnapshot,
  type AuctionSettlementRepositoryPort,
  type AuctionSettlementSnapshot,
  type CreateAuctionSettlementInput,
  type CreateAuctionSettlementReleaseInput,
  type CompleteAuctionSettlementInput,
} from '../../../application/ports/AuctionSettlementRepositoryPort'
import type { Database } from './schema'

type SettlementRow = Selectable<Database['auction_settlements']>
type ReleaseRow = Selectable<Database['auction_settlement_releases']>

const toSettlement = (row: SettlementRow): AuctionSettlementSnapshot => ({
  auctionId: row.auction_id,
  status: row.status as AuctionSettlementStatus,
  resultType: row.result_type as AuctionSettlementSnapshot['resultType'],
  winningBidId: row.winning_bid_id,
  winnerId: row.winner_id,
  winningHoldId: row.winning_hold_id,
  sellerId: row.seller_id,
  finalAmountCredits: row.final_amount_credits === null ? null : Number(row.final_amount_credits),
  captureOperationId: row.capture_operation_id,
  captureStatus: row.capture_status as CaptureStatus,
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  settledAt: row.settled_at === null ? null : new Date(row.settled_at),
})

const toRelease = (row: ReleaseRow): AuctionSettlementReleaseSnapshot => ({
  auctionId: row.auction_id,
  bidId: row.bid_id,
  holdId: row.hold_id,
  operationId: row.operation_id,
  reason: row.reason as 'AUCTION_SETTLEMENT_LOST',
  status: row.status as ReleaseStatus,
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
})

export class PostgresAuctionSettlementRepository implements AuctionSettlementRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async getByAuctionId(auctionId: string): Promise<AuctionSettlementSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_settlements')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()
    return row === undefined ? null : toSettlement(row)
  }

  async createIfAbsent(input: CreateAuctionSettlementInput): Promise<AuctionSettlementSnapshot> {
    const withoutBids = input.resultType === 'WITHOUT_BIDS'
    await this.db
      .insertInto('auction_settlements')
      .values({
        auction_id: input.auctionId,
        status: withoutBids
          ? AuctionSettlementStatus.Pending
          : AuctionSettlementStatus.CapturePending,
        result_type: input.resultType,
        winning_bid_id: withoutBids ? null : input.winningBidId,
        winner_id: withoutBids ? null : input.winnerId,
        winning_hold_id: withoutBids ? null : input.winningHoldId,
        seller_id: input.sellerId,
        final_amount_credits: withoutBids ? null : input.finalAmountCredits,
        capture_operation_id: withoutBids ? null : input.captureOperationId,
        capture_status: withoutBids ? CaptureStatus.NotRequired : CaptureStatus.Pending,
        last_error: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
        settled_at: null,
      })
      .onConflict((conflict) => conflict.column('auction_id').doNothing())
      .execute()
    const settlement = await this.getByAuctionId(input.auctionId)
    if (settlement === null) throw new Error(`No se pudo crear settlement ${input.auctionId}.`)
    const sameIntent =
      settlement.resultType === input.resultType &&
      settlement.sellerId === input.sellerId &&
      (input.resultType === 'WITHOUT_BIDS'
        ? settlement.winningBidId === null &&
          settlement.winnerId === null &&
          settlement.winningHoldId === null &&
          settlement.finalAmountCredits === null &&
          settlement.captureOperationId === null
        : settlement.winningBidId === input.winningBidId &&
          settlement.winnerId === input.winnerId &&
          settlement.winningHoldId === input.winningHoldId &&
          settlement.finalAmountCredits === input.finalAmountCredits &&
          settlement.captureOperationId === input.captureOperationId)
    if (!sameIntent) throw new Error(`Conflicto de intent para settlement ${input.auctionId}.`)
    return settlement
  }

  markCaptureConfirmed(auctionId: string, updatedAt: Date): Promise<void> {
    return this.transitionCapture(
      auctionId,
      [CaptureStatus.Pending, CaptureStatus.Retryable],
      AuctionSettlementStatus.Captured,
      CaptureStatus.Confirmed,
      null,
      updatedAt,
    )
  }

  markCaptureRetryable(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    return this.transitionCapture(
      auctionId,
      [CaptureStatus.Pending],
      AuctionSettlementStatus.FailedRetryable,
      CaptureStatus.Retryable,
      error,
      updatedAt,
    )
  }

  markCaptureTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    return this.transitionCapture(
      auctionId,
      [CaptureStatus.Pending, CaptureStatus.Retryable],
      AuctionSettlementStatus.FailedTerminal,
      CaptureStatus.TerminalError,
      error,
      updatedAt,
    )
  }

  markLoserReleasesPending(auctionId: string, updatedAt: Date): Promise<void> {
    return this.transitionLoserReleases(
      auctionId,
      AuctionSettlementStatus.LoserReleasesPending,
      null,
      updatedAt,
    )
  }

  markLoserReleasesTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    return this.transitionLoserReleases(
      auctionId,
      AuctionSettlementStatus.FailedTerminal,
      error,
      updatedAt,
    )
  }

  async createReleaseIfAbsent(
    input: CreateAuctionSettlementReleaseInput,
  ): Promise<AuctionSettlementReleaseSnapshot> {
    await this.db
      .insertInto('auction_settlement_releases')
      .values({
        auction_id: input.auctionId,
        bid_id: input.bidId,
        hold_id: input.holdId,
        operation_id: input.operationId,
        reason: 'AUCTION_SETTLEMENT_LOST',
        status: ReleaseStatus.Pending,
        last_error: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()
    const row = await this.db
      .selectFrom('auction_settlement_releases')
      .selectAll()
      .where('auction_id', '=', input.auctionId)
      .where('bid_id', '=', input.bidId)
      .executeTakeFirst()
    if (row === undefined)
      throw new Error(`No se pudo crear release ${input.auctionId}:${input.bidId}.`)
    const release = toRelease(row)
    if (release.holdId !== input.holdId || release.operationId !== input.operationId) {
      throw new Error(`Conflicto de intent para release ${input.auctionId}:${input.bidId}.`)
    }
    return release
  }

  async listReleaseTasks(auctionId: string): Promise<readonly AuctionSettlementReleaseSnapshot[]> {
    return (
      await this.db
        .selectFrom('auction_settlement_releases')
        .selectAll()
        .where('auction_id', '=', auctionId)
        .orderBy('bid_id')
        .execute()
    ).map(toRelease)
  }

  async listPendingReleaseTasks(
    auctionId: string,
  ): Promise<readonly AuctionSettlementReleaseSnapshot[]> {
    return (
      await this.db
        .selectFrom('auction_settlement_releases')
        .selectAll()
        .where('auction_id', '=', auctionId)
        .where('status', 'in', [ReleaseStatus.Pending, ReleaseStatus.Retryable])
        .orderBy('bid_id')
        .execute()
    ).map(toRelease)
  }

  markReleaseConfirmed(auctionId: string, bidId: string, updatedAt: Date): Promise<void> {
    return this.transitionRelease(
      auctionId,
      bidId,
      [ReleaseStatus.Pending, ReleaseStatus.Retryable],
      ReleaseStatus.Released,
      null,
      updatedAt,
    )
  }

  markReleaseRetryable(
    auctionId: string,
    bidId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.transitionRelease(
      auctionId,
      bidId,
      [ReleaseStatus.Pending],
      ReleaseStatus.Retryable,
      error,
      updatedAt,
    )
  }

  markReleaseTerminal(
    auctionId: string,
    bidId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    return this.transitionRelease(
      auctionId,
      bidId,
      [ReleaseStatus.Pending, ReleaseStatus.Retryable],
      ReleaseStatus.TerminalError,
      error,
      updatedAt,
    )
  }

  async completeSettlement(
    input: CompleteAuctionSettlementInput,
  ): Promise<AuctionSettlementSnapshot> {
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('auction_settlements')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .forUpdate()
        .executeTakeFirst()
      if (row === undefined) throw new Error(`El settlement ${input.auctionId} no existe.`)
      const settlement = toSettlement(row)
      if (settlement.status === AuctionSettlementStatus.Completed) return settlement
      if (settlement.resultType !== input.resultType)
        throw new Error('Conflicto de resultado al completar settlement.')
      const releases = await transaction
        .selectFrom('auction_settlement_releases')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .execute()
      const ready =
        settlement.resultType === 'WITHOUT_BIDS'
          ? settlement.captureStatus === CaptureStatus.NotRequired
          : settlement.captureStatus === CaptureStatus.Confirmed
      if (
        !ready ||
        releases.some((release) => (release.status as ReleaseStatus) !== ReleaseStatus.Released)
      ) {
        throw new Error('El settlement aun tiene trabajo obligatorio pendiente.')
      }
      if (input.resultType === 'WITH_WINNER') {
        if (
          settlement.winnerId !== input.winnerId ||
          settlement.winningBidId !== input.winningBidId ||
          settlement.finalAmountCredits !== input.finalAmountCredits
        )
          throw new Error('Conflicto de intent para completion.')
        await transaction
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
            created_at: input.settledAt,
            updated_at: input.settledAt,
          })
          .onConflict((conflict) => conflict.column('auction_id').doNothing())
          .execute()
        const claim = await transaction
          .selectFrom('auction_pending_claims')
          .selectAll()
          .where('auction_id', '=', input.auctionId)
          .executeTakeFirstOrThrow()
        if (
          claim.winner_id !== input.winnerId ||
          claim.product_id !== input.productId ||
          claim.winning_bid_id !== input.winningBidId ||
          Number(claim.final_amount_credits) !== input.finalAmountCredits ||
          new Date(claim.settled_at).getTime() !== input.settledAt.getTime()
        )
          throw new Error(`Conflicto de intent para claim ${input.auctionId}.`)
      }
      await transaction
        .updateTable('auction_settlements')
        .set({
          status: AuctionSettlementStatus.Completed,
          updated_at: input.settledAt,
          settled_at: input.settledAt,
        })
        .where('auction_id', '=', input.auctionId)
        .execute()
      await transaction
        .insertInto('auction_audit_log')
        .values({
          auction_id: input.auctionId,
          operation_id: `auction:${input.auctionId}:settlement`,
          action: 'AUCTION_SETTLED',
          actor_id: input.resultType === 'WITH_WINNER' ? input.winnerId : settlement.sellerId,
          occurred_at: input.settledAt,
          details: input,
        })
        .execute()
      await transaction
        .insertInto('outbox_events')
        .values({
          id: `auction:${input.auctionId}:settled`,
          aggregate_id: input.auctionId,
          event_type: 'auction.settled.v1',
          payload: input,
          occurred_at: input.settledAt,
          published_at: null,
        })
        .execute()
      const completed = await transaction
        .selectFrom('auction_settlements')
        .selectAll()
        .where('auction_id', '=', input.auctionId)
        .executeTakeFirstOrThrow()
      return toSettlement(completed)
    })
  }
  async markCompleted(auctionId: string, updatedAt: Date): Promise<void> {
    const settlement = await this.getByAuctionId(auctionId)
    if (settlement === null) throw new Error(`El settlement ${auctionId} no existe.`)
    const releases = await this.listReleaseTasks(auctionId)
    const ready =
      settlement.resultType === 'WITHOUT_BIDS'
        ? settlement.captureStatus === CaptureStatus.NotRequired
        : settlement.captureStatus === CaptureStatus.Confirmed
    if (!ready || releases.some((release) => release.status !== ReleaseStatus.Released))
      throw new Error('El settlement aun tiene trabajo obligatorio pendiente.')
    await this.db
      .updateTable('auction_settlements')
      .set({ status: AuctionSettlementStatus.Completed, updated_at: updatedAt })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  private async transitionCapture(
    auctionId: string,
    allowed: readonly CaptureStatus[],
    status: AuctionSettlementStatus,
    captureStatus: CaptureStatus,
    lastError: string | null,
    updatedAt: Date,
  ): Promise<void> {
    const result = await this.db
      .updateTable('auction_settlements')
      .set({ status, capture_status: captureStatus, last_error: lastError, updated_at: updatedAt })
      .where('auction_id', '=', auctionId)
      .where('capture_status', 'in', allowed)
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n) throw new Error('La captura no admite esa transicion.')
  }

  private async transitionRelease(
    auctionId: string,
    bidId: string,
    allowed: readonly ReleaseStatus[],
    status: ReleaseStatus,
    lastError: string | null,
    updatedAt: Date,
  ): Promise<void> {
    const result = await this.db
      .updateTable('auction_settlement_releases')
      .set({ status, last_error: lastError, updated_at: updatedAt })
      .where('auction_id', '=', auctionId)
      .where('bid_id', '=', bidId)
      .where('status', 'in', allowed)
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n) throw new Error('El release no admite esa transicion.')
  }

  private async transitionLoserReleases(
    auctionId: string,
    status: AuctionSettlementStatus,
    lastError: string | null,
    updatedAt: Date,
  ): Promise<void> {
    const result = await this.db
      .updateTable('auction_settlements')
      .set({ status, last_error: lastError, updated_at: updatedAt })
      .where('auction_id', '=', auctionId)
      .where('capture_status', '=', CaptureStatus.Confirmed)
      .where('status', 'in', [
        AuctionSettlementStatus.Captured,
        AuctionSettlementStatus.LoserReleasesPending,
      ])
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n) throw new Error('El settlement no admite esa transicion.')
  }
}
