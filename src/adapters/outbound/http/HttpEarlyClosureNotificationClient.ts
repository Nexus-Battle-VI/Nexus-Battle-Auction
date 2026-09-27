import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  NotificationDispatch,
  NotificationPort,
  NotifyAuctionClosedEarlyCommand,
} from '../../../application/ports/NotificationPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export const AUCTION_CLOSED_BY_BUY_NOW_NOTIFICATION_PATH =
  '/api/internal/v1/notifications/auction/closed-by-buy-now'

export interface HttpEarlyClosureNotificationClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface HttpEarlyClosureNotificationClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: HttpEarlyClosureNotificationClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

interface NotificationResponse {
  readonly notificationId: string
  readonly status: 'created' | 'duplicated'
}

const isNotificationResponse = (value: unknown): value is NotificationResponse => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const payload = value as Readonly<Record<string, unknown>>

  return (
    typeof payload.notificationId === 'string' &&
    (payload.status === 'created' || payload.status === 'duplicated')
  )
}

/**
 * Cliente HTTP de HU-64.5.
 *
 * Notifica a un participante el cierre anticipado de la subasta por compra
 * inmediata con la misma firma HMAC servicio-a-servicio de HU-63.5.
 *
 * 201 (created) y 200 (duplicated) son exito. 409 significa que el mismo
 * operationId ya se uso con otro payload: es un error de contrato, no un exito
 * silencioso.
 */
export class HttpEarlyClosureNotificationClient implements NotificationPort {
  private readonly fetchImpl: typeof fetch

  private readonly now: () => Date

  constructor(private readonly options: HttpEarlyClosureNotificationClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch

    this.now = options.now ?? (() => new Date())
  }

  async notifyAuctionClosedEarly(
    command: NotifyAuctionClosedEarlyCommand,
  ): Promise<NotificationDispatch> {
    const path = AUCTION_CLOSED_BY_BUY_NOW_NOTIFICATION_PATH

    const body = {
      operationId: command.operationId,

      auctionId: command.auctionId,

      recipientId: command.recipientId,

      transactionId: command.transactionId,

      closedAt: command.closedAt.toISOString(),
    }

    const timestamp = String(this.now().getTime())

    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,

      method: 'POST',

      path,

      timestamp,

      body,
    })

    const controller = new AbortController()

    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',

        headers: {
          'content-type': 'application/json',

          [INTERNAL_SERVICE_HEADER]: this.options.serviceName,

          [INTERNAL_TIMESTAMP_HEADER]: timestamp,

          [INTERNAL_SIGNATURE_HEADER]: signature,
        },

        body: JSON.stringify(body),

        signal: controller.signal,
      })

      if (response.status === 409) {
        this.options.logger.warn('early_closure_notification_conflicto', {
          status: response.status,
        })

        throw new ExternalContractError(
          'notifications',
          'Notifications rechazo el operationId porque ya existe con un payload distinto.',
        )
      }

      if (!response.ok) {
        this.options.logger.warn('early_closure_notification_respuesta_no_ok', {
          status: response.status,
        })

        throw new ExternalDependencyUnavailableError('notifications')
      }

      let payload: unknown

      try {
        payload = await response.json()
      } catch {
        throw new ExternalContractError(
          'notifications',
          'Notifications devolvio una respuesta que no es JSON valido.',
        )
      }

      if (!isNotificationResponse(payload) || payload.notificationId !== command.operationId) {
        throw new ExternalContractError(
          'notifications',
          'Notifications devolvio una respuesta incompatible con el contrato de notificacion.',
        )
      }

      return { notificationId: payload.notificationId }
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }

      this.options.logger.warn('early_closure_notification_no_entregada', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })

      throw new ExternalDependencyUnavailableError('notifications')
    } finally {
      clearTimeout(timer)
    }
  }
}
