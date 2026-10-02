import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  SellerPublicProfile,
  SellerPublicProfilePort,
} from '../../../application/ports/SellerPublicProfilePort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface HttpSellerPublicProfileClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface HttpSellerPublicProfileClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: HttpSellerPublicProfileClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

const isSellerPublicProfile = (value: unknown): value is SellerPublicProfile => {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Readonly<Record<string, unknown>>
  return (
    typeof payload.subject === 'string' &&
    typeof payload.displayName === 'string' &&
    (payload.avatarUrl === null || typeof payload.avatarUrl === 'string')
  )
}

/**
 * Cliente hacia el perfil de batalla de Account (HU-88), mismo patron HMAC
 * interno que `HttpSellerSanctionClient`/`CatalogProductPolicyClient`.
 *
 * A diferencia de esos dos, este cliente SIEMPRE lanza en cualquier falla
 * -nunca degrada por si mismo-: la degradacion (perfil ausente -> detalle
 * sigue respondiendo 200 sin datos de vendedor) es responsabilidad de
 * `GetAuctionDetail`, que es quien decide que errores externos puede
 * tolerar. Este cliente solo reporta con precision que fue lo que fallo.
 */
export class HttpSellerPublicProfileClient implements SellerPublicProfilePort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpSellerPublicProfileClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getPublicProfile(subject: string): Promise<SellerPublicProfile> {
    const path = `/api/internal/accounts/${encodeURIComponent(subject)}/battle-profile`
    const timestamp = String(this.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method: 'GET',
      path,
      timestamp,
      // El GET no envia cuerpo; el guard interno de Account verifica
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
        throw new ExternalResourceNotFoundError('account', subject)
      }
      if (!response.ok) {
        this.options.logger.warn('seller_public_profile_respuesta_no_ok', {
          status: response.status,
        })
        throw new ExternalDependencyUnavailableError('account')
      }

      const payload: unknown = await response.json()
      if (!isSellerPublicProfile(payload) || payload.subject !== subject) {
        throw new ExternalContractError('account', 'Account devolvio un perfil ininteligible.')
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

      this.options.logger.warn('seller_public_profile_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('account')
    } finally {
      clearTimeout(timer)
    }
  }
}
