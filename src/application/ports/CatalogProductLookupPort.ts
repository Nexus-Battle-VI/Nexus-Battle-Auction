/**
 * Dato minimo de un producto para una sugerencia de autocomplete (HU-87.2).
 * Deliberadamente NO es el DTO externo de Catalog (que tambien trae precio,
 * atributos, stock, etc.): el puerto solo expone lo que Web necesita para
 * mostrar una sugerencia.
 */
export interface CatalogProductSuggestion {
  readonly productId: string
  readonly name: string
  readonly type: string
}

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

  /**
   * HU-87.2: sugerencias de autocomplete. Devuelve, para las referencias que
   * coinciden con `nameQuery`, el dato minimo que necesita Web (productId,
   * name, type). Mismo endpoint de lookup que `findReferencesMatchingName`,
   * pero sin descartar `name`/`type`. Orden: el que documenta el adaptador
   * (name ascendente, el mismo criterio de Catalog).
   */
  findSuggestions(
    references: readonly string[],
    nameQuery: string,
  ): Promise<readonly CatalogProductSuggestion[]>
}

export const CATALOG_PRODUCT_LOOKUP = Symbol('CatalogProductLookupPort')
