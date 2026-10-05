import type { Kysely, Selectable } from 'kysely'

import type {
  AuctionCancellationRepositoryPort,
  AuctionCancellationReservationReleaseSnapshot,
  AuctionCancellationSnapshot,
  ClaimPendingAuctionCancellationsInput,
} from '../../../application/ports/AuctionCancellationRepositoryPort'
import { AuctionCancellationEffectStatus } from '../../../application/ports/AuctionCancellationRepositoryPort'
import type { Database } from './schema'

type AuctionCancellationRow = Selectable<Database['auction_cancellations']>
type ReservationReleaseRow = Selectable<Database['auction_cancellation_reservation_releases']>

const toReservationRelease = (
  row: ReservationReleaseRow,
): AuctionCancellationReservationReleaseSnapshot => ({
  reservationId: row.reservation_id,
  operationId: row.operation_id,
  status: row.status as AuctionCancellationEffectStatus,
  lastError: row.last_error,
  updatedAt: new Date(row.updated_at),
})

const toSnapshot = (
  row: AuctionCancellationRow,
  releases: readonly ReservationReleaseRow[],
): AuctionCancellationSnapshot => ({
  auctionId: row.auction_id,
  operationId: row.operation_id,
  origin: row.origin,
  triggerReferenceId: row.trigger_reference_id,
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
  reservationReleases: releases.map(toReservationRelease),
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
    if (row === undefined) return null

    const releases = await this.db
      .selectFrom('auction_cancellation_reservation_releases')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .orderBy('reservation_id', 'asc')
      .execute()

    return toSnapshot(row, releases)
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

  async markReservationReleaseConfirmed(
    auctionId: string,
    reservationId: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.markReservationRelease(
      auctionId,
      reservationId,
      AuctionCancellationEffectStatus.Confirmed,
      null,
      updatedAt,
    )
  }

  async markReservationReleaseRetryable(
    auctionId: string,
    reservationId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.markReservationRelease(
      auctionId,
      reservationId,
      AuctionCancellationEffectStatus.Retryable,
      error,
      updatedAt,
    )
  }

  async markReservationReleaseTerminal(
    auctionId: string,
    reservationId: string,
    error: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.markReservationRelease(
      auctionId,
      reservationId,
      AuctionCancellationEffectStatus.TerminalError,
      error,
      updatedAt,
    )
  }

  /**
   * El release vive en la tabla hija, pero el lease y el orden de reclamo
   * (`updated_at`) son de la fila padre: se actualizan en la misma
   * transaccion, igual que hacen los `mark*` de Wallet/Inventory.
   */
  private async markReservationRelease(
    auctionId: string,
    reservationId: string,
    status:
      | AuctionCancellationEffectStatus.Confirmed
      | AuctionCancellationEffectStatus.Retryable
      | AuctionCancellationEffectStatus.TerminalError,
    error: string | null,
    updatedAt: Date,
  ): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('auction_cancellation_reservation_releases')
        .set({ status, last_error: error, updated_at: updatedAt })
        .where('auction_id', '=', auctionId)
        .where('reservation_id', '=', reservationId)
        .execute()
      await transaction
        .updateTable('auction_cancellations')
        .set({ updated_at: updatedAt, ...releasedLease })
        .where('auction_id', '=', auctionId)
        .execute()
    })
  }

  /**
   * `FOR UPDATE SKIP LOCKED` + lease corto, mismo patron que
   * `PostgresAuctionSettlementWorkRepository.claimDue`: reclama sin
   * mantener la transaccion abierta durante las llamadas HTTP a
   * Wallet/Inventory que ocurren despues, fuera de esta funcion.
   * `TERMINAL_ERROR` y `NOT_REQUIRED` nunca entran en el filtro -no son
   * candidatos automaticos-.
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
            // CA-05: una automatica tambien es candidata mientras le quede
            // alguna reserva de puja por liberar.
            expression.exists(
              expression
                .selectFrom('auction_cancellation_reservation_releases as release')
                .select('release.reservation_id')
                .whereRef('release.auction_id', '=', 'auction_cancellations.auction_id')
                .where('release.status', 'in', [
                  AuctionCancellationEffectStatus.Pending,
                  AuctionCancellationEffectStatus.Retryable,
                ]),
            ),
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

      const releases = await transaction
        .selectFrom('auction_cancellation_reservation_releases')
        .selectAll()
        .where('auction_id', 'in', auctionIds)
        .orderBy('reservation_id', 'asc')
        .execute()

      return candidates.map((candidate) =>
        toSnapshot(
          { ...candidate, lease_owner: input.workerId, lease_until: input.leaseUntil },
          releases.filter((release) => release.auction_id === candidate.auction_id),
        ),
      )
    })
  }
}

const releasedLease = { lease_owner: null, lease_until: null }
