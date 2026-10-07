import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../errors/ExternalDependencyError'
import type { AuctionMetricsRepositoryPort } from '../ports/AuctionMetricsRepositoryPort'
import type {
  CatalogProductDetails,
  CatalogProductDetailsPort,
} from '../ports/CatalogProductDetailsPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  periodEnvelope,
  resolveLimit,
  resolveMetricsPeriod,
} from '../services/auction-metrics-period'

export interface ProductRankingsQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly limit?: string | undefined
}

/** Campos EXACTOS del DTO canonico de Catalog que el contrato §4.2 expone. No hay `brand`. */
export interface RankedProductInfo {
  readonly name: string
  readonly sku: string
  readonly type: string
  readonly imageUrl: string
}

export type EnrichmentStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'

export interface MostAuctionedItem {
  readonly rank: number
  readonly productId: string
  readonly product: RankedProductInfo | null
  readonly auctions: {
    readonly total: number
    readonly playerCredits: number
    readonly officialRealMoney: number
  }
}

export interface MostSoldItem {
  readonly rank: number
  readonly productId: string
  readonly product: RankedProductInfo | null
  readonly sales: {
    readonly total: number
    readonly byAuctionClose: number
    readonly byBuyNow: number
    readonly unit: 'CREDITS'
  }
}

export interface ProductRankingsResponse {
  readonly definitionsVersion: string
  readonly period: ReturnType<typeof periodEnvelope>['period']
  readonly asOf: string
  readonly limit: number
  readonly enrichment: {
    readonly source: 'catalog:POST /api/v1/catalog/products/lookup'
    readonly status: EnrichmentStatus
  }
  readonly mostAuctioned: readonly MostAuctionedItem[]
  readonly mostSold: readonly MostSoldItem[]
}

const ENRICHMENT_SOURCE = 'catalog:POST /api/v1/catalog/products/lookup' as const

/**
 * HU-91.3 / CA-02. Ranking de productos mas subastados y mas vendidos
 * (contrato `hu-91.v1` §3.4 y §4.2).
 *
 * El CONTEO es autoritativo de Auction y se calcula sobre `auctions` sin unir
 * contra `auction_bids`: una fila por subasta, de modo que ni los reintentos
 * idempotentes ni las pujas multiplican nada (§5). El NOMBRE es enriquecimiento
 * de Catalog y NO puede hacer fallar el endpoint:
 *
 * - Catalog responde y conoce todos los productos -> `COMPLETE`.
 * - Catalog responde pero omite algun `productId` (el lookup omite los
 *   inexistentes en vez de fallar) -> `PARTIAL`, `product: null` solo en esos items.
 * - Catalog no responde o rompe su contrato -> `UNAVAILABLE`, `product: null` en todos.
 *
 * Solo se capturan los fallos de dependencia externa: cualquier otro error es
 * un defecto propio y se propaga en vez de esconderse como "Catalog caido".
 */
export class GetAuctionProductRankings {
  constructor(
    private readonly repository: AuctionMetricsRepositoryPort,
    private readonly catalog: CatalogProductDetailsPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(query: ProductRankingsQuery): Promise<ProductRankingsResponse> {
    const asOf = this.clock.now()
    const period = resolveMetricsPeriod(query, asOf)
    const limit = resolveLimit(query.limit)

    const { mostAuctioned, mostSold } = await this.repository.getProductRankings(period, limit)

    const productIds = [...new Set([...mostAuctioned, ...mostSold].map((entry) => entry.productId))]
    const enrichment = await this.enrich(productIds)

    return {
      ...periodEnvelope(period, asOf),
      limit,
      enrichment: { source: ENRICHMENT_SOURCE, status: enrichment.status },
      mostAuctioned: mostAuctioned.map((entry, index) => ({
        rank: index + 1,
        productId: entry.productId,
        product: enrichment.productOf(entry.productId),
        auctions: {
          total: entry.total,
          playerCredits: entry.playerCredits,
          officialRealMoney: entry.officialRealMoney,
        },
      })),
      mostSold: mostSold.map((entry, index) => ({
        rank: index + 1,
        productId: entry.productId,
        product: enrichment.productOf(entry.productId),
        sales: {
          total: entry.total,
          byAuctionClose: entry.byAuctionClose,
          byBuyNow: entry.byBuyNow,
          unit: 'CREDITS',
        },
      })),
    }
  }

  private async enrich(productIds: readonly string[]): Promise<{
    readonly status: EnrichmentStatus
    readonly productOf: (productId: string) => RankedProductInfo | null
  }> {
    // Sin productos que nombrar no hay nada que pedir: Catalog no se consulta.
    if (productIds.length === 0) return { status: 'COMPLETE', productOf: () => null }

    let found: readonly CatalogProductDetails[]
    try {
      found = await this.catalog.findProducts(productIds)
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        return { status: 'UNAVAILABLE', productOf: () => null }
      }
      throw error
    }

    // Catalog resuelve cada referencia por `productId` o por su alias `sku`.
    const byReference = new Map<string, RankedProductInfo>()
    for (const item of found) {
      const info: RankedProductInfo = {
        name: item.name,
        sku: item.sku,
        type: item.type,
        imageUrl: item.imageUrl,
      }
      byReference.set(item.productId, info)
      byReference.set(item.sku, info)
    }

    const complete = productIds.every((productId) => byReference.has(productId))
    return {
      status: complete ? 'COMPLETE' : 'PARTIAL',
      productOf: (productId) => byReference.get(productId) ?? null,
    }
  }
}
