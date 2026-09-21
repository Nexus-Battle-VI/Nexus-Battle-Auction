import { ExternalDependencyUnavailableError } from '../../../application/errors/ExternalDependencyError'
import type {
  CommitInventoryProductCommand,
  InventoryProductCommitment,
  InventoryProductEligibility,
  ProductInventoryPort,
} from '../../../application/ports/ProductInventoryPort'
import type {
  ChargePublicationFeeCommand,
  PublicationFeeCharge,
  PublicationFeePort,
} from '../../../application/ports/PublicationFeePort'
import type { SellerSanctionPort } from '../../../application/ports/SellerSanctionPort'

/**
 * Adaptadores deliberadamente cerrados mientras los servicios propietarios no
 * publiquen los contratos requeridos por HU-62. Evitan sustituir una ausencia
 * de evidencia por una respuesta permisiva inventada.
 */
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

  release(operationId: string, commitmentId: string): Promise<void> {
    void operationId
    void commitmentId
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
