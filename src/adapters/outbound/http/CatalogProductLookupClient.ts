import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  CatalogProductDetails,
  CatalogProductDetailsPort,
} from '../../../application/ports/CatalogProductDetailsPort'
import type {
  CatalogProductLookupPort,
  CatalogProductSuggestion,
} from '../../../application/ports/CatalogProductLookupPort'

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

interface SuggestionItemPayload extends LookupItemPayload {
  readonly name: string
  readonly type: string
}

/**
 * Mismo payload que `lookupItems`, pero exige tambien `name` y `type` (lo que
 * necesita una sugerencia). Un parser separado: `findReferencesMatchingName`
 * no debe empezar a exigir estos campos, que Catalog ya devuelve pero esa
 * ruta nunca uso.
 */
const suggestionItems = (value: unknown): readonly SuggestionItemPayload[] | null => {
  if (typeof value !== 'object' || value === null) return null
  const items = (value as Readonly<Record<string, unknown>>).items
  if (!Array.isArray(items)) return null
  const parsed: SuggestionItemPayload[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null
    const fields = item as Readonly<Record<string, unknown>>
    if (
      typeof fields.productId !== 'string' ||
      typeof fields.sku !== 'string' ||
      typeof fields.name !== 'string' ||
      typeof fields.type !== 'string'
    )
      return null
    parsed.push({
      productId: fields.productId,
      sku: fields.sku,
      name: fields.name,
      type: fields.type,
    })
  }
  return parsed
}

/**
 * Parser estricto para HU-91.3: exige TODOS los campos que el contrato
 * `hu-91.v1` §4.2 expone (`productId`, `sku`, `name`, `type`, `imageUrl`).
 * Si Catalog dejara de devolver alguno, es una ruptura de contrato y no se
 * rellena en silencio: el llamador la trata como enriquecimiento no disponible.
 */
const detailItems = (value: unknown): readonly CatalogProductDetails[] | null => {
  if (typeof value !== 'object' || value === null) return null
  const items = (value as Readonly<Record<string, unknown>>).items
  if (!Array.isArray(items)) return null
  const parsed: CatalogProductDetails[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null
    const fields = item as Readonly<Record<string, unknown>>
    if (
      typeof fields.productId !== 'string' ||
      typeof fields.sku !== 'string' ||
      typeof fields.name !== 'string' ||
      typeof fields.type !== 'string' ||
      typeof fields.imageUrl !== 'string'
    )
      return null
    parsed.push({
      productId: fields.productId,
      sku: fields.sku,
      name: fields.name,
      type: fields.type,
      imageUrl: fields.imageUrl,
    })
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
export class CatalogProductLookupClient
  implements CatalogProductLookupPort, CatalogProductDetailsPort
{
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

  async findSuggestions(
    references: readonly string[],
    nameQuery: string,
  ): Promise<readonly CatalogProductSuggestion[]> {
    const unique = [...new Set(references)]
    const matched = await Promise.all(
      chunksOf(unique, CATALOG_LOOKUP_MAX_REFERENCES).map((chunk) =>
        this.lookupSuggestionsChunk(chunk, nameQuery),
      ),
    )
    // Catalog ordena cada bloque por nombre ascendente (name asc en Mongo); con
    // mas de un bloque (mas de 500 candidatos) se reordena aqui para que el
    // resultado final sea determinista sin importar como se repartieron los
    // bloques.
    return matched.flat().sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * HU-91.3: resuelve productos por referencia SIN filtro de nombre. Una llamada
   * por cada bloque de hasta 500 referencias; las inexistentes se omiten. Un
   * `items` ininteligible o con campos faltantes es `ExternalContractError`.
   */
  async findProducts(references: readonly string[]): Promise<readonly CatalogProductDetails[]> {
    const unique = [...new Set(references)]
    const resolved = await Promise.all(
      chunksOf(unique, CATALOG_LOOKUP_MAX_REFERENCES).map(async (chunk) => {
        const items = detailItems(await this.fetchLookupBody(chunk, undefined))
        if (items === null) {
          throw new ExternalContractError('catalog', 'Catalog devolvio un lookup ininteligible.')
        }
        const requested = new Set(chunk)
        return items.filter((item) => requested.has(item.productId) || requested.has(item.sku))
      }),
    )
    return resolved.flat()
  }

  /** Devuelve las referencias del bloque cuyo producto (por id o SKU) volvio de Catalog. */
  private async lookupChunk(chunk: readonly string[], nameQuery: string): Promise<string[]> {
    const body = await this.fetchLookupBody(chunk, nameQuery)
    const items = lookupItems(body)
    if (items === null) {
      throw new ExternalContractError('catalog', 'Catalog devolvio un lookup ininteligible.')
    }

    const returned = new Set(items.flatMap((item) => [item.productId, item.sku]))
    return chunk.filter((reference) => returned.has(reference))
  }

  /** Igual que `lookupChunk`, pero conserva `name`/`type` para sugerencias. */
  private async lookupSuggestionsChunk(
    chunk: readonly string[],
    nameQuery: string,
  ): Promise<CatalogProductSuggestion[]> {
    const body = await this.fetchLookupBody(chunk, nameQuery)
    const items = suggestionItems(body)
    if (items === null) {
      throw new ExternalContractError('catalog', 'Catalog devolvio un lookup ininteligible.')
    }

    const requested = new Set(chunk)
    return items
      .filter((item) => requested.has(item.productId) || requested.has(item.sku))
      .map((item) => ({ productId: item.productId, name: item.name, type: item.type }))
  }

  /** POST al lookup publico de Catalog; traduce fallos de red, HTTP y JSON a dependencia no disponible. */
  private async fetchLookupBody(
    chunk: readonly string[],
    nameQuery: string | undefined,
  ): Promise<unknown> {
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
          body: JSON.stringify(
            nameQuery === undefined
              ? { references: chunk }
              : { references: chunk, query: nameQuery },
          ),
          signal: controller.signal,
        },
      )

      if (!response.ok) {
        this.options.logger.warn('catalog_product_lookup_respuesta_no_ok', {
          status: response.status,
        })
        throw new ExternalDependencyUnavailableError('catalog')
      }

      return await response.json()
    } catch (error: unknown) {
      if (error instanceof ExternalDependencyUnavailableError) {
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
