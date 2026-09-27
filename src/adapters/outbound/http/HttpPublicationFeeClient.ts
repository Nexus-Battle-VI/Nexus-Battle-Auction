import {
  IdempotencyConflictError,
  InsufficientPublicationFundsError,
} from '../../../application/errors/AuctionPersistenceError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  ChargePublicationFeeCommand,
  PublicationFeeCharge,
  PublicationFeePort,
} from '../../../application/ports/PublicationFeePort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface HttpPublicationFeeClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface HttpPublicationFeeClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: HttpPublicationFeeClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

interface ChargeResponsePayload {
  readonly chargeId: string
}

const isChargeResponse = (value: unknown): value is ChargeResponsePayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).chargeId === 'string'

/** Cliente fail-closed de la comision de publicacion (HU-62), contra Wallet. */
export class HttpPublicationFeeClient implements PublicationFeePort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpPublicationFeeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge> {
    const path = '/api/internal/v1/wallet/auction-publication-fees'
    const body = {
      operationId: command.operationId,
      sellerId: command.sellerId,
      amount: command.amount,
    }

    const response = await this.request('POST', path, body)

    if (response.status === 409) {
      throw new IdempotencyConflictError()
    }
    if (response.status === 422) {
      throw new InsufficientPublicationFundsError()
    }
    if (!response.ok) {
      this.warn('publication_fee_charge_respuesta_no_ok', response.status)
      throw new ExternalDependencyUnavailableError('wallet')
    }

    const payload: unknown = await this.safeJson(response)
    if (!isChargeResponse(payload)) {
      throw new ExternalContractError('wallet', 'Wallet devolvio una comision ininteligible.')
    }

    return { chargeId: payload.chargeId }
  }

  async refund(operationId: string, chargeId: string): Promise<void> {
    const path = `/api/internal/v1/wallet/auction-publication-fees/${encodeURIComponent(chargeId)}/refunds`
    const body = { operationId }

    const response = await this.request('POST', path, body)

    // Un reembolso repetido o de un cargo ya inexistente no es un fallo de la
    // publicacion: la comision no puede cobrarse dos veces sea como sea.
    if (response.status === 404 || response.ok) {
      return
    }
    if (response.status === 409) {
      throw new IdempotencyConflictError()
    }

    this.warn('publication_fee_refund_respuesta_no_ok', response.status)
    throw new ExternalDependencyUnavailableError('wallet')
  }

  private async request(method: 'POST', path: string, body: unknown): Promise<Response> {
    const timestamp = String(this.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method,
      path,
      timestamp,
      body,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      return await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_HEADER]: this.options.serviceName,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      this.options.logger.warn('publication_fee_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('wallet')
    } finally {
      clearTimeout(timer)
    }
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  private warn(message: string, status: number): void {
    this.options.logger.warn(message, { status })
  }
}
