import type {
  CatalogProductLookupPort,
  CatalogProductSuggestion,
} from '../../src/application/ports/CatalogProductLookupPort'

export class FakeCatalogProductLookup implements CatalogProductLookupPort {
  readonly calls: { references: readonly string[]; query: string }[] = []
  readonly suggestionCalls: { references: readonly string[]; query: string }[] = []
  matching: ReadonlySet<string> = new Set()
  suggestions: readonly CatalogProductSuggestion[] = []
  error: Error | undefined

  findReferencesMatchingName(
    references: readonly string[],
    query: string,
  ): Promise<ReadonlySet<string>> {
    this.calls.push({ references: [...references], query })
    if (this.error !== undefined) return Promise.reject(this.error)
    return Promise.resolve(this.matching)
  }

  findSuggestions(
    references: readonly string[],
    query: string,
  ): Promise<readonly CatalogProductSuggestion[]> {
    this.suggestionCalls.push({ references: [...references], query })
    if (this.error !== undefined) return Promise.reject(this.error)
    return Promise.resolve(this.suggestions)
  }
}
