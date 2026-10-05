import type { AuctionStatus } from '../../domain/entities/Auction'

export interface PersonalPageInput {
  readonly playerId: string
  readonly page: number
  readonly pageSize: number
}

export interface OwnedAuctionPageInput extends PersonalPageInput {
  readonly now: Date
}

export interface PersonalAuctionItem {
  readonly auctionId: string
  readonly productId: string
  readonly status: AuctionStatus
  readonly minimumBidCredits: number
  readonly buyNowCredits: number | null
  readonly currentBidCredits: number | null
  readonly bidCount: number
  readonly publishedAt: Date
  readonly closesAt: Date
  readonly finishedAt: Date | null
  readonly cancelledAt: Date | null
  readonly actions: {
    readonly view: true
    /** Indicacion informativa; el endpoint de HU-90 vuelve a validar todas las reglas. */
    readonly cancel: boolean
  }
}

export interface PersonalAuctionPage {
  readonly items: readonly PersonalAuctionItem[]
  readonly total: number
}

export type BidParticipationStatus = 'LEADING' | 'OUTBID' | 'WON' | 'LOST'

export interface PersonalBidItem {
  readonly auctionId: string
  readonly productId: string
  readonly auctionStatus: AuctionStatus
  readonly participationStatus: BidParticipationStatus
  readonly ownLatestBidCredits: number
  readonly ownLatestBidAt: Date
  readonly currentBidCredits: number | null
  readonly closesAt: Date
}

export interface PersonalBidPage {
  readonly items: readonly PersonalBidItem[]
  readonly total: number
}

export type AuctionTransactionType =
  | 'PUBLICATION_FEE'
  | 'BID_RESERVATION'
  | 'BUY_NOW_PURCHASE'
  | 'SETTLEMENT_SALE'
  | 'SETTLEMENT_WIN'
  | 'CANCELLATION_REFUND'
  | 'PRODUCT_CLAIM'

export interface PersonalAuctionTransaction {
  readonly id: string
  readonly auctionId: string
  readonly type: AuctionTransactionType
  readonly reference: string
  readonly occurredAt: Date
  readonly status: string
  readonly value: {
    readonly amount: number
    readonly unit: 'CREDITS'
  } | null
}

export interface PersonalTransactionPage {
  readonly items: readonly PersonalAuctionTransaction[]
  readonly total: number
}

/** Puerto de lectura privado de HU-89. Toda consulta exige la identidad ya verificada. */
export interface AuctionActivityRepositoryPort {
  listOwnedAuctions(input: OwnedAuctionPageInput): Promise<PersonalAuctionPage>
  listBidParticipations(input: PersonalPageInput): Promise<PersonalBidPage>
  listTransactions(input: PersonalPageInput): Promise<PersonalTransactionPage>
}

export const AUCTION_ACTIVITY_REPOSITORY = Symbol('AuctionActivityRepositoryPort')
