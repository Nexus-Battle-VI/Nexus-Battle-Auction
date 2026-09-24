import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryWatchlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWatchlistRepository'
import type {
  AuctionWatchlistEvent,
  WatchlistEventPublisherPort,
} from '../../src/application/ports/WatchlistEventPublisherPort'
import { DispatchClosingSoonReminders } from '../../src/application/use-cases/DispatchClosingSoonReminders'
import { NotifyWatchlistChange } from '../../src/application/use-cases/NotifyWatchlistChange'
import { WatchlistEntry } from '../../src/domain/entities/WatchlistEntry'
import { Bid } from '../../src/domain/entities/Bid'
import { watchlistAuction } from '../support/watchlist-auction'

const NOW = new Date('2026-09-21T12:00:00.000Z')

class RecordingPublisher implements WatchlistEventPublisherPort {
  readonly events: AuctionWatchlistEvent[] = []

  publish(event: AuctionWatchlistEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}

/** TASK 68.3: destinatarios, deduplicación y frontera exacta de una hora. */
describe('eventos de watchlist y recordatorios', () => {
  it('publica un cambio relevante una sola vez para seguidores únicos', async () => {
    const auctions = new InMemoryAuctionRepository()
    await auctions.publish(watchlistAuction('auction-1'))
    const watchlist = new InMemoryWatchlistRepository(auctions)
    await watchlist.create(
      WatchlistEntry.create({ playerId: 'player-1', auctionId: 'auction-1', followedAt: NOW }),
    )
    await watchlist.create(
      WatchlistEntry.create({ playerId: 'player-2', auctionId: 'auction-1', followedAt: NOW }),
    )
    const publisher = new RecordingPublisher()
    const useCase = new NotifyWatchlistChange(watchlist, publisher)

    await expect(
      useCase.execute({
        eventId: 'bid-operation-1:watchlist-change',
        auctionId: 'auction-1',
        changeType: 'LEADING_BID_CHANGED',
        occurredAt: NOW,
      }),
    ).resolves.toBe(2)

    expect(publisher.events).toEqual([
      {
        eventId: 'bid-operation-1:watchlist-change',
        eventType: 'auction.watchlist.changed.v1',
        auctionId: 'auction-1',
        recipientPlayerIds: ['player-1', 'player-2'],
        changeType: 'LEADING_BID_CHANGED',
        occurredAt: NOW,
      },
    ])
  })

  it('no publica cambios de una subasta sin seguidores', async () => {
    const auctions = new InMemoryAuctionRepository()
    await auctions.publish(watchlistAuction('auction-1'))
    const publisher = new RecordingPublisher()

    await expect(
      new NotifyWatchlistChange(new InMemoryWatchlistRepository(auctions), publisher).execute({
        eventId: 'event-empty',
        auctionId: 'auction-1',
        changeType: 'LEADING_BID_CHANGED',
        occurredAt: NOW,
      }),
    ).resolves.toBe(0)
    expect(publisher.events).toEqual([])
  })

  it('genera el aviso al entrar en la ventana de una hora y deduplica participantes', async () => {
    const auctions = new InMemoryAuctionRepository()
    const command = watchlistAuction('auction-closing')
    await auctions.publish(command)
    const snapshot = command.auction.snapshot()
    const placedAt = new Date(snapshot.closesAt.getTime() - 2 * 60 * 60 * 1000)
    const bid = (id: string, bidderId: string, amountCredits: number, current: number | null) =>
      Bid.register({
        bidId: id,
        auctionId: snapshot.id,
        bidderId,
        amountCredits,
        placedAt,
        eligibility: {
          auctionStatus: 'ACTIVE',
          sellerId: snapshot.sellerId,
          currentBidCredits: current,
          minimumIncrementCredits: snapshot.minimumBidCredits,
          lastBidAtByBidder: null,
          activeBidCount: 0,
        },
      })
    await auctions.persistBid(bid('bid-1', 'player-1', 20, null))
    await auctions.persistBid(bid('bid-2', 'player-2', 30, 20))
    await auctions.persistBid(bid('bid-3', 'player-1', 40, 30))
    const publisher = new RecordingPublisher()
    const clock = { now: () => new Date(snapshot.closesAt.getTime() - 60 * 60 * 1000) }

    await expect(
      new DispatchClosingSoonReminders(auctions, publisher, clock).execute(),
    ).resolves.toBe(2)
    expect(publisher.events[0]).toMatchObject({
      eventType: 'auction.closing-soon.v1',
      auctionId: 'auction-closing',
      recipientPlayerIds: ['player-1', 'player-2'],
      closesAt: snapshot.closesAt,
    })
  })

  it('no avisa antes de la ventana ni después del cierre', async () => {
    const repository = {
      findActiveClosingBetween: jest.fn().mockResolvedValue([]),
      findBidHistory: jest.fn(),
    }
    const publisher = new RecordingPublisher()
    const useCase = new DispatchClosingSoonReminders(repository, publisher, { now: () => NOW })

    await expect(useCase.execute()).resolves.toBe(0)
    expect(repository.findActiveClosingBetween).toHaveBeenCalledWith(
      NOW,
      new Date(NOW.getTime() + 60 * 60 * 1000),
    )
    expect(repository.findBidHistory).not.toHaveBeenCalled()
    expect(publisher.events).toEqual([])
  })
})
