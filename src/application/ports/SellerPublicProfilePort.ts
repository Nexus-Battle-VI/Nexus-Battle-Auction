/**
 * Perfil publico minimo del vendedor para HU-88.
 *
 * Mapea el contrato interno de Account (`GET /internal/accounts/:subject/battle-profile`)
 * a un tipo propio de Auction: el dominio de Auction no conoce el DTO externo
 * completo de Account, solo lo que necesita para enriquecer su propio detalle.
 */
export interface SellerPublicProfile {
  readonly subject: string
  readonly displayName: string
  readonly avatarUrl: string | null
}

export interface SellerPublicProfilePort {
  getPublicProfile(subject: string): Promise<SellerPublicProfile>
}

export const SELLER_PUBLIC_PROFILE = Symbol('SellerPublicProfilePort')
