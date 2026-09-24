import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  AutoBidLimitReachedNotification,
  OutbidNotification,
  OutbidNotificationPort,
} from '../../../application/ports/OutbidNotificationPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export const AUCTION_OUTBID_NOTIFICATION_PATH = '/api/internal/v1/notifications/auction/outbid'

export const AUCTION_AUTO_BID_LIMIT_REACHED_NOTIFICATION_PATH =
  '/api/internal/v1/notifications/auction/auto-bid-limit-reached'

export interface HttpOutbidNotificationClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface HttpOutbidNotificationClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: HttpOutbidNotificationClientLogger
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
 * Cliente HTTP de HU-63.5.
 *
 * Auction llama al endpoint interno de Notifications usando
 * la misma firma HMAC servicio-a-servicio del resto del sistema.
 */
export class HttpOutbidNotificationClient implements OutbidNotificationPort {
  private readonly fetchImpl: typeof fetch

  private readonly now: () => Date

  constructor(private readonly options: HttpOutbidNotificationClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch

    this.now = options.now ?? (() => new Date())
  }

  publish(notification: OutbidNotification): Promise<void> {
    return this.send(AUCTION_OUTBID_NOTIFICATION_PATH, notification.notificationId, {
      notificationId: notification.notificationId,

      operationId: notification.operationId,

      recipientPlayerId: notification.recipientPlayerId,

      auctionId: notification.auctionId,

      outbidBidId: notification.outbidBidId,

      winningBidId: notification.winningBidId,

      winningBidderId: notification.winningBidderId,

      winningAmountCredits: notification.winningAmountCredits,

      occurredAt: notification.occurredAt.toISOString(),
    })
  }

  publishAutoBidLimitReached(notification: AutoBidLimitReachedNotification): Promise<void> {
    return this.send(
      AUCTION_AUTO_BID_LIMIT_REACHED_NOTIFICATION_PATH,
      notification.notificationId,
      {
        notificationId: notification.notificationId,

        operationId: notification.operationId,

        recipientPlayerId: notification.recipientPlayerId,

        auctionId: notification.auctionId,

        autoBidLimitCredits: notification.autoBidLimitCredits,

        requiredAmountCredits: notification.requiredAmountCredits,

        leadingBidderId: notification.leadingBidderId,

        occurredAt: notification.occurredAt.toISOString(),
      },
    )
  }

  private async send(
    path: string,
    notificationId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
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

      if (!response.ok) {
        this.options.logger.warn('outbid_notification_respuesta_no_ok', {
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

      if (!isNotificationResponse(payload) || payload.notificationId !== notificationId) {
        throw new ExternalContractError(
          'notifications',
          'Notifications devolvio una respuesta incompatible con el contrato de notificacion.',
        )
      }
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }

      this.options.logger.warn('outbid_notification_no_entregada', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })

      throw new ExternalDependencyUnavailableError('notifications')
    } finally {
      clearTimeout(timer)
    }
  }
}
