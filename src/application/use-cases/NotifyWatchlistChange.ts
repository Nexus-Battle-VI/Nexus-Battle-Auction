import type { WatchlistRepositoryPort } from '../ports/WatchlistRepositoryPort'
import type {
  WatchlistChangeType,
  WatchlistEventPublisherPort,
} from '../ports/WatchlistEventPublisherPort'

export interface NotifyWatchlistChangeCommand {
  readonly eventId: string
  readonly auctionId: string
  readonly changeType: WatchlistChangeType
  readonly occurredAt: Date
}

/** Resuelve seguidores dentro de Auction y publica un evento sin duplicar destinatarios. */
export class NotifyWatchlistChange {
  constructor(
    private readonly watchlist: WatchlistRepositoryPort,
    private readonly publisher: WatchlistEventPublisherPort,
  ) {}

  /** Retorna el número de destinatarios incluidos en el evento. */
  async execute(command: NotifyWatchlistChangeCommand): Promise<number> {
    const entries = await this.watchlist.listByAuction(command.auctionId)
    const recipients = [...new Set(entries.map((entry) => entry.snapshot().playerId))].sort()
    if (recipients.length === 0) return 0
    await this.publisher.publish({
      eventId: command.eventId,
      eventType: 'auction.watchlist.changed.v1',
      auctionId: command.auctionId,
      recipientPlayerIds: recipients,
      changeType: command.changeType,
      occurredAt: new Date(command.occurredAt),
    })
    return recipients.length
  }
}
