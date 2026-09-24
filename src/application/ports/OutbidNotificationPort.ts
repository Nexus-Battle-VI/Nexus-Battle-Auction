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

export interface AutoBidLimitReachedNotification {
  /**
   * Identificador estable de la notificacion.
   *
   * Se deriva del operationId de la puja rival y del jugador afectado
   * para que un reintento de la misma cadena de reaccion no produzca
   * dos notificaciones distintas.
   */
  readonly notificationId: string

  /**
   * OperationId de la puja original que origino la cadena de reaccion
   * (HU-67.2), no de una puja automatica individual: el jugador nunca
   * llego a pujar.
   */
  readonly operationId: string

  /**
   * Identificador estable del jugador cuya puja automatica ya no puede
   * seguir reaccionando.
   */
  readonly recipientPlayerId: string

  readonly auctionId: string

  /** Limite maximo configurado por el jugador (HU-67.1). */
  readonly autoBidLimitCredits: number

  /** Oferta que el jugador necesitaria igualar o superar para seguir liderando. */
  readonly requiredAmountCredits: number

  /** Postor que actualmente lidera y que el jugador ya no puede superar. */
  readonly leadingBidderId: string

  readonly occurredAt: Date
}

/**
 * Puerto de salida para entregar notificaciones relacionadas con pujas.
 *
 * La aplicacion no conoce HTTP ni detalles de Notifications.
 */
export interface OutbidNotificationPort {
  publish(notification: OutbidNotification): Promise<void>

  /** HU-67.3: el jugador alcanzo su limite de puja automatica sin ganar. */
  publishAutoBidLimitReached(notification: AutoBidLimitReachedNotification): Promise<void>
}

export const OUTBID_NOTIFICATION = Symbol('OutbidNotificationPort')
