/**
 * Datos de producto que Auction toma de Catalog para ENRIQUECER sus metricas
 * (HU-91.3, contrato `hu-91.v1` §4.2). Son exactamente los campos que existen
 * en el DTO canonico de Catalog: no hay `brand` ni `category` (esa solo existe
 * en el modelo legado).
 */
export interface CatalogProductDetails {
  readonly productId: string
  readonly sku: string
  readonly name: string
  /** `HEROE`, `HABILIDAD`, `ARMA`, `ARMADURA`, `ITEM` o `EPICA`. */
  readonly type: string
  readonly imageUrl: string
}

/**
 * Resolucion en bloque de productos por referencia (`productId` UUID o `sku`).
 *
 * Catalog es la fuente autoritativa del nombre; Auction solo conserva
 * `product_id`. Las referencias que Catalog no conoce se OMITEN del resultado
 * (no son un error). Un fallo de red, HTTP o de contrato se propaga como
 * `ExternalDependencyUnavailableError` / `ExternalContractError`.
 */
export interface CatalogProductDetailsPort {
  findProducts(references: readonly string[]): Promise<readonly CatalogProductDetails[]>
}

export const CATALOG_PRODUCT_DETAILS = Symbol('CatalogProductDetailsPort')
