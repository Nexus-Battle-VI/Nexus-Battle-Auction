export interface AuctionViewStatisticsUnavailable {
  readonly availability: 'UNAVAILABLE'
  readonly reason: 'AUTHORITATIVE_SOURCE_NOT_CONFIGURED'
  readonly metrics: readonly []
}

/**
 * Contrato explicito de TASK 89.3 mientras no exista almacenamiento aprobado
 * de visualizaciones. Nunca convierte ausencia de datos en un contador cero.
 */
export class GetMyAuctionViewStatistics {
  execute(): AuctionViewStatisticsUnavailable {
    return {
      availability: 'UNAVAILABLE',
      reason: 'AUTHORITATIVE_SOURCE_NOT_CONFIGURED',
      metrics: [],
    }
  }
}
