/**
 * Busqueda por nombre de producto restringida a un conjunto de referencias
 * (HU-87). Catalog es la fuente autoritativa del nombre: Auction solo conserva
 * `product_id` y le pregunta cuales de sus referencias coinciden.
 */
export interface CatalogProductLookupPort {
  /**
   * Devuelve las referencias recibidas (tal como se enviaron) cuyo producto
   * coincide con `nameQuery`. Acepta cualquier cantidad de referencias; el
   * adaptador respeta el limite por llamada de Catalog.
   */
  findReferencesMatchingName(
    references: readonly string[],
    nameQuery: string,
  ): Promise<ReadonlySet<string>>
}

export const CATALOG_PRODUCT_LOOKUP = Symbol('CatalogProductLookupPort')
