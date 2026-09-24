import { ExternalDependencyUnavailableError } from '../../../application/errors/ExternalDependencyError'
import type {
  AuctionWatchlistEvent,
  WatchlistEventPublisherPort,
} from '../../../application/ports/WatchlistEventPublisherPort'

/** Adaptador explícito para entornos que todavía no configuran Notifications. */
export class UnavailableWatchlistEventPublisher implements WatchlistEventPublisherPort {
  publish(event: AuctionWatchlistEvent): Promise<void> {
    void event
    return Promise.reject(new ExternalDependencyUnavailableError('notifications'))
  }
}
