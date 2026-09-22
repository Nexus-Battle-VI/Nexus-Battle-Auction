export interface SellerSanctionPort {
  hasActiveSanctions(sellerId: string): Promise<boolean>
}

export const SELLER_SANCTIONS = Symbol('SellerSanctionPort')
