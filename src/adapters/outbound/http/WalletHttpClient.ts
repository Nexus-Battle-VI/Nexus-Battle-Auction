import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  BuyNowCreditTransfer,
  BuyNowCreditTransferCommand,
  WalletPort,
} from '../../../application/ports/WalletPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface WalletHttpClientLogger {
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface WalletHttpClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: WalletHttpClientLogger
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

interface BalancePayload {
  readonly playerId: string
  readonly balance: number
  readonly reserved: number
  readonly available: number
}

interface TransferPayload {
  readonly operationId: string
  readonly transferId: string
  readonly status: string
  readonly applied: boolean
}

const isBalancePayload = (value: unknown): value is BalancePayload => {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Readonly<Record<string, unknown>>
  return typeof payload.available === 'number'
}

const isTransferPayload = (value: unknown): value is TransferPayload => {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Readonly<Record<string, unknown>>
  return typeof payload.transferId === 'string'
}

/**
 * Cliente HTTP hacia Wallet (HU-64.8, `internal/v1/wallet/buy-now-transfers`).
 *
 * Mismo patron que `CatalogProductPolicyClient`: firma HMAC-SHA256 por
 * peticion, timeout con `AbortController`, y cualquier fallo -de red, de
 * contrato o de estado- se traduce a `ExternalDependencyUnavailableError` o
 * `ExternalContractError`, nunca a un valor inventado.
 */
export class WalletHttpClient implements WalletPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: WalletHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getAvailableCredits(buyerId: string): Promise<number> {
    const path = `/api/internal/v1/wallet/buy-now-transfers/balance/${encodeURIComponent(buyerId)}`
    const response = await this.send('GET', path, null)
    const payload: unknown = await response.json()

    if (!isBalancePayload(payload)) {
      throw new ExternalContractError('wallet', 'Wallet devolvio un saldo ininteligible.')
    }

    return payload.available
  }

  async transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer> {
    const path = '/api/internal/v1/wallet/buy-now-transfers'
    const body = {
      operationId: command.operationId,
      buyerId: command.buyerId,
      sellerId: command.sellerId,
      amount: command.amount,
    }
    const response = await this.send('POST', path, body)
    const payload: unknown = await response.json()

    if (!isTransferPayload(payload)) {
      throw new ExternalContractError('wallet', 'Wallet devolvio una transferencia ininteligible.')
    }

    return { transferId: payload.transferId }
  }

  async reverseBuyNowCredits(operationId: string, transferId: string): Promise<void> {
    const path = `/api/internal/v1/wallet/buy-now-transfers/${encodeURIComponent(transferId)}/reversals`

    await this.send('POST', path, { operationId })
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown): Promise<Response> {
    const timestamp = String(this.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method,
      path,
      timestamp,
      // Un GET no envia cuerpo, y el guard interno de Wallet verifica
      // `request.body ?? {}`: la firma debe calcularse sobre `{}`, no `null`.
      body: body ?? {},
    })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          [INTERNAL_SERVICE_HEADER]: this.options.serviceName,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })

      if (!response.ok) {
        this.options.logger.warn('wallet_respuesta_no_ok', { status: response.status, path })
        throw new ExternalDependencyUnavailableError('wallet')
      }

      return response
    } catch (error: unknown) {
      if (
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalContractError
      ) {
        throw error
      }

      this.options.logger.warn('wallet_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })
      throw new ExternalDependencyUnavailableError('wallet')
    } finally {
      clearTimeout(timer)
    }
  }
}
