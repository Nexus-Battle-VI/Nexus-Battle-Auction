import type { AuctionSnapshot } from '../../domain/entities/Auction'

/** Resultado publico de seguimiento; la identidad del propietario no se recibe del cliente. */
export interface WatchlistDto {
  readonly auctionId: string
  readonly followedAt: Date
}

/** Lectura enriquecida con el snapshot vigente de Auction, sin datos de cobro/inventario. */
export interface FollowedAuctionDto extends WatchlistDto {
  readonly auction: AuctionSnapshot
}

export interface FollowedAuctionsDto {
  readonly items: readonly FollowedAuctionDto[]
}
