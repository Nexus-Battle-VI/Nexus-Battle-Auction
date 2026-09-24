import { ExternalDependencyUnavailableError } from '../../../application/errors/ExternalDependencyError'
import type { BidCreditsPort } from '../../../application/ports/BidCreditsPort'
import type {
  CatalogProductPolicy,
  CatalogProductPolicyPort,
} from '../../../application/ports/CatalogProductPolicyPort'
import type {
  OfficialAuctionEligibility,
  OfficialAuctionEligibilityPort,
} from '../../../application/ports/OfficialAuctionEligibilityPort'
import type {
  ClaimedInventoryProductCommitment,
  CommitInventoryProductCommand,
  ConfirmInventoryProductClaimCommand,
  InventoryProductCommitment,
  InventoryProductEligibility,
  MarkInventoryProductPendingClaimCommand,
  PendingClaimInventoryProductCommitment,
  ProductInventoryPort,
  ReleasedInventoryProductCommitment,
  ReleaseInventoryProductCommand,
} from '../../../application/ports/ProductInventoryPort'
import type {
  ChargePublicationFeeCommand,
  PublicationFeeCharge,
  PublicationFeePort,
} from '../../../application/ports/PublicationFeePort'
import type {
  NotificationDispatch,
  NotificationPort,
  NotifyAuctionClosedEarlyCommand,
} from '../../../application/ports/NotificationPort'
import type { SellerSanctionPort } from '../../../application/ports/SellerSanctionPort'
import type {
  BuyNowCreditTransfer,
  BuyNowCreditTransferCommand,
  WalletPort,
} from '../../../application/ports/WalletPort'

/**
 * Adaptadores deliberadamente cerrados mientras los servicios propietarios no
 * publiquen los contratos requeridos por HU-62. Evitan sustituir una ausencia
 * de evidencia por una respuesta permisiva inventada.
 */
export class UnavailableCatalogProductPolicy implements CatalogProductPolicyPort {
  getPolicy(productId: string): Promise<CatalogProductPolicy> {
    void productId
    return Promise.reject(new ExternalDependencyUnavailableError('catalog'))
  }
}

export class UnavailableOfficialAuctionEligibility implements OfficialAuctionEligibilityPort {
  getEligibility(productId: string): Promise<OfficialAuctionEligibility> {
    void productId
    return Promise.reject(new ExternalDependencyUnavailableError('catalog'))
  }
}

export class UnavailableProductInventory implements ProductInventoryPort {
  inspect(ownerId: string, productId: string): Promise<InventoryProductEligibility> {
    void ownerId
    void productId
    return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
  }

  commit(command: CommitInventoryProductCommand): Promise<InventoryProductCommitment> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
  }

  release(command: ReleaseInventoryProductCommand): Promise<ReleasedInventoryProductCommitment> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
  }

  markPendingClaim(
    command: MarkInventoryProductPendingClaimCommand,
  ): Promise<PendingClaimInventoryProductCommitment> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
  }

  confirmClaim(
    command: ConfirmInventoryProductClaimCommand,
  ): Promise<ClaimedInventoryProductCommitment> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
  }
}

export class UnavailablePublicationFee implements PublicationFeePort {
  charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }

  refund(operationId: string, chargeId: string): Promise<void> {
    void operationId
    void chargeId
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }
}

export class UnavailableSellerSanctions implements SellerSanctionPort {
  hasActiveSanctions(sellerId: string): Promise<boolean> {
    void sellerId
    return Promise.reject(new ExternalDependencyUnavailableError('account'))
  }
}

export class UnavailableBidCredits implements BidCreditsPort {
  getAvailableCredits(bidderId: string): Promise<{ readonly availableCredits: number }> {
    void bidderId
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }

  reserve(command: {
    readonly operationId: string
    readonly bidderId: string
    readonly bidId: string
    readonly auctionId: string
    readonly amount: number
    readonly expiresAt: Date
  }): Promise<{ readonly reservationId: string }> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }

  release(operationId: string, reservationId: string): Promise<void> {
    void operationId
    void reservationId
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }
}

/**
 * Wallet (HU-64) todavia no publica ningun contrato HTTP de negocio: solo
 * andamiaje. Fallar cerrado evita simular un saldo o una transferencia que
 * nadie respalda.
 */
export class UnavailableWallet implements WalletPort {
  getAvailableCredits(buyerId: string): Promise<number> {
    void buyerId
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }

  transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }

  reverseBuyNowCredits(operationId: string, transferId: string): Promise<void> {
    void operationId
    void transferId
    return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
  }
}

/**
 * Notifications no tiene, hoy, ningun endpoint para el cierre anticipado por
 * compra inmediata (HU-64.5) -a diferencia de la puja superada, HU-63.5, que
 * si publico el suyo-. Fallar cerrado evita simular una entrega que nadie
 * realizo.
 */
export class UnavailableEarlyClosureNotification implements NotificationPort {
  notifyAuctionClosedEarly(
    command: NotifyAuctionClosedEarlyCommand,
  ): Promise<NotificationDispatch> {
    void command
    return Promise.reject(new ExternalDependencyUnavailableError('notifications'))
  }
}
