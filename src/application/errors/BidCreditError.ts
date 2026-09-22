export class InsufficientBidCreditsError extends Error {
  constructor(
    readonly availableCredits: number,
    readonly requiredCredits: number,
  ) {
    super(
      `Creditos insuficientes para la puja. Disponibles: ${String(
        availableCredits,
      )}; requeridos: ${String(requiredCredits)}.`,
    )

    this.name = 'InsufficientBidCreditsError'
  }
}

export class BidCreditCompensationError extends Error {
  constructor(
    readonly reservationId: string,
    readonly originalError: unknown,
  ) {
    super(`No fue posible liberar la reserva de creditos ${reservationId} durante la compensacion.`)

    this.name = 'BidCreditCompensationError'
  }
}
