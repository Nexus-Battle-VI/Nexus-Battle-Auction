import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { WatchlistEventPublisherPort } from '../ports/WatchlistEventPublisherPort'

const ONE_HOUR_MS = 60 * 60 * 1000

type ReminderRepository = Pick<AuctionRepositoryPort, 'findActiveClosingBetween' | 'findBidHistory'>

/** Busca subastas en la ventana de una hora y notifica únicamente a participantes reales. */
export class DispatchClosingSoonReminders {
  constructor(
    private readonly auctions: ReminderRepository,
    private readonly publisher: WatchlistEventPublisherPort,
    private readonly clock: ClockPort,
  ) {}

  /** El eventId estable hace idempotentes las ejecuciones repetidas del scheduler. */
  async execute(): Promise<number> {
    const now = this.clock.now()
    const until = new Date(now.getTime() + ONE_HOUR_MS)
    const due = await this.auctions.findActiveClosingBetween(now, until)
    let notified = 0
    for (const auction of due) {
      const bids = await this.auctions.findBidHistory(auction.id)
      const recipients = [...new Set(bids.map((bid) => bid.bidderId))].sort()
      if (recipients.length === 0) continue
      await this.publisher.publish({
        eventId: `${auction.id}:closing:${auction.closesAt.toISOString()}`,
        eventType: 'auction.closing-soon.v1',
        auctionId: auction.id,
        recipientPlayerIds: recipients,
        closesAt: new Date(auction.closesAt),
        occurredAt: new Date(now),
      })
      notified += recipients.length
    }
    return notified
  }
}
