import type { Kysely, Selectable } from 'kysely'
import type {
  AuctionPublicationIntentRepositoryPort,
  AuctionPublicationIntentSnapshot,
  CreateAuctionPublicationIntentInput,
} from '../../../application/ports/AuctionPublicationIntentRepositoryPort'
import type { Database } from './schema'

type IntentRow = Selectable<Database['auction_publication_intents']>

const toSnapshot = (row: IntentRow): AuctionPublicationIntentSnapshot => ({
  operationId: row.operation_id,
  auctionId: row.auction_id,
  sellerId: row.seller_id,
  productId: row.product_id,
  closesAt: new Date(row.closes_at),
  inventoryCommitmentId: row.inventory_commitment_id,
  inventoryStatus: row.inventory_status,
  publicationStatus: row.publication_status,
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
})

export class PostgresAuctionPublicationIntentRepository implements AuctionPublicationIntentRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async getOrCreate(
    input: CreateAuctionPublicationIntentInput,
  ): Promise<AuctionPublicationIntentSnapshot> {
    await this.db
      .insertInto('auction_publication_intents')
      .values({
        operation_id: input.operationId,
        auction_id: input.auctionId,
        seller_id: input.sellerId,
        product_id: input.productId,
        closes_at: input.closesAt,
        inventory_commitment_id: null,
        inventory_status: 'PENDING',
        publication_status: 'PENDING',
        last_error: null,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      })
      .onConflict((conflict) => conflict.column('operation_id').doNothing())
      .execute()
    const intent = await this.getRequired(input.operationId)
    if (intent.sellerId !== input.sellerId || intent.productId !== input.productId) {
      throw new Error(`Conflicto de intent para publicacion ${input.operationId}.`)
    }
    return intent
  }

  async getByOperationId(operationId: string): Promise<AuctionPublicationIntentSnapshot | null> {
    const row = await this.db
      .selectFrom('auction_publication_intents')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirst()
    return row === undefined ? null : toSnapshot(row)
  }

  async persistInventoryCommitment(
    operationId: string,
    commitmentId: string,
    updatedAt: Date,
  ): Promise<AuctionPublicationIntentSnapshot> {
    const current = await this.getRequired(operationId)
    if (current.inventoryCommitmentId !== null && current.inventoryCommitmentId !== commitmentId)
      throw new Error(`Conflicto de commitment para publicacion ${operationId}.`)
    if (current.inventoryStatus === 'COMMITTED') return current
    await this.db
      .updateTable('auction_publication_intents')
      .set({
        inventory_commitment_id: commitmentId,
        inventory_status: 'COMMITTED',
        last_error: null,
        updated_at: updatedAt,
      })
      .where('operation_id', '=', operationId)
      .where('inventory_status', '=', 'PENDING')
      .execute()
    return this.getRequired(operationId)
  }

  async markPublicationCompleted(
    operationId: string,
    updatedAt: Date,
  ): Promise<AuctionPublicationIntentSnapshot> {
    await this.db
      .updateTable('auction_publication_intents')
      .set({ publication_status: 'COMPLETED', last_error: null, updated_at: updatedAt })
      .where('operation_id', '=', operationId)
      .execute()
    return this.getRequired(operationId)
  }

  async recordFailure(operationId: string, error: string, updatedAt: Date): Promise<void> {
    await this.db
      .updateTable('auction_publication_intents')
      .set({ last_error: error, updated_at: updatedAt })
      .where('operation_id', '=', operationId)
      .execute()
  }

  private async getRequired(operationId: string): Promise<AuctionPublicationIntentSnapshot> {
    const intent = await this.getByOperationId(operationId)
    if (intent === null) throw new Error(`La intencion ${operationId} no existe.`)
    return intent
  }
}
