import type { Kysely, Selectable } from 'kysely'
import type {
  AuctionInventorySettlementIntentRepositoryPort,
  AuctionInventorySettlementIntentSnapshot,
  CreateAuctionInventorySettlementIntentInput,
} from '../../../application/ports/AuctionInventorySettlementIntentRepositoryPort'
import type { Database } from './schema'

type IntentRow = Selectable<Database['auction_inventory_settlement_intents']>

const toSnapshot = (row: IntentRow): AuctionInventorySettlementIntentSnapshot => ({
  auctionId: row.auction_id,
  operationId: row.operation_id,
  action: row.action,
  commitmentId: row.commitment_id,
  sellerId: row.seller_id,
  productId: row.product_id,
  winnerId: row.winner_id,
  status: row.status,
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
})

export class PostgresAuctionInventorySettlementIntentRepository implements AuctionInventorySettlementIntentRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async getByAuctionId(
    auctionId: string,
  ): Promise<AuctionInventorySettlementIntentSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_inventory_settlement_intents')
      .selectAll()
      .where('auction_id', '=', auctionId)
      .executeTakeFirst()
    return row === undefined ? null : toSnapshot(row)
  }

  async getOrCreate(
    input: CreateAuctionInventorySettlementIntentInput,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    await this.db
      .insertInto('auction_inventory_settlement_intents')
      .values({
        auction_id: input.auctionId,
        operation_id: input.operationId,
        action: input.action,
        commitment_id: input.commitmentId,
        seller_id: input.sellerId,
        product_id: input.productId,
        winner_id: input.action === 'RELEASE' ? null : input.winnerId,
        status: 'PENDING',
        last_error: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
        confirmed_at: null,
      })
      .onConflict((conflict) => conflict.column('auction_id').doNothing())
      .execute()
    const intent = await this.require(input.auctionId)
    if (!sameIntent(intent, input))
      throw new Error(`Conflicto de intent Inventory ${input.auctionId}.`)
    return intent
  }

  async markConfirmed(
    auctionId: string,
    confirmedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    const current = await this.require(auctionId)
    if (current.status === 'CONFIRMED') return current
    await this.transition(auctionId, ['PENDING', 'RETRYABLE'], {
      status: 'CONFIRMED',
      last_error: null,
      updated_at: confirmedAt,
      confirmed_at: confirmedAt,
    })
    return this.require(auctionId)
  }

  async markRetryable(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    await this.transition(auctionId, ['PENDING', 'RETRYABLE'], {
      status: 'RETRYABLE',
      last_error: error,
      updated_at: updatedAt,
      confirmed_at: null,
    })
    return this.require(auctionId)
  }

  async markTerminalError(
    auctionId: string,
    error: string,
    updatedAt: Date,
  ): Promise<AuctionInventorySettlementIntentSnapshot> {
    const current = await this.require(auctionId)
    if (current.status === 'TERMINAL_ERROR') return current
    await this.transition(auctionId, ['PENDING', 'RETRYABLE'], {
      status: 'TERMINAL_ERROR',
      last_error: error,
      updated_at: updatedAt,
      confirmed_at: null,
    })
    return this.require(auctionId)
  }

  private async transition(
    auctionId: string,
    allowed: readonly ('PENDING' | 'RETRYABLE')[],
    patch: {
      status: 'CONFIRMED' | 'RETRYABLE' | 'TERMINAL_ERROR'
      last_error: string | null
      updated_at: Date
      confirmed_at: Date | null
    },
  ): Promise<void> {
    const result = await this.db
      .updateTable('auction_inventory_settlement_intents')
      .set(patch)
      .where('auction_id', '=', auctionId)
      .where('status', 'in', allowed)
      .executeTakeFirst()
    if (result.numUpdatedRows === 0n)
      throw new Error('El intent Inventory no admite esa transicion.')
  }

  private async require(auctionId: string): Promise<AuctionInventorySettlementIntentSnapshot> {
    const intent = await this.getByAuctionId(auctionId)
    if (intent === null) throw new Error(`El intent Inventory ${auctionId} no existe.`)
    return intent
  }
}

const sameIntent = (
  intent: AuctionInventorySettlementIntentSnapshot,
  input: CreateAuctionInventorySettlementIntentInput,
): boolean =>
  intent.operationId === input.operationId &&
  intent.action === input.action &&
  intent.commitmentId === input.commitmentId &&
  intent.sellerId === input.sellerId &&
  intent.productId === input.productId &&
  intent.winnerId === (input.action === 'RELEASE' ? null : input.winnerId)
