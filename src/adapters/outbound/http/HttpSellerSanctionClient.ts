import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  ActiveSanction,
  ActiveSanctionStatus,
  ActiveSanctionType,
  SellerActiveSanctionsPort,
  SellerSanctionPort,
} from '../../../application/ports/SellerSanctionPort'
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

const ACTIVE_SANCTION_TYPES: readonly string[] = [
  'PERMANENT_BAN',
  'TEMPORARY_SUSPENSION',
] satisfies readonly ActiveSanctionType[]

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `undefined` senala un valor fuera de contrato; `null` es un veto permanente. */
const parseExpiresAt = (value: unknown): Date | null | undefined => {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const parseActiveSanction = (value: unknown): ActiveSanction | null => {
  if (!isRecord(value)) return null
  const { id, type, reasonCode } = value
  const expiresAt = parseExpiresAt(value.expiresAt)
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof type !== 'string' ||
    !ACTIVE_SANCTION_TYPES.includes(type) ||
    typeof reasonCode !== 'string' ||
    reasonCode === '' ||
    expiresAt === undefined
  ) {
    return null
  }
  return { id, type: type as ActiveSanctionType, reasonCode, expiresAt }
}

/**
 * Valida el contrato completo de Account. Una sola entrada invalida -p.ej.
 * un `type` que no es una restriccion activa, como WARNING- invalida toda la
 * respuesta en vez de descartarse en silencio: un payload que no cumple el
 * contrato no es evidencia fiable de nada.
 */
const parseActiveSanctionStatus = (value: unknown): ActiveSanctionStatus | null => {
  if (!isRecord(value) || typeof value.hasActiveSanctions !== 'boolean') return null
  if (!Array.isArray(value.sanctions)) return null
  const sanctions: ActiveSanction[] = []
  for (const entry of value.sanctions as readonly unknown[]) {
    const sanction = parseActiveSanction(entry)
    if (sanction === null) return null
    sanctions.push(sanction)
  }
  return { hasActiveSanctions: value.hasActiveSanctions, sanctions }
}

/**
 * Cliente fail-closed de sanciones del vendedor (HU-62), contra Account.
 *
 * Un vendedor sin cuenta en Account (404) se trata igual que uno sancionado
 * al PUBLICAR: publicar una subasta requiere una identidad verificable, y una
 * que Account no reconoce no es una identidad de la que se pueda afirmar lo
 * contrario. Para la cancelacion automatica (HU-90, CA-05) el mismo 404 es
 * lo opuesto -no se puede confirmar ninguna sancion-, por eso
 * `getActiveSanctions` lo propaga como error y solo `hasActiveSanctions` lo
 * traduce a `true`.
 */
export class HttpSellerSanctionClient implements SellerSanctionPort, SellerActiveSanctionsPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpSellerSanctionClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Publicacion (HU-62). Solo exige el booleano, igual que antes de CA-05:
   * la lista `sanctions` no participa en la decision de publicar.
   */
  async hasActiveSanctions(sellerId: string): Promise<boolean> {
    let payload: unknown
    try {
      payload = await this.fetchActiveSanctions(sellerId)
    } catch (error: unknown) {
      if (error instanceof ExternalResourceNotFoundError) return true
      throw error
    }
    if (!isRecord(payload) || typeof payload.hasActiveSanctions !== 'boolean') {
      throw new ExternalDependencyUnavailableError('account')
    }
    return payload.hasActiveSanctions
  }

  async getActiveSanctions(subject: string): Promise<ActiveSanctionStatus> {
    const status = parseActiveSanctionStatus(await this.fetchActiveSanctions(subject))
    if (status === null) {
      this.options.logger.warn('seller_sanction_respuesta_invalida')
      throw new ExternalDependencyUnavailableError('account')
    }
    return status
  }

  private async fetchActiveSanctions(subject: string): Promise<unknown> {
    const path = `/api/internal/accounts/${encodeURIComponent(subject)}/active-sanctions`
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
        // El `subject` no viaja en el error: acabaria en logs.
        throw new ExternalResourceNotFoundError('account', 'active-sanctions')
      }
      if (!response.ok) {
        this.options.logger.warn('seller_sanction_respuesta_no_ok', { status: response.status })
        throw new ExternalDependencyUnavailableError('account')
      }

      return (await response.json()) as unknown
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalResourceNotFoundError
      ) {
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
