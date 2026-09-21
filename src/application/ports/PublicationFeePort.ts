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
  refund(operationId: string, chargeId: string): Promise<void>
}

export const PUBLICATION_FEE = Symbol('PublicationFeePort')
