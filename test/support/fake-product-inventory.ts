import type {
  ClaimedInventoryProductCommitment,
  ConfirmInventoryProductClaimCommand,
  InventoryProductCommitment,
  InventoryProductEligibility,
  MarkInventoryProductPendingClaimCommand,
  PendingClaimInventoryProductCommitment,
  ProductInventoryPort,
  ReleasedInventoryProductCommitment,
  ReleaseInventoryProductCommand,
} from '../../src/application/ports/ProductInventoryPort'

/**
 * Doble de `ProductInventoryPort` para pruebas de compra inmediata (HU-64):
 * confirma cualquier `markPendingClaim` de inmediato, y hace fallar todo lo
 * demas -commit, release, confirmClaim- porque ninguna prueba de compra
 * inmediata deberia necesitarlos.
 */
export class FakeProductInventory implements ProductInventoryPort {
  readonly markPendingClaim = jest.fn(
    (
      command: MarkInventoryProductPendingClaimCommand,
    ): Promise<PendingClaimInventoryProductCommitment> =>
      Promise.resolve({
        operationId: command.operationId,
        commitmentId: command.commitmentId,
        status: 'PENDING_CLAIM',
        winnerId: command.winnerId,
        applied: true,
      }),
  )

  inspect(): Promise<InventoryProductEligibility> {
    return Promise.resolve({ ownedByPlayer: true, inUse: false })
  }

  commit(): Promise<InventoryProductCommitment> {
    return Promise.reject(new Error('No debe invocarse commit durante compra inmediata.'))
  }

  release(command: ReleaseInventoryProductCommand): Promise<ReleasedInventoryProductCommitment> {
    void command
    return Promise.reject(new Error('No debe invocarse release durante compra inmediata.'))
  }

  confirmClaim(command: ConfirmInventoryProductClaimCommand): Promise<ClaimedInventoryProductCommitment> {
    void command
    return Promise.reject(new Error('No debe invocarse confirmClaim durante compra inmediata.'))
  }
}
