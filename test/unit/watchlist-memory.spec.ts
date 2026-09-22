import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryWatchlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWatchlistRepository'
import { watchlistContract } from '../support/watchlist-contract'
import { watchlistAuction } from '../support/watchlist-auction'

/** Doble que conserva las restricciones observables del repositorio persistente. */
describe('Watchlist en memoria', () => {
  let repository: InMemoryWatchlistRepository
  beforeEach(async () => {
    const auctions = new InMemoryAuctionRepository()
    await auctions.publish(watchlistAuction('auction-1'))
    await auctions.publish(watchlistAuction('auction-2'))
    repository = new InMemoryWatchlistRepository(auctions)
  })
  watchlistContract(() => repository)
})
