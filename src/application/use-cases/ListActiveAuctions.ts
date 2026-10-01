import { PriceSortRequiresCreditsError } from '../errors/MarketplaceQueryError'
import type {
  ActiveAuctionFilters,
  ActiveAuctionList,
  ActiveAuctionSort,
  AuctionRepositoryPort,
} from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

export interface ListActiveAuctionsInput {
  readonly page: number
  readonly pageSize: number
  readonly filters?: ActiveAuctionFilters | undefined
  readonly sort?: ActiveAuctionSort | undefined
}

/** Consulta del marketplace; el limite temporal procede del reloj inyectado. */
export class ListActiveAuctions {
  constructor(
    private readonly auctions: Pick<AuctionRepositoryPort, 'listActive'>,
    private readonly clock: ClockPort,
  ) {}

  execute(input: ListActiveAuctionsInput): Promise<ActiveAuctionList> {
    const sortsByPrice = input.sort === 'priceAsc' || input.sort === 'priceDesc'
    if (sortsByPrice && input.filters?.priceKind !== 'CREDITS') {
      return Promise.reject(new PriceSortRequiresCreditsError())
    }

    return this.auctions.listActive({ ...input, now: this.clock.now() })
  }
}
