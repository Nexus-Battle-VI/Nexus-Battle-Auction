import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type { AuctionConfirmationEventPublisherPort } from '../../../application/ports/AuctionConfirmationEventPublisherPort'
import type { AuctionConfirmationEvent } from '../../../application/ports/AuctionConfirmationOutboxRepositoryPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export const AUCTION_CONFIRMATION_EVENT_PATH =
  '/api/internal/v1/notifications/auction/confirmations'

export interface HttpAuctionConfirmationEventPublisherOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

export class HttpAuctionConfirmationEventPublisher implements AuctionConfirmationEventPublisherPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpAuctionConfirmationEventPublisherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now =
      options.now ??
      (() => {
        return new Date()
      })
  }

  async publish(event: AuctionConfirmationEvent): Promise<void> {
    const path = AUCTION_CONFIRMATION_EVENT_PATH
    const timestamp = String(this.now().getTime())
    const body = { ...event }

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
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
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
        throw new ExternalDependencyUnavailableError('notifications')
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new ExternalContractError(
          'notifications',
          'Notifications devolvió una respuesta que no es JSON válido.',
        )
      }

      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new ExternalContractError('notifications', 'Respuesta de confirmación inválida.')
      }

      const result = payload as Record<string, unknown>
      const expectedRecipients = event.eventType === 'auction.published' ? 1 : 2

      if (
        result.eventId !== event.eventId ||
        typeof result.created !== 'number' ||
        !Number.isSafeInteger(result.created) ||
        result.created < 0 ||
        typeof result.duplicated !== 'number' ||
        !Number.isSafeInteger(result.duplicated) ||
        result.duplicated < 0 ||
        result.created + result.duplicated !== expectedRecipients
      ) {
        throw new ExternalContractError(
          'notifications',
          'Notifications no confirmó todos los avisos del evento.',
        )
      }
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }
      throw new ExternalDependencyUnavailableError('notifications')
    } finally {
      clearTimeout(timer)
    }
  }
}
