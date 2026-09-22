export interface CatalogProductPolicy {
  readonly tradableInAuction: boolean
}

export interface CatalogProductPolicyPort {
  getPolicy(productId: string): Promise<CatalogProductPolicy>
}

export const CATALOG_PRODUCT_POLICY = Symbol('CatalogProductPolicyPort')
