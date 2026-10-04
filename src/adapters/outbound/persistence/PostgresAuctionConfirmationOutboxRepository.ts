import type { Kysely } from 'kysely'

import type {
  AuctionConfirmationEvent,
  AuctionConfirmationOutboxRepositoryPort,
} from '../../../application/ports/AuctionConfirmationOutboxRepositoryPort'
import type { AuctionBidAcceptedEventV1 } from '../../../domain/events/AuctionBidAcceptedEventV1'
import type { AuctionBuyNowCompletedEventV1 } from '../../../domain/events/AuctionBuyNowCompletedEventV1'
import type { AuctionProductClaimedEventV1 } from '../../../domain/events/AuctionProductClaimedEventV1'
import type { Database } from './schema'

const eventTypes = [
  'auction.published.v1',
  'auction.bid.accepted.v1',
  'auction.buy-now.completed.v1',
  'auction.product.claimed.v1',
]

const objectOf = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('El payload del outbox debe ser un objeto.')
  }
  return value as Record<string, unknown>
}

const textOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('El evento contiene un identificador o texto inválido.')
  }
  return value
}

const dateOf = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : textOf(value)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    throw new Error('El evento contiene una fecha inválida.')
  }
  return date.toISOString()
}

const parseBidAccepted = (payload: unknown): AuctionBidAcceptedEventV1 => {
  const event = objectOf(payload)
  const data = objectOf(event.data)

  if (
    event.eventType !== 'auction.bid.accepted' ||
    event.eventVersion !== 1 ||
    event.producer !== 'auction'
  ) {
    throw new Error('Contrato de puja aceptada no soportado.')
  }

  const amount = data.amountCredits
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('El importe de la puja debe ser un entero positivo.')
  }

  const parsed: AuctionBidAcceptedEventV1 = {
    eventId: textOf(event.eventId),
    eventType: 'auction.bid.accepted',
    eventVersion: 1,
    aggregateId: textOf(event.aggregateId),
    occurredAt: dateOf(event.occurredAt),
    producer: 'auction',
    correlationId: textOf(event.correlationId),
    data: {
      operationId: textOf(data.operationId),
      auctionId: textOf(data.auctionId),
      productId: textOf(data.productId),
      sellerId: textOf(data.sellerId),
      bidderId: textOf(data.bidderId),
      bidId: textOf(data.bidId),
      amountCredits: amount,
      acceptedAt: dateOf(data.acceptedAt),
    },
  }

  if (
    parsed.aggregateId !== parsed.data.auctionId ||
    parsed.correlationId !== parsed.data.operationId ||
    parsed.eventId !== `${parsed.data.operationId}:bid-accepted` ||
    parsed.occurredAt !== parsed.data.acceptedAt
  ) {
    throw new Error('La identidad del evento de puja es inconsistente.')
  }

  return parsed
}

const parseBuyNowCompleted = (payload: unknown): AuctionBuyNowCompletedEventV1 => {
  const event = objectOf(payload)
  const data = objectOf(event.data)
  if (
    event.eventType !== 'auction.buy-now.completed' ||
    event.eventVersion !== 1 ||
    event.producer !== 'auction'
  ) {
    throw new Error('Contrato de compra inmediata no soportado.')
  }
  const amount = data.amountCredits
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('El importe de compra inmediata debe ser un entero positivo.')
  }
  const parsed: AuctionBuyNowCompletedEventV1 = {
    eventId: textOf(event.eventId),
    eventType: 'auction.buy-now.completed',
    eventVersion: 1,
    aggregateId: textOf(event.aggregateId),
    occurredAt: dateOf(event.occurredAt),
    producer: 'auction',
    correlationId: textOf(event.correlationId),
    data: {
      operationId: textOf(data.operationId),
      transactionId: textOf(data.transactionId),
      transferId: textOf(data.transferId),
      auctionId: textOf(data.auctionId),
      productId: textOf(data.productId),
      sellerId: textOf(data.sellerId),
      buyerId: textOf(data.buyerId),
      amountCredits: amount,
      completedAt: dateOf(data.completedAt),
    },
  }
  if (
    parsed.aggregateId !== parsed.data.auctionId ||
    parsed.correlationId !== parsed.data.operationId ||
    parsed.eventId !== `${parsed.data.operationId}:buy-now-completed` ||
    parsed.occurredAt !== parsed.data.completedAt ||
    parsed.data.sellerId === parsed.data.buyerId
  ) {
    throw new Error('La compra inmediata contiene una identidad inconsistente.')
  }
  return parsed
}

const parseProductClaimed = (payload: unknown): AuctionProductClaimedEventV1 => {
  const event = objectOf(payload)
  const data = objectOf(event.data)
  if (
    event.eventType !== 'auction.product.claimed' ||
    event.eventVersion !== 1 ||
    event.producer !== 'auction'
  ) {
    throw new Error('Contrato de producto reclamado no soportado.')
  }
  const parsed: AuctionProductClaimedEventV1 = {
    eventId: textOf(event.eventId),
    eventType: 'auction.product.claimed',
    eventVersion: 1,
    aggregateId: textOf(event.aggregateId),
    occurredAt: dateOf(event.occurredAt),
    producer: 'auction',
    correlationId: textOf(event.correlationId),
    data: {
      auctionId: textOf(data.auctionId),
      winnerId: textOf(data.winnerId),
      productId: textOf(data.productId),
      claimedAt: dateOf(data.claimedAt),
    },
  }
  if (
    parsed.aggregateId !== parsed.data.auctionId ||
    parsed.correlationId !== `auction:${parsed.data.auctionId}:inventory:claim` ||
    parsed.eventId !== `auction:${parsed.data.auctionId}:product-claimed` ||
    parsed.occurredAt !== parsed.data.claimedAt
  ) {
    throw new Error('El producto reclamado contiene una identidad inconsistente.')
  }
  return parsed
}

export class PostgresAuctionConfirmationOutboxRepository implements AuctionConfirmationOutboxRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async findPending(input: {
    readonly limit: number
  }): Promise<readonly AuctionConfirmationEvent[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error('El límite debe ser un entero positivo.')
    }

    const rows = await this.db
      .selectFrom('outbox_events')
      .select(['id', 'aggregate_id', 'event_type', 'payload', 'occurred_at'])
      .where('event_type', 'in', eventTypes)
      .where('published_at', 'is', null)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit)
      .execute()

    const events: AuctionConfirmationEvent[] = []

    for (const row of rows) {
      if (row.event_type === 'auction.bid.accepted.v1') {
        const event = parseBidAccepted(row.payload)

        if (
          event.eventId !== row.id ||
          event.aggregateId !== row.aggregate_id ||
          event.occurredAt !== dateOf(row.occurred_at)
        ) {
          throw new Error(`Outbox de puja inconsistente: ${row.id}.`)
        }

        events.push(event)
        continue
      }

      if (row.event_type === 'auction.buy-now.completed.v1') {
        const event = parseBuyNowCompleted(row.payload)
        if (
          event.eventId !== row.id ||
          event.aggregateId !== row.aggregate_id ||
          event.occurredAt !== dateOf(row.occurred_at)
        ) {
          throw new Error(`Outbox de compra inmediata inconsistente: ${row.id}.`)
        }
        events.push(event)
        continue
      }

      if (row.event_type === 'auction.product.claimed.v1') {
        const event = parseProductClaimed(row.payload)
        if (
          event.eventId !== row.id ||
          event.aggregateId !== row.aggregate_id ||
          event.occurredAt !== dateOf(row.occurred_at)
        ) {
          throw new Error(`Outbox de reclamo inconsistente: ${row.id}.`)
        }
        events.push(event)
        continue
      }

      // La publicación existente almacena un AuctionSnapshot.
      const snapshot = objectOf(row.payload)
      const auctionId = textOf(snapshot.id)

      if (
        auctionId !== row.aggregate_id ||
        dateOf(snapshot.publishedAt) !== dateOf(row.occurred_at)
      ) {
        throw new Error(`Outbox de publicación inconsistente: ${row.id}.`)
      }

      const operation = await this.db
        .selectFrom('auction_publication_operations')
        .select('operation_id')
        .where('auction_id', '=', auctionId)
        .executeTakeFirst()

      if (operation === undefined) {
        throw new Error(`La publicación ${auctionId} no tiene operación durable.`)
      }

      events.push({
        eventId: row.id,
        eventType: 'auction.published',
        eventVersion: 1,
        aggregateId: auctionId,
        occurredAt: dateOf(row.occurred_at),
        producer: 'auction',
        correlationId: operation.operation_id,
        data: {
          auctionId,
          sellerId: textOf(snapshot.sellerId),
          productId: textOf(snapshot.productId),
          publishedAt: dateOf(snapshot.publishedAt),
          closesAt: dateOf(snapshot.closesAt),
        },
      })
    }

    return events
  }

  async markPublished(input: {
    readonly eventId: string
    readonly publishedAt: Date
  }): Promise<void> {
    const result = await this.db
      .updateTable('outbox_events')
      .set({ published_at: input.publishedAt })
      .where('id', '=', input.eventId)
      .where('event_type', 'in', eventTypes)
      .returning('id')
      .executeTakeFirst()

    if (result === undefined) {
      throw new Error(`El evento de confirmación ${input.eventId} no existe.`)
    }
  }
}
