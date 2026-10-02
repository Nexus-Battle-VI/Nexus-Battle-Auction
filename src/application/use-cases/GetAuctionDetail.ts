import type { AuctionDetailSnapshot, AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { BidSnapshot } from '../../domain/entities/Bid'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../errors/ExternalDependencyError'
import type { SellerPublicProfilePort } from '../ports/SellerPublicProfilePort'

export interface GetAuctionDetailLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface AuctionDetail {
  readonly auction: AuctionDetailSnapshot
  readonly currentBid: BidSnapshot | null
  /** Total real de pujas persistidas; no se deriva de `currentBid`. */
  readonly bidCount: number
  /** HU-88. `null` si el vendedor no tiene perfil resoluble o Account no responde. */
  readonly sellerDisplayName: string | null
  readonly sellerAvatarUrl: string | null
}

/**
 * Consulta funcional utilizada por HU-63.6 y extendida por HU-88.
 *
 * La Web necesita conocer el estado de la subasta -PLAYER/CREDITS u oficial
 * GAME_MASTER/REAL_MONEY, en cualquier estado, no solo `ACTIVE`-, el
 * incremento minimo o el precio oficial configurado y la puja lider vigente,
 * sin replicar reglas del dominio en frontend. `findDetailById` no reemplaza
 * `findById`: ese sigue siendo CREDITS-only para la logica de negocio de
 * puja/auto-puja/compra/publicacion/watchlist.
 *
 * HU-88 agrega el perfil publico del vendedor (`sellerDisplayName`/
 * `sellerAvatarUrl`), resuelto contra Account por `auction.sellerId` -el
 * mismo campo sirve para PLAYER y para GAME_MASTER, sin ninguna rama
 * especial: si Account no reconoce ese sujeto, el resultado degrada a
 * `null` igual en ambos casos-. Un fallo de Account (404, 5xx, timeout,
 * contrato invalido) NUNCA debe convertir el detalle en un error: solo esos
 * tres tipos de error externo se capturan aqui; cualquier otro error
 * (del repositorio propio de Auction, por ejemplo) se propaga igual que
 * antes.
 */
export class GetAuctionDetail {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly sellerProfile: SellerPublicProfilePort,
    private readonly logger: GetAuctionDetailLogger,
  ) {}

  async execute(auctionId: string): Promise<AuctionDetail | null> {
    const auction = await this.repository.findDetailById(auctionId)

    if (auction === null) {
      return null
    }

    const [currentBid, bidCount, sellerProfile] = await Promise.all([
      this.repository.findLeadingBid(auctionId),
      this.repository.countBids(auctionId),
      this.resolveSellerProfile(auction.sellerId),
    ])

    return {
      auction,
      currentBid,
      bidCount,
      sellerDisplayName: sellerProfile?.displayName ?? null,
      sellerAvatarUrl: sellerProfile?.avatarUrl ?? null,
    }
  }

  private async resolveSellerProfile(
    sellerId: string,
  ): Promise<{ readonly displayName: string; readonly avatarUrl: string | null } | null> {
    try {
      return await this.sellerProfile.getPublicProfile(sellerId)
    } catch (error: unknown) {
      if (
        error instanceof ExternalResourceNotFoundError ||
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        this.logger.warn('seller_public_profile_degradado', {
          sellerId,
          reason: error.name,
        })
        return null
      }

      throw error
    }
  }
}
