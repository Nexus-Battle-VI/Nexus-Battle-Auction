import type { Kysely } from 'kysely'

import type { AuctionSettlementOutboxRepositoryPort } from '../../../application/ports/AuctionSettlementOutboxRepositoryPort'
import type { AuctionSettledEventV1 } from '../../../domain/events/AuctionSettledEventV1'
import type { Database } from './schema'

const isAuctionSettledEventV1 = (value: unknown): value is AuctionSettledEventV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const event = value as Partial<AuctionSettledEventV1>
  const data = (value as { readonly data?: unknown }).data
  return (
    event.eventType === 'auction.settled' &&
    event.eventVersion === 1 &&
    event.producer === 'auction' &&
    typeof event.eventId === 'string' &&
    typeof event.aggregateId === 'string' &&
    typeof event.occurredAt === 'string' &&
    typeof event.correlationId === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
  )
}

export class PostgresAuctionSettlementOutboxRepository implements AuctionSettlementOutboxRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async findPending(input: { readonly limit: number }): Promise<readonly AuctionSettledEventV1[]> {
    const rows = await this.db
      .selectFrom('outbox_events')
      .select(['id', 'payload'])
      .where('event_type', '=', 'auction.settled.v1')
      .where('published_at', 'is', null)
      // La tabla existente no tiene created_at; occurred_at es el instante
      // durable de insercion del evento y conserva el orden determinista.
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute()
    return rows.map((row) => {
      if (!isAuctionSettledEventV1(row.payload) || row.payload.eventId !== row.id) {
        throw new Error(`Outbox settlement invalido: ${row.id}.`)
      }
      return row.payload
    })
  }

  async markPublished(input: {
    readonly eventId: string
    readonly publishedAt: Date
  }): Promise<void> {
    await this.db
      .updateTable('outbox_events')
      .set({ published_at: input.publishedAt })
      .where('id', '=', input.eventId)
      .where('event_type', '=', 'auction.settled.v1')
      .where('published_at', 'is', null)
      .execute()
  }
}
