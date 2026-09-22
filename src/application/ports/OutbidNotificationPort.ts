export interface OutbidNotification {
  /**
   * Identificador estable de la notificacion.
   *
   * Se deriva del Idempotency-Key de la puja para que un
   * reintento no produzca dos notificaciones distintas.
   */
  readonly notificationId: string

  /**
   * OperationId de la puja que desplazo al lider anterior.
   */
  readonly operationId: string

  /**
   * Identificador estable del jugador desplazado.
   */
  readonly recipientPlayerId: string

  readonly auctionId: string

  /**
   * Puja que perdio el liderazgo.
   */
  readonly outbidBidId: string

  /**
   * Nueva puja lider.
   */
  readonly winningBidId: string

  readonly winningBidderId: string

  readonly winningAmountCredits: number

  readonly occurredAt: Date
}

/**
 * Puerto de salida para entregar una notificacion de
 * puja superada.
 *
 * La aplicacion no conoce HTTP ni detalles de Notifications.
 */
export interface OutbidNotificationPort {
  publish(notification: OutbidNotification): Promise<void>
}

export const OUTBID_NOTIFICATION = Symbol('OutbidNotificationPort')
