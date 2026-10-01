import { PriceSortRequiresCreditsError } from '../errors/MarketplaceQueryError'
import type {
  ActiveAuctionFilters,
  ActiveAuctionList,
  ActiveAuctionSort,
  AuctionRepositoryPort,
} from '../ports/AuctionRepositoryPort'
import type { CatalogProductLookupPort } from '../ports/CatalogProductLookupPort'
import type { ClockPort } from '../ports/ClockPort'

export interface ListActiveAuctionsInput {
  readonly page: number
  readonly pageSize: number
  readonly filters?: ActiveAuctionFilters | undefined
  readonly sort?: ActiveAuctionSort | undefined
  /** Subcadena del nombre del producto, ya recortada (1..80). */
  readonly search?: string | undefined
}

const NO_RESULTS: ActiveAuctionList = { items: [], total: 0 }

/** Consulta del marketplace; el limite temporal procede del reloj inyectado. */
export class ListActiveAuctions {
  constructor(
    private readonly auctions: Pick<AuctionRepositoryPort, 'listActive' | 'listActiveProductIds'>,
    private readonly clock: ClockPort,
    private readonly catalog: CatalogProductLookupPort,
  ) {}

  execute(input: ListActiveAuctionsInput): Promise<ActiveAuctionList> {
    const sortsByPrice = input.sort === 'priceAsc' || input.sort === 'priceDesc'
    if (sortsByPrice && input.filters?.priceKind !== 'CREDITS') {
      return Promise.reject(new PriceSortRequiresCreditsError())
    }

    const { search, ...listing } = input
    const now = this.clock.now()
    // Sin busqueda no se consulta Catalog: el listado no depende de su disponibilidad.
    if (search === undefined) {
      return this.auctions.listActive({ ...listing, now })
    }
    return this.listMatching(listing, search, now)
  }

  /**
   * HU-87: universo filtrado -> Catalog (nombre, por bloques) -> productos que
   * coinciden -> mismo listado paginado restringido a esos productos. El total
   * y la paginacion se calculan sobre el resultado de la busqueda, no sobre una
   * pagina ya obtenida.
   */
  private async listMatching(
    listing: Omit<ListActiveAuctionsInput, 'search'>,
    search: string,
    now: Date,
  ): Promise<ActiveAuctionList> {
    const universe = await this.auctions.listActiveProductIds({ now, filters: listing.filters })
    if (universe.length === 0) {
      return NO_RESULTS
    }
    const matching = await this.catalog.findReferencesMatchingName(universe, search)
    if (matching.size === 0) {
      return NO_RESULTS
    }
    return this.auctions.listActive({ ...listing, now, productIds: [...matching] })
  }
}
