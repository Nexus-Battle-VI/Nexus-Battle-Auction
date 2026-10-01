import type { ActiveAuctionFilters, AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type {
  CatalogProductLookupPort,
  CatalogProductSuggestion,
} from '../ports/CatalogProductLookupPort'
import type { ClockPort } from '../ports/ClockPort'

export interface GetAuctionSuggestionsInput {
  /** Ya recortado y validado (3..80) por el DTO de entrada. */
  readonly q: string
  readonly limit: number
  readonly filters?: ActiveAuctionFilters | undefined
}

export interface AuctionSuggestion {
  readonly productId: string
  readonly name: string
  readonly type: string
}

export interface AuctionSuggestionList {
  readonly items: readonly AuctionSuggestion[]
}

const NO_SUGGESTIONS: AuctionSuggestionList = { items: [] }

/**
 * HU-87.2: sugerencias de autocomplete para el marketplace.
 *
 * Mismo universo que el marketplace (subastas activas no vencidas que
 * cumplen los filtros), restringido a lo que Catalog reconoce por nombre.
 * A diferencia de `ListActiveAuctions`, nunca pagina ni ordena por otro
 * criterio que el de Catalog: solo recorta a `limit`.
 */
export class GetAuctionSuggestions {
  constructor(
    private readonly auctions: Pick<AuctionRepositoryPort, 'listActiveProductIds'>,
    private readonly clock: ClockPort,
    private readonly catalog: CatalogProductLookupPort,
  ) {}

  async execute(input: GetAuctionSuggestionsInput): Promise<AuctionSuggestionList> {
    const now = this.clock.now()
    const universe = await this.auctions.listActiveProductIds({ now, filters: input.filters })
    // Sin candidatos no hay nada que preguntarle a Catalog.
    if (universe.length === 0) {
      return NO_SUGGESTIONS
    }

    const matches = await this.catalog.findSuggestions(universe, input.q)
    if (matches.length === 0) {
      return NO_SUGGESTIONS
    }

    const deduped = dedupeByProductId(matches)
    return {
      items: deduped.slice(0, input.limit).map((match) => ({
        productId: match.productId,
        name: match.name,
        type: match.type,
      })),
    }
  }
}

/**
 * Defensivo: una sola subasta activa por producto hace improbable un
 * duplicado, pero la respuesta nunca debe filtrar uno si esa invariante
 * cambiara.
 */
const dedupeByProductId = (
  items: readonly CatalogProductSuggestion[],
): CatalogProductSuggestion[] => {
  const seen = new Set<string>()
  const result: CatalogProductSuggestion[] = []
  for (const item of items) {
    if (seen.has(item.productId)) continue
    seen.add(item.productId)
    result.push(item)
  }
  return result
}
