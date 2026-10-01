import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type { CatalogProductLookupPort } from '../../../application/ports/CatalogProductLookupPort'

/** Limite de `references` por llamada de `POST /api/v1/catalog/products/lookup`. */
export const CATALOG_LOOKUP_MAX_REFERENCES = 500

export interface CatalogProductLookupClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface CatalogProductLookupClientOptions {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly logger: CatalogProductLookupClientLogger
  readonly fetchImpl?: typeof fetch
}

interface LookupItemPayload {
  readonly productId: string
  readonly sku: string
}

const lookupItems = (value: unknown): readonly LookupItemPayload[] | null => {
  if (typeof value !== 'object' || value === null) return null
  const items = (value as Readonly<Record<string, unknown>>).items
  if (!Array.isArray(items)) return null
  const parsed: LookupItemPayload[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null
    const fields = item as Readonly<Record<string, unknown>>
    if (typeof fields.productId !== 'string' || typeof fields.sku !== 'string') return null
    parsed.push({ productId: fields.productId, sku: fields.sku })
  }
  return parsed
}

const chunksOf = <T>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size))
  }
  return chunks
}

/**
 * Cliente del lookup publico de Catalog (`POST /api/v1/catalog/products/lookup`,
 * el mismo que usa Player/Inventory en HU-27). No lleva firma interna porque el
 * endpoint es publico. Una llamada por cada bloque de hasta 500 referencias;
 * sin reintentos: un fallo hace que la busqueda no pueda resolverse.
 */
export class CatalogProductLookupClient implements CatalogProductLookupPort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: CatalogProductLookupClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async findReferencesMatchingName(
    references: readonly string[],
    nameQuery: string,
  ): Promise<ReadonlySet<string>> {
    const unique = [...new Set(references)]
    const matched = await Promise.all(
      chunksOf(unique, CATALOG_LOOKUP_MAX_REFERENCES).map((chunk) =>
        this.lookupChunk(chunk, nameQuery),
      ),
    )
    return new Set(matched.flat())
  }

  /** Devuelve las referencias del bloque cuyo producto (por id o SKU) volvio de Catalog. */
  private async lookupChunk(chunk: readonly string[], nameQuery: string): Promise<string[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/+$/, '')}/api/v1/catalog/products/lookup`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ references: chunk, query: nameQuery }),
          signal: controller.signal,
        },
      )

      if (!response.ok) {
        this.options.logger.warn('catalog_product_lookup_respuesta_no_ok', {
          status: response.status,
        })
        throw new ExternalDependencyUnavailableError('catalog')
      }

      const items = lookupItems(await response.json())
      if (items === null) {
        throw new ExternalContractError('catalog', 'Catalog devolvio un lookup ininteligible.')
      }

      const returned = new Set(items.flatMap((item) => [item.productId, item.sku]))
      return chunk.filter((reference) => returned.has(reference))
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }

      this.options.logger.warn('catalog_product_lookup_no_disponible', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('catalog')
    } finally {
      clearTimeout(timer)
    }
  }
}
