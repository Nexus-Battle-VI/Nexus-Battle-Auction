import type { Kysely, Selectable } from 'kysely'

import type {
  AuctionCancellationRepositoryPort,
  AuctionCancellationSnapshot,
  ClaimPendingAuctionCancellationsInput,
} from '../../../application/ports/AuctionCancellationRepositoryPort'
import { AuctionCancellationEffectStatus } from '../../../application/ports/AuctionCancellationRepositoryPort'
import type { Database } from './schema'

type AuctionCancellationRow = Selectable<Database['auction_cancellations']>

const toSnapshot = (row: AuctionCancellationRow): AuctionCancellationSnapshot => ({
  auctionId: row.auction_id,
  operationId: row.operation_id,
  sellerId: row.seller_id,
  productId: row.product_id,
  inventoryCommitmentId: row.inventory_commitment_id,
  feeChargeId: row.fee_charge_id,
  refundAmountCredits: Number(row.refund_amount_credits),
  walletRefundOperationId: row.wallet_refund_operation_id,
  walletRefundStatus: row.wallet_refund_status as AuctionCancellationEffectStatus,
  inventoryReleaseOperationId: row.inventory_release_operation_id,
  inventoryReleaseStatus: row.inventory_release_status as AuctionCancellationEffectStatus,
  walletRefundLastError: row.wallet_refund_last_error,
  inventoryReleaseLastError: row.inventory_release_last_error,
  cancelledAt: new Date(row.cancelled_at),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
})

export class PostgresAuctionCancellationRepository implements AuctionCancellationRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async getByAuctionId(auctionId: string): Promise<AuctionCancellationSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_cancellations')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()

    return row === undefined ? null : toSnapshot(row)
  }

  async markWalletRefundConfirmed(auctionId: string, updatedAt: Date): Promise<void> {
    await this.db
      .updateTable('auction_cancellations')
      .set({
        wallet_refund_status: AuctionCancellationEffectStatus.Confirmed,
        wallet_refund_last_error: null,
        updated_at: updatedAt,
        ...releasedLease,
      })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  async markWalletRefundRetryable(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.db
      .updateTable('auction_cancellations')
      .set({
        wallet_refund_status: AuctionCancellationEffectStatus.Retryable,
        wallet_refund_last_error: error,
        updated_at: updatedAt,
        ...releasedLease,
      })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  async markWalletRefundTerminal(auctionId: string, error: string, updatedAt: Date): Promise<void> {
    await this.db
      .updateTable('auction_cancellations')
      .set({
        wallet_refund_status: AuctionCancellationEffectStatus.TerminalError,
        wallet_refund_last_error: error,
        updated_at: updatedAt,
        ...releasedLease,
      })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  async markInventoryReleaseConfirmed(auctionId: string, updatedAt: Date): Promise<void> {
    await this.db
      .updateTable('auction_cancellations')
      .set({
        inventory_release_status: AuctionCancellationEffectStatus.Confirmed,
        inventory_release_last_error: null,
        updated_at: updatedAt,
        ...releasedLease,
      })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  async markInventoryReleaseRetryable(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.db
      .updateTable('auction_cancellations')
      .set({
        inventory_release_status: AuctionCancellationEffectStatus.Retryable,
        inventory_release_last_error: error,
        updated_at: updatedAt,
        ...releasedLease,
      })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  async markInventoryReleaseTerminal(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.db
      .updateTable('auction_cancellations')
      .set({
        inventory_release_status: AuctionCancellationEffectStatus.TerminalError,
        inventory_release_last_error: error,
        updated_at: updatedAt,
        ...releasedLease,
      })
      .where('auction_id', '=', auctionId)
      .execute()
  }

  /**
   * `FOR UPDATE SKIP LOCKED` + lease corto, mismo patron que
   * `PostgresAuctionSettlementWorkRepository.claimDue`: reclama sin
   * mantener la transaccion abierta durante las llamadas HTTP a
   * Wallet/Inventory que ocurren despues, fuera de esta funcion.
   * `TERMINAL_ERROR` nunca entra en el filtro -no es candidato automatico-.
   */
  async claimPendingCancellations(
    input: ClaimPendingAuctionCancellationsInput,
  ): Promise<readonly AuctionCancellationSnapshot[]> {
    return this.db.transaction().execute(async (transaction) => {
      const candidates = await transaction
        .selectFrom('auction_cancellations')
        .selectAll()
        .where((expression) =>
          expression.or([
            expression('wallet_refund_status', 'in', [
              AuctionCancellationEffectStatus.Pending,
              AuctionCancellationEffectStatus.Retryable,
            ]),
            expression('inventory_release_status', 'in', [
              AuctionCancellationEffectStatus.Pending,
              AuctionCancellationEffectStatus.Retryable,
            ]),
          ]),
        )
        .where((expression) =>
          expression.or([
            expression('lease_until', 'is', null),
            expression('lease_until', '<=', input.now),
          ]),
        )
        .orderBy('updated_at', 'asc')
        .orderBy('auction_id', 'asc')
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute()

      if (candidates.length === 0) return []

      const auctionIds = candidates.map((candidate) => candidate.auction_id)
      await transaction
        .updateTable('auction_cancellations')
        .set({ lease_owner: input.workerId, lease_until: input.leaseUntil })
        .where('auction_id', 'in', auctionIds)
        .execute()

      return candidates.map((candidate) =>
        toSnapshot({ ...candidate, lease_owner: input.workerId, lease_until: input.leaseUntil }),
      )
    })
  }
}

const releasedLease = { lease_owner: null, lease_until: null }
