/**
 * Puerto hacia el bounded context Wallet (HU-64).
 *
 * La transferencia de creditos de una compra inmediata es una unica operacion
 * atomica del lado de Wallet -debita al comprador y acredita al vendedor a la
 * vez-, no dos llamadas independientes: Auction no tiene forma de garantizar
 * atomicidad sobre un ledger que no le pertenece.
 */
export interface BuyNowCreditTransferCommand {
  readonly operationId: string
  readonly buyerId: string
  readonly sellerId: string
  readonly amount: number
}

export interface BuyNowCreditTransfer {
  readonly transferId: string
}

export interface WalletPort {
  /** Saldo de creditos disponibles del comprador, ya resuelto por Wallet. */
  getAvailableCredits(buyerId: string): Promise<number>

  transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer>

  /** Compensa una transferencia ya aplicada cuando un paso posterior falla. */
  reverseBuyNowCredits(operationId: string, transferId: string): Promise<void>
}

export const WALLET = Symbol('WalletPort')
