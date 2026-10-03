export interface ChargePublicationFeeCommand {
  readonly operationId: string
  readonly sellerId: string
  readonly amount: number
}

export interface PublicationFeeCharge {
  readonly chargeId: string
}

export interface PublicationFeePort {
  charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge>
  /**
   * HU-90: `amount` es obligatorio porque ya no existe un refund implicito
   * "total" para quien cancela -la penalizacion retiene el 50%, se reembolsa
   * el otro 50%-. No hay llamador previo a este PR que dependa de un refund
   * sin monto (ver auditoria: `refund()` no se invocaba desde ningun lado).
   */
  refund(operationId: string, chargeId: string, amount: number): Promise<void>
}

export const PUBLICATION_FEE = Symbol('PublicationFeePort')

/** HU-90: operationId determinista del refund del 50% al cancelar. */
export const walletCancellationRefundOperationId = (auctionId: string): string =>
  `auction:${auctionId}:cancellation:wallet-refund`
