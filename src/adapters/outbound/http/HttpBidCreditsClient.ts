import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  BidCreditBalance,
  BidCreditReservation,
  BidCreditsPort,
  ReserveBidCreditsCommand,
} from '../../../application/ports/BidCreditsPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface HttpBidCreditsClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

type ResponsePayload = Readonly<Record<string, unknown>>

const isPayload = (value: unknown): value is ResponsePayload =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Cliente del contrato interno Wallet que reserva y libera creditos de pujas. */
export class HttpBidCreditsClient implements BidCreditsPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpBidCreditsClientOptions) {
    new URL(options.baseUrl)
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('timeoutMs debe ser un entero positivo.')
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getAvailableCredits(bidderId: string): Promise<BidCreditBalance> {
    const payload = await this.request(
      'GET',
      `/api/internal/v1/wallet/buy-now-transfers/balance/${encodeURIComponent(bidderId)}`,
      null,
      bidderId,
    )
    if (
      payload.playerId !== bidderId ||
      !Number.isSafeInteger(payload.available) ||
      (payload.available as number) < 0
    ) {
      throw new ExternalContractError('wallet', 'Wallet devolvio un saldo disponible invalido.')
    }
    return { availableCredits: payload.available as number }
  }

  async reserve(command: ReserveBidCreditsCommand): Promise<BidCreditReservation> {
    const body = {
      operationId: command.operationId,
      playerId: command.bidderId,
      amount: command.amount,
      auctionId: command.auctionId,
      bidId: command.bidId,
      auctionClosesAt: command.expiresAt.toISOString(),
    }
    const payload = await this.request('POST', '/api/internal/v1/wallet/holds', body)
    if (
      payload.operationId !== command.operationId ||
      typeof payload.holdId !== 'string' ||
      payload.holdId === '' ||
      payload.holdStatus !== 'ACTIVE' ||
      typeof payload.applied !== 'boolean' ||
      (payload.playerId !== undefined && payload.playerId !== command.bidderId) ||
      (payload.bidId !== undefined && payload.bidId !== command.bidId) ||
      (payload.auctionId !== undefined && payload.auctionId !== command.auctionId)
    ) {
      throw new ExternalContractError('wallet', 'Wallet devolvio una reserva de puja invalida.')
    }
    return { reservationId: payload.holdId }
  }

  async release(operationId: string, reservationId: string): Promise<void> {
    const payload = await this.request(
      'POST',
      `/api/internal/v1/wallet/holds/${encodeURIComponent(reservationId)}/releases`,
      { operationId, reason: 'AUCTION_OUTBID' },
      reservationId,
    )
    if (
      payload.operationId !== operationId ||
      payload.holdId !== reservationId ||
      payload.holdStatus !== 'RELEASED' ||
      typeof payload.applied !== 'boolean'
    ) {
      throw new ExternalContractError('wallet', 'Wallet devolvio una liberacion de puja invalida.')
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: ResponsePayload | null,
    resourceId?: string,
  ): Promise<ResponsePayload> {
    const timestamp = String(this.now().getTime())
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)
    try {
      const baseUrl = this.options.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')
      const response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          [INTERNAL_SERVICE_HEADER]: 'auction',
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(this.options.secret, {
            service: 'auction',
            method,
            path,
            timestamp,
            body,
          }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      if (response.status === 404) {
        throw new ExternalResourceNotFoundError('wallet', resourceId ?? path)
      }
      if (response.status >= 500) {
        throw new ExternalDependencyUnavailableError('wallet')
      }
      if (!response.ok) {
        throw new ExternalContractError(
          'wallet',
          `Wallet respondio HTTP ${String(response.status)}.`,
        )
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new ExternalContractError('wallet', 'Wallet devolvio JSON invalido.')
      }
      if (!isPayload(payload)) {
        throw new ExternalContractError('wallet', 'Wallet devolvio JSON invalido.')
      }
      return payload
    } catch (error: unknown) {
      if (
        error instanceof ExternalContractError ||
        error instanceof ExternalDependencyUnavailableError ||
        error instanceof ExternalResourceNotFoundError
      ) {
        throw error
      }
      throw new ExternalDependencyUnavailableError('wallet')
    } finally {
      clearTimeout(timer)
    }
  }
}
