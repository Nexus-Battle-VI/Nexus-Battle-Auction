import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../../application/errors/ExternalDependencyError'
import type {
  ClaimedInventoryProductCommitment,
  CommitInventoryProductCommand,
  ConfirmInventoryProductClaimCommand,
  InventoryProductCommitment,
  InventoryProductEligibility,
  MarkInventoryProductPendingClaimCommand,
  PendingClaimInventoryProductCommitment,
  ProductInventoryPort,
  ReleasedInventoryProductCommitment,
  ReleaseInventoryProductCommand,
} from '../../../application/ports/ProductInventoryPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface HttpAuctionInventoryClientOptions {
  readonly baseUrl: string
  readonly secret: string
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
}

type ResponsePayload = Readonly<Record<string, unknown>>

const isPayload = (value: unknown): value is ResponsePayload =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class HttpAuctionInventoryClient implements ProductInventoryPort {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: HttpAuctionInventoryClientOptions) {
    new URL(options.baseUrl)
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('timeoutMs debe ser un entero positivo.')
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  inspect(ownerId: string, productId: string): Promise<InventoryProductEligibility> {
    void ownerId
    void productId
    return Promise.reject(
      new ExternalDependencyUnavailableError(
        'player-inventory',
        'Player-Inventory no expone un endpoint de inspect en el contrato HU-65.',
      ),
    )
  }

  async commit(command: CommitInventoryProductCommand): Promise<InventoryProductCommitment> {
    const payload = await this.post('/api/internal/v1/inventory/auction-commitments', {
      operationId: command.operationId,
      auctionId: command.auctionId,
      ownerId: command.ownerId,
      productId: command.productId,
      expiresAt: command.expiresAt.toISOString(),
    })
    if (
      payload.operationId !== command.operationId ||
      typeof payload.commitmentId !== 'string' ||
      payload.commitmentId === '' ||
      payload.status !== 'ACTIVE' ||
      typeof payload.applied !== 'boolean'
    ) {
      throw new ExternalContractError('player-inventory', 'Respuesta invalida al crear commitment.')
    }
    return {
      operationId: payload.operationId,
      commitmentId: payload.commitmentId,
      status: payload.status,
      applied: payload.applied,
    }
  }

  async release(
    command: ReleaseInventoryProductCommand,
  ): Promise<ReleasedInventoryProductCommitment> {
    const payload = await this.post(
      `/api/internal/v1/inventory/auction-commitments/${encodeURIComponent(command.commitmentId)}/release`,
      {
        operationId: command.operationId,
        auctionId: command.auctionId,
        ownerId: command.ownerId,
        productId: command.productId,
        reason: command.reason,
      },
      command.commitmentId,
    )
    if (
      payload.operationId !== command.operationId ||
      payload.commitmentId !== command.commitmentId ||
      payload.status !== 'RELEASED' ||
      typeof payload.applied !== 'boolean'
    ) {
      throw new ExternalContractError(
        'player-inventory',
        'Respuesta invalida al liberar commitment.',
      )
    }
    return {
      operationId: payload.operationId,
      commitmentId: payload.commitmentId,
      status: payload.status,
      applied: payload.applied,
    }
  }

  async markPendingClaim(
    command: MarkInventoryProductPendingClaimCommand,
  ): Promise<PendingClaimInventoryProductCommitment> {
    const payload = await this.post(
      `/api/internal/v1/inventory/auction-commitments/${encodeURIComponent(command.commitmentId)}/pending-claim`,
      {
        operationId: command.operationId,
        auctionId: command.auctionId,
        sellerId: command.sellerId,
        winnerId: command.winnerId,
        productId: command.productId,
      },
      command.commitmentId,
    )
    if (
      payload.operationId !== command.operationId ||
      payload.commitmentId !== command.commitmentId ||
      payload.status !== 'PENDING_CLAIM' ||
      payload.winnerId !== command.winnerId ||
      typeof payload.applied !== 'boolean'
    ) {
      throw new ExternalContractError(
        'player-inventory',
        'Respuesta invalida al marcar pending claim.',
      )
    }
    return {
      operationId: payload.operationId,
      commitmentId: payload.commitmentId,
      status: payload.status,
      winnerId: payload.winnerId,
      applied: payload.applied,
    }
  }

  async confirmClaim(
    command: ConfirmInventoryProductClaimCommand,
  ): Promise<ClaimedInventoryProductCommitment> {
    const payload = await this.post(
      `/api/internal/v1/inventory/auction-commitments/${encodeURIComponent(command.commitmentId)}/claim`,
      {
        operationId: command.operationId,
        auctionId: command.auctionId,
        winnerId: command.winnerId,
        productId: command.productId,
      },
      command.commitmentId,
    )
    if (
      payload.operationId !== command.operationId ||
      payload.commitmentId !== command.commitmentId ||
      payload.status !== 'CLAIMED' ||
      payload.winnerId !== command.winnerId ||
      typeof payload.applied !== 'boolean'
    ) {
      throw new ExternalContractError(
        'player-inventory',
        'Respuesta invalida al confirmar el reclamo.',
      )
    }
    return {
      operationId: payload.operationId,
      commitmentId: payload.commitmentId,
      status: payload.status,
      winnerId: payload.winnerId,
      applied: payload.applied,
    }
  }

  private async post(
    path: string,
    body: ResponsePayload,
    resourceId?: string,
  ): Promise<ResponsePayload> {
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
      if (response.status === 503) {
        throw new ExternalDependencyUnavailableError('player-inventory')
      }
      if (response.status === 404) {
        throw new ExternalResourceNotFoundError('player-inventory', resourceId ?? path)
      }
      if (response.status !== 200) {
        throw new ExternalContractError(
          'player-inventory',
          `Player-Inventory respondio HTTP ${String(response.status)}.`,
        )
      }
      const payload: unknown = await response.json()
      if (!isPayload(payload)) {
        throw new ExternalContractError(
          'player-inventory',
          'Player-Inventory devolvio JSON invalido.',
        )
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
      throw new ExternalDependencyUnavailableError('player-inventory')
    } finally {
      clearTimeout(timer)
    }
  }
}
