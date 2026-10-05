export type AuctionMetricsErrorCode = 'INVALID_PERIOD' | 'INVALID_PARAMETER'

/** Consulta de metricas con periodo o parametro fuera del contrato `hu-91.v1`. */
export class AuctionMetricsQueryError extends Error {
  constructor(
    readonly code: AuctionMetricsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuctionMetricsQueryError'
  }
}
