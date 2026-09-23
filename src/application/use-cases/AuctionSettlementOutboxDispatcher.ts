import type { AuctionSettlementEventPublisherPort } from '../ports/AuctionSettlementEventPublisherPort'
import type { AuctionSettlementOutboxRepositoryPort } from '../ports/AuctionSettlementOutboxRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

export interface AuctionSettlementOutboxDispatcherLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  error(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class AuctionSettlementOutboxDispatcher {
  constructor(
    private readonly outbox: AuctionSettlementOutboxRepositoryPort,
    private readonly publisher: AuctionSettlementEventPublisherPort,
    private readonly clock: ClockPort,
    private readonly logger: AuctionSettlementOutboxDispatcherLogger,
    private readonly batchSize: number,
    private readonly enabled = true,
  ) {}

  async runBatch(): Promise<{
    readonly pending: number
    readonly published: number
    readonly failed: number
  }> {
    this.logger.info('auction_settlement_event_dispatch_batch_started', {
      batchSize: this.batchSize,
      enabled: this.enabled,
    })
    if (!this.enabled) {
      this.logger.info('auction_settlement_event_dispatch_batch_completed', {
        pending: 0,
        published: 0,
        failed: 0,
      })
      return { pending: 0, published: 0, failed: 0 }
    }
    const events = await this.outbox.findPending({ limit: this.batchSize })
    let published = 0
    let failed = 0
    for (const event of events) {
      try {
        await this.publisher.publish(event)
      } catch (error: unknown) {
        failed += 1
        this.logger.error('auction_settlement_event_publish_failed', {
          eventId: event.eventId,
          detail: describeError(error),
        })
        continue
      }
      try {
        await this.outbox.markPublished({ eventId: event.eventId, publishedAt: this.clock.now() })
        published += 1
        this.logger.info('auction_settlement_event_published', { eventId: event.eventId })
      } catch (error: unknown) {
        failed += 1
        this.logger.error('auction_settlement_event_mark_published_failed', {
          eventId: event.eventId,
          detail: describeError(error),
        })
      }
    }
    this.logger.info('auction_settlement_event_dispatch_batch_completed', {
      pending: events.length,
      published,
      failed,
    })
    return { pending: events.length, published, failed }
  }
}
