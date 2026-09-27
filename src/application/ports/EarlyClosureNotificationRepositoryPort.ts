export type EarlyClosureNotificationStatus = 'PENDING' | 'SENT' | 'FAILED'

export interface EarlyClosureNotificationKey {
  readonly auctionId: string
  readonly bidderId: string
  readonly transactionId: string
}

export interface EnsurePendingNotificationInput extends EarlyClosureNotificationKey {
  readonly bidId: string
  readonly amountCredits: number
  readonly closedAt: Date

  /**
   * Identifican la reserva de creditos de ESTA puja en Wallet (HU-63.2), solo
   * cuando la puja segue siendo la lider al momento del cierre: es la unica
   * que todavia tiene creditos retenidos -toda puja desplazada ya libero los
   * suyos en tiempo real, vease `RegisterBid`-. `null` en ambos cuando no hay
   * nada que liberar para este postor.
   */
  readonly creditOperationId: string | null
  readonly creditReservationId: string | null
}

export interface EarlyClosureNotificationRecord extends EnsurePendingNotificationInput {
  readonly status: EarlyClosureNotificationStatus
  readonly attempts: number
  readonly creditsReleased: boolean
  readonly lastError: string | null
}

export interface RecordNotificationAttemptCommand extends EarlyClosureNotificationKey {
  readonly status: EarlyClosureNotificationStatus
  readonly attempts: number
  readonly creditsReleased: boolean
  readonly lastError: string | null
  readonly occurredAt: Date
}

/**
 * Registro de las notificaciones de cierre anticipado y su estado de entrega
 * (HU-64.5). Vive en su propio puerto -no en `AuctionRepositoryPort`- porque es
 * un aggregate distinto: el ciclo de vida de una notificacion no comparte
 * transaccion con el de una subasta.
 */
export interface EarlyClosureNotificationRepositoryPort {
  /**
   * Crea el registro la primera vez que se procesa un cierre para este
   * postor; en cualquier reintento del mismo evento devuelve el registro ya
   * existente sin duplicarlo ni perder su progreso.
   *
   * `creditsReleased` nace en `true` cuando `creditReservationId` es `null`
   * -nada que liberar para este postor- y en `false` en caso contrario.
   */
  ensurePending(input: EnsurePendingNotificationInput): Promise<EarlyClosureNotificationRecord>

  recordAttempt(command: RecordNotificationAttemptCommand): Promise<void>

  findByAuction(auctionId: string): Promise<readonly EarlyClosureNotificationRecord[]>

  findFailed(): Promise<readonly EarlyClosureNotificationRecord[]>
}

export const EARLY_CLOSURE_NOTIFICATION_REPOSITORY = Symbol(
  'EarlyClosureNotificationRepositoryPort',
)
