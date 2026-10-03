import type { AuctionConfirmationEventPublisherPort } from '../ports/AuctionConfirmationEventPublisherPort'
import type { AuctionConfirmationOutboxRepositoryPort } from '../ports/AuctionConfirmationOutboxRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

export interface AuctionConfirmationDispatcherLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void

  error(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

export class AuctionConfirmationOutboxDispatcher {
  constructor(
    private readonly outbox: AuctionConfirmationOutboxRepositoryPort,
    private readonly publisher: AuctionConfirmationEventPublisherPort,
    private readonly clock: ClockPort,
    private readonly logger: AuctionConfirmationDispatcherLogger,
    private readonly batchSize: number,
    private readonly enabled: boolean,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('El tamaño del lote debe ser un entero positivo.')
    }
  }

  async runBatch(): Promise<{
    readonly pending: number
    readonly published: number
    readonly failed: number
  }> {
    if (!this.enabled) {
      return { pending: 0, published: 0, failed: 0 }
    }

    const events = await this.outbox.findPending({ limit: this.batchSize })
    let published = 0
    let failed = 0

    for (const event of events) {
      try {
        await this.publisher.publish(event)

        await this.outbox.markPublished({
          eventId: event.eventId,
          publishedAt: this.clock.now(),
        })

        published += 1
        this.logger.info('auction_confirmation_event_published', {
          eventId: event.eventId,
          eventType: event.eventType,
          correlationId: event.correlationId,
        })
      } catch (error: unknown) {
        failed += 1
        this.logger.error('auction_confirmation_event_dispatch_failed', {
          eventId: event.eventId,
          eventType: event.eventType,
          correlationId: event.correlationId,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { pending: events.length, published, failed }
  }
}
