import { ExternalDependencyUnavailableError } from '../../../application/errors/ExternalDependencyError'
import type { SellerSanctionPort } from '../../../application/ports/SellerSanctionPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface HttpSellerSanctionClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface HttpSellerSanctionClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: HttpSellerSanctionClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

interface ActiveSanctionStatusPayload {
  readonly hasActiveSanctions: boolean
}

const isActiveSanctionStatus = (value: unknown): value is ActiveSanctionStatusPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).hasActiveSanctions === 'boolean'

/**
 * Cliente fail-closed de sanciones del vendedor (HU-62), contra Account.
 *
 * Un vendedor sin cuenta en Account (404) se trata igual que uno sancionado:
 * publicar una subasta requiere una identidad verificable, y una que Account
 * no reconoce no es una identidad de la que se pueda afirmar lo contrario.
 */
export class HttpSellerSanctionClient implements SellerSanctionPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpSellerSanctionClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async hasActiveSanctions(sellerId: string): Promise<boolean> {
    const path = `/api/internal/accounts/${encodeURIComponent(sellerId)}/active-sanctions`
    const timestamp = String(this.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method: 'GET',
      path,
      timestamp,
      body: null,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          [INTERNAL_SERVICE_HEADER]: this.options.serviceName,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        signal: controller.signal,
      })

      if (response.status === 404) {
        return true
      }
      if (!response.ok) {
        this.options.logger.warn('seller_sanction_respuesta_no_ok', { status: response.status })
        throw new ExternalDependencyUnavailableError('account')
      }

      const payload: unknown = await response.json()
      if (!isActiveSanctionStatus(payload)) {
        throw new ExternalDependencyUnavailableError('account')
      }

      return payload.hasActiveSanctions
    } catch (error: unknown) {
      if (error instanceof ExternalDependencyUnavailableError) {
        throw error
      }

      this.options.logger.warn('seller_sanction_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('account')
    } finally {
      clearTimeout(timer)
    }
  }
}
