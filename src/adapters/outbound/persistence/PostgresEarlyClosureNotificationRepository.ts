import type { Kysely, Selectable } from 'kysely'

import type {
  EarlyClosureNotificationRecord,
  EarlyClosureNotificationRepositoryPort,
  EarlyClosureNotificationStatus,
  EnsurePendingNotificationInput,
  RecordNotificationAttemptCommand,
} from '../../../application/ports/EarlyClosureNotificationRepositoryPort'
import type { Database } from './schema'

type NotificationRow = Selectable<Database['auction_early_closure_notifications']>

const toRecord = (row: NotificationRow): EarlyClosureNotificationRecord => ({
  auctionId: row.auction_id,
  bidderId: row.bidder_id,
  transactionId: row.transaction_id,
  bidId: row.bid_id,
  amountCredits: row.amount_credits,
  closedAt: new Date(row.closed_at),
  creditOperationId: row.credit_operation_id,
  creditReservationId: row.credit_reservation_id,
  status: row.status as EarlyClosureNotificationStatus,
  attempts: row.attempts,
  creditsReleased: row.credits_released,
  lastError: row.last_error,
})

export class PostgresEarlyClosureNotificationRepository implements EarlyClosureNotificationRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async ensurePending(
    input: EnsurePendingNotificationInput,
  ): Promise<EarlyClosureNotificationRecord> {
    const existing = await this.db
      .selectFrom('auction_early_closure_notifications')
      .selectAll()
      .where('auction_id', '=', input.auctionId)
      .where('bidder_id', '=', input.bidderId)
      .where('transaction_id', '=', input.transactionId)
      .executeTakeFirst()

    if (existing !== undefined) {
      return toRecord(existing)
    }

    const inserted = await this.db
      .insertInto('auction_early_closure_notifications')
      .values({
        auction_id: input.auctionId,
        bidder_id: input.bidderId,
        transaction_id: input.transactionId,
        bid_id: input.bidId,
        amount_credits: input.amountCredits,
        closed_at: input.closedAt,
        credit_operation_id: input.creditOperationId,
        credit_reservation_id: input.creditReservationId,
        status: 'PENDING',
        attempts: 0,
        credits_released: input.creditReservationId === null,
        last_error: null,
        updated_at: input.closedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(['auction_id', 'bidder_id', 'transaction_id']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst()

    if (inserted !== undefined) {
      return toRecord(inserted)
    }

    // Perdimos la carrera de insercion contra otro proceso: el registro ya
    // existe, se lee de nuevo.
    const row = await this.db
      .selectFrom('auction_early_closure_notifications')
      .selectAll()
      .where('auction_id', '=', input.auctionId)
      .where('bidder_id', '=', input.bidderId)
      .where('transaction_id', '=', input.transactionId)
      .executeTakeFirstOrThrow()

    return toRecord(row)
  }

  async recordAttempt(command: RecordNotificationAttemptCommand): Promise<void> {
    await this.db
      .updateTable('auction_early_closure_notifications')
      .set({
        status: command.status,
        attempts: command.attempts,
        credits_released: command.creditsReleased,
        last_error: command.lastError,
        updated_at: command.occurredAt,
      })
      .where('auction_id', '=', command.auctionId)
      .where('bidder_id', '=', command.bidderId)
      .where('transaction_id', '=', command.transactionId)
      .execute()
  }

  async findByAuction(auctionId: string): Promise<readonly EarlyClosureNotificationRecord[]> {
    const rows = await this.db
      .selectFrom('auction_early_closure_notifications')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .execute()

    return rows.map(toRecord)
  }

  async findFailed(): Promise<readonly EarlyClosureNotificationRecord[]> {
    const rows = await this.db
      .selectFrom('auction_early_closure_notifications')
      .selectAll()
      .where('status', '=', 'FAILED' satisfies EarlyClosureNotificationStatus)
      .execute()

    return rows.map(toRecord)
  }
}
