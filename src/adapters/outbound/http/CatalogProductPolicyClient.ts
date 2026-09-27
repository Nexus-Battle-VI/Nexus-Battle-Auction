import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  CatalogProductPolicy,
  CatalogProductPolicyPort,
} from '../../../application/ports/CatalogProductPolicyPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface CatalogProductPolicyClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface CatalogProductPolicyClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: CatalogProductPolicyClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

interface PremiumStatusPayload {
  readonly productId: string
  readonly premium: boolean
}

const isPremiumStatus = (value: unknown): value is PremiumStatusPayload => {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Readonly<Record<string, unknown>>
  return typeof payload.productId === 'string' && typeof payload.premium === 'boolean'
}

export class CatalogProductPolicyClient implements CatalogProductPolicyPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: CatalogProductPolicyClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getPolicy(productId: string): Promise<CatalogProductPolicy> {
    const path = `/api/internal/v1/catalog/products/${encodeURIComponent(productId)}/premium-status`
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
        this.options.logger.warn('catalog_product_policy_respuesta_no_ok', {
          status: response.status,
        })
        throw new ExternalDependencyUnavailableError('catalog')
      }

      const payload: unknown = await response.json()
      if (!isPremiumStatus(payload) || payload.productId !== productId) {
        throw new ExternalContractError('catalog', 'Catalog devolvio una politica ininteligible.')
      }

      return { tradableInAuction: !payload.premium }
    } catch (error: unknown) {
      if (
        error instanceof ExternalResourceNotFoundError ||
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }

      this.options.logger.warn('catalog_product_policy_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('catalog')
    } finally {
      clearTimeout(timer)
    }
  }
}
