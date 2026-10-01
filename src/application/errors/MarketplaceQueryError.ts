/**
 * `priceAsc`/`priceDesc` ordenan por el precio actual en creditos. Mezclar
 * creditos con dinero real (y monedas distintas entre si) no da un orden con
 * sentido, asi que el orden por precio exige `priceKind=CREDITS`.
 */
export class PriceSortRequiresCreditsError extends Error {
  constructor() {
    super('El orden por precio solo es valido junto con priceKind=CREDITS.')
    this.name = 'PriceSortRequiresCreditsError'
  }
}
