import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  OfficialAuctionEligibility,
  OfficialAuctionEligibilityPort,
  OfficialAuctionMark,
} from '../../../application/ports/OfficialAuctionEligibilityPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface OfficialAuctionEligibilityClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface OfficialAuctionEligibilityClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: OfficialAuctionEligibilityClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

const VALID_MARKS: readonly OfficialAuctionMark[] = ['OFFICIAL', 'PREMIUM']

const isOfficialAuctionEligibility = (value: unknown): value is OfficialAuctionEligibility => {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Readonly<Record<string, unknown>>

  if (typeof payload.productId !== 'string') return false
  if (typeof payload.exclusive !== 'boolean') return false
  if (typeof payload.publishable !== 'boolean') return false
  if (payload.officialMark !== null && !VALID_MARKS.includes(payload.officialMark as never)) {
    return false
  }

  return true
}

/** Cliente fail-closed del contrato de elegibilidad oficial de Catalog (HU-66). */
export class OfficialAuctionEligibilityClient implements OfficialAuctionEligibilityPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: OfficialAuctionEligibilityClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getEligibility(productId: string): Promise<OfficialAuctionEligibility> {
    const path = `/api/internal/v1/catalog/products/${encodeURIComponent(productId)}/official-auction-eligibility`
    const timestamp = String(this.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method: 'GET',
      path,
      timestamp,
      // El GET no envia cuerpo; el guard interno de Catalog verifica
      // `request.body ?? {}`, asi que la firma se calcula sobre `{}`.
      body: {},
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
        throw new ExternalResourceNotFoundError('catalog', productId)
      }
      if (!response.ok) {
        this.options.logger.warn('official_auction_eligibility_respuesta_no_ok', {
          status: response.status,
        })
        throw new ExternalDependencyUnavailableError('catalog')
      }

      const payload: unknown = await response.json()
      if (!isOfficialAuctionEligibility(payload) || payload.productId !== productId) {
        throw new ExternalContractError(
          'catalog',
          'Catalog devolvio un contrato de elegibilidad oficial ininteligible.',
        )
      }

      return payload
    } catch (error: unknown) {
      if (
        error instanceof ExternalResourceNotFoundError ||
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }

      this.options.logger.warn('official_auction_eligibility_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('catalog')
    } finally {
      clearTimeout(timer)
    }
  }
}
