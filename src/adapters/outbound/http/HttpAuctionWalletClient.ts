import type {
  AuctionWalletPort,
  CaptureAuctionHoldCommand,
  ReleaseAuctionHoldCommand,
  WalletHoldResult,
} from '../../../application/ports/AuctionWalletPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface HttpAuctionWalletClientOptions {
  baseUrl: string
  secret: string
  timeoutMs: number
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class HttpAuctionWalletClient implements AuctionWalletPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  constructor(private readonly options: HttpAuctionWalletClientOptions) {
    new URL(options.baseUrl)
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('timeoutMs debe ser un entero positivo.')
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }
  captureHold(command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> {
    return this.call(
      command.holdId,
      'captures',
      {
        operationId: command.operationId,
        beneficiaryPlayerId: command.beneficiaryPlayerId,
        auctionId: command.auctionId,
        winningBidId: command.winningBidId,
      },
      command.beneficiaryPlayerId,
    )
  }
  releaseHold(command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> {
    return this.call(command.holdId, 'releases', {
      operationId: command.operationId,
      reason: command.reason,
    })
  }
  private async call(
    holdId: string,
    action: string,
    body: Record<string, string>,
    beneficiaryPlayerId?: string,
  ): Promise<WalletHoldResult> {
    const operationId = body.operationId
    if (operationId === undefined) throw new Error('operationId es obligatorio.')
    const path = `/api/internal/v1/wallet/holds/${encodeURIComponent(holdId)}/${action}`
    const timestamp = String(this.now().getTime())
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_HEADER]: 'auction',
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(this.options.secret, {
            service: 'auction',
            method: 'POST',
            path,
            timestamp,
            body,
          }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (response.status !== 200)
        return {
          outcome:
            response.status === 404
              ? 'TERMINAL_NOT_FOUND'
              : response.status === 409
                ? 'TERMINAL_CONFLICT'
                : response.status === 422
                  ? 'TERMINAL_RULE_ERROR'
                  : 'RETRYABLE',
          operationId,
          holdId,
        }
      const value: unknown = await response.json()
      if (value === null || typeof value !== 'object')
        return { outcome: 'INVALID_RESPONSE', operationId, holdId }
      const result = value as Record<string, unknown>
      if (
        typeof result.operationId !== 'string' ||
        typeof result.holdId !== 'string' ||
        typeof result.holdStatus !== 'string' ||
        typeof result.applied !== 'boolean'
      )
        return { outcome: 'INVALID_RESPONSE', operationId, holdId }
      if (!['ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED'].includes(result.holdStatus))
        return { outcome: 'INVALID_RESPONSE', operationId, holdId }
      if (result.operationId !== operationId || result.holdId !== holdId)
        return { outcome: 'INVALID_RESPONSE', operationId, holdId }
      if (
        beneficiaryPlayerId !== undefined &&
        result.beneficiaryPlayerId !== undefined &&
        result.beneficiaryPlayerId !== beneficiaryPlayerId
      )
        return { outcome: 'INVALID_RESPONSE', operationId, holdId }
      return {
        outcome: 'SUCCESS',
        operationId: result.operationId,
        holdId: result.holdId,
        holdStatus: result.holdStatus,
        applied: result.applied,
        ...(typeof result.beneficiaryPlayerId === 'string'
          ? { beneficiaryPlayerId: result.beneficiaryPlayerId }
          : {}),
      }
    } catch {
      return { outcome: 'RETRYABLE', operationId, holdId }
    } finally {
      clearTimeout(timer)
    }
  }
}
