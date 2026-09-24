import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  AuctionWatchlistEvent,
  WatchlistEventPublisherPort,
} from '../../../application/ports/WatchlistEventPublisherPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export const AUCTION_WATCHLIST_EVENT_PATH =
  '/api/internal/v1/notifications/auction/watchlist-events'

export interface HttpWatchlistEventPublisherOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

/** Publica eventos versionados con la firma HMAC usada entre servicios. */
export class HttpWatchlistEventPublisher implements WatchlistEventPublisherPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpWatchlistEventPublisherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  /** Convierte Date a ISO y exige confirmación del mismo eventId. */
  async publish(event: AuctionWatchlistEvent): Promise<void> {
    const body = {
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      ...(event.eventType === 'auction.closing-soon.v1'
        ? { closesAt: event.closesAt.toISOString() }
        : {}),
    }
    const timestamp = String(this.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method: 'POST',
      path: AUCTION_WATCHLIST_EVENT_PATH,
      timestamp,
      body,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl}${AUCTION_WATCHLIST_EVENT_PATH}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [INTERNAL_SERVICE_HEADER]: this.options.serviceName,
            [INTERNAL_TIMESTAMP_HEADER]: timestamp,
            [INTERNAL_SIGNATURE_HEADER]: signature,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      )
      if (!response.ok) throw new ExternalDependencyUnavailableError('notifications')
      const result = (await response.json()) as Record<string, unknown>
      if (result.eventId !== event.eventId) {
        throw new ExternalContractError('notifications', 'eventId de confirmación incompatible.')
      }
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      )
        throw error
      throw new ExternalDependencyUnavailableError('notifications')
    } finally {
      clearTimeout(timer)
    }
  }
}
