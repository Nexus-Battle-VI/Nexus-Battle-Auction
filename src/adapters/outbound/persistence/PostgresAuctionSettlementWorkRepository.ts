import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from 'kysely'

import {
  AuctionSettlementWorkStatus,
  type AuctionSettlementWorkRepositoryPort,
  type AuctionSettlementWorkSnapshot,
  type ClaimDueAuctionSettlementsInput,
  type MarkAuctionSettlementRetryableInput,
  type MarkAuctionSettlementTerminalInput,
  type MarkAuctionSettlementWorkInput,
} from '../../../application/ports/AuctionSettlementWorkRepositoryPort'
import type { Database } from './schema'

type WorkRow = Selectable<Database['auction_settlement_work']>
type WorkPatch = Updateable<Database['auction_settlement_work']>

const toSnapshot = (row: WorkRow): AuctionSettlementWorkSnapshot => ({
  auctionId: row.auction_id,
  status: row.status,
  availableAt: new Date(row.available_at),
  leaseOwner: row.lease_owner,
  leaseUntil: row.lease_until === null ? null : new Date(row.lease_until),
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  completedAt: row.completed_at === null ? null : new Date(row.completed_at),
  terminalAt: row.terminal_at === null ? null : new Date(row.terminal_at),
})

const incompleteSettlementStatuses = [
  'PENDING',
  'CAPTURE_PENDING',
  'CAPTURED',
  'LOSER_RELEASES_PENDING',
  'FAILED_RETRYABLE',
] as const

export class PostgresAuctionSettlementWorkRepository implements AuctionSettlementWorkRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  claimDue(
    input: ClaimDueAuctionSettlementsInput,
  ): Promise<readonly AuctionSettlementWorkSnapshot[]> {
    return this.db.transaction().execute(async (transaction) => {
      await this.discover(transaction, input.now)

      const candidates = await transaction
        .selectFrom('auction_settlement_work as work')
        .innerJoin('auctions', 'auctions.id', 'work.auction_id')
        .selectAll('work')
        .where((expression) =>
          expression.or([
            expression.and([
              expression('work.status', 'in', [
                AuctionSettlementWorkStatus.Ready,
                AuctionSettlementWorkStatus.Retryable,
              ]),
              expression('work.available_at', '<=', input.now),
            ]),
            expression.and([
              expression('work.status', '=', AuctionSettlementWorkStatus.Leased),
              expression('work.lease_until', '<=', input.now),
            ]),
          ]),
        )
        .orderBy('auctions.closes_at', 'asc')
        .orderBy('work.auction_id', 'asc')
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute()

      if (candidates.length === 0) return []

      const auctionIds = candidates.map((candidate) => candidate.auction_id)

      await transaction
        .updateTable('auction_settlement_work')
        .set((expression) => ({
          status: AuctionSettlementWorkStatus.Leased,
          lease_owner: input.workerId,
          lease_until: input.leaseUntil,
          attempts: expression('attempts', '+', 1),
          updated_at: input.now,
          last_error: null,
        }))
        .where('auction_id', 'in', auctionIds)
        .execute()

      return candidates.map((candidate) =>
        toSnapshot({
          ...candidate,
          status: AuctionSettlementWorkStatus.Leased,
          lease_owner: input.workerId,
          lease_until: input.leaseUntil,
          attempts: candidate.attempts + 1,
          updated_at: input.now,
          last_error: null,
        }),
      )
    })
  }

  async markCompleted(
    input: MarkAuctionSettlementWorkInput,
  ): Promise<AuctionSettlementWorkSnapshot> {
    const current = await this.getByAuctionId(input.auctionId)
    if (current?.status === AuctionSettlementWorkStatus.Completed) return current

    return this.updateOwnedLease(input, {
      status: AuctionSettlementWorkStatus.Completed,
      completed_at: input.now,
      terminal_at: null,
      last_error: null,
    })
  }

  markRetryable(
    input: MarkAuctionSettlementRetryableInput,
  ): Promise<AuctionSettlementWorkSnapshot> {
    return this.updateOwnedLease(input, {
      status: AuctionSettlementWorkStatus.Retryable,
      available_at: input.availableAt,
      completed_at: null,
      terminal_at: null,
      last_error: input.error,
    })
  }

  markTerminal(input: MarkAuctionSettlementTerminalInput): Promise<AuctionSettlementWorkSnapshot> {
    return this.updateOwnedLease(input, {
      status: AuctionSettlementWorkStatus.Terminal,
      completed_at: null,
      terminal_at: input.now,
      last_error: input.error,
    })
  }

  async getByAuctionId(auctionId: string): Promise<AuctionSettlementWorkSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_settlement_work')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()

    return row === undefined ? null : toSnapshot(row)
  }

  private async discover(transaction: Transaction<Database>, now: Date): Promise<void> {
    await sql`
      insert into auction_settlement_work (
        auction_id, status, available_at, attempts, created_at, updated_at
      )
      select auctions.id, 'READY', ${now}, 0, ${now}, ${now}
      from auctions
      left join auction_settlements
        on auction_settlements.auction_id = auctions.id
      where auctions.closes_at <= ${now}
        and (
          auctions.status = 'ACTIVE'
          or (
            auctions.status = 'FINISHED'
            and auction_settlements.status in (${sql.join(incompleteSettlementStatuses)})
          )
        )
      on conflict (auction_id) do nothing
    `.execute(transaction)
  }

  private async updateOwnedLease(
    input: MarkAuctionSettlementWorkInput,
    patch: WorkPatch,
  ): Promise<AuctionSettlementWorkSnapshot> {
    const row = await this.db
      .updateTable('auction_settlement_work')
      .set({
        ...patch,
        lease_owner: null,
        lease_until: null,
        updated_at: input.now,
      })
      .where('auction_id', '=', input.auctionId)
      .where('status', '=', AuctionSettlementWorkStatus.Leased)
      .where('lease_owner', '=', input.workerId)
      .returningAll()
      .executeTakeFirst()

    if (row === undefined) {
      throw new Error(
        `El trabajo de settlement ${input.auctionId} no esta arrendado por ${input.workerId}.`,
      )
    }

    return toSnapshot(row)
  }
}
