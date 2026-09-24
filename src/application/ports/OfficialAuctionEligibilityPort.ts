export type OfficialAuctionMark = 'OFFICIAL' | 'PREMIUM'

export interface OfficialAuctionEligibility {
  readonly productId: string
  readonly exclusive: boolean
  readonly officialMark: OfficialAuctionMark | null
  readonly publishable: boolean
}

/**
 * Catalog es la unica autoridad de exclusividad y marca oficial (HU-66).
 * Auction no acepta una marca enviada por Web ni la infiere localmente.
 */
export interface OfficialAuctionEligibilityPort {
  getEligibility(productId: string): Promise<OfficialAuctionEligibility>
}

export const OFFICIAL_AUCTION_ELIGIBILITY = Symbol('OfficialAuctionEligibilityPort')
