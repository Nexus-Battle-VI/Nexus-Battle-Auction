import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import { HttpAuctionInventoryClient } from '../../src/adapters/outbound/http/HttpAuctionInventoryClient'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'

const now = new Date('2026-09-23T12:00:00.000Z')
const commit = {
  operationId: 'auction:auction-1:inventory:commit',
  auctionId: 'auction-1',
  ownerId: 'seller-1',
  productId: 'product-1',
  expiresAt: new Date('2026-09-24T12:00:00.000Z'),
}
const release = {
  operationId: 'auction:auction-1:inventory:release',
  commitmentId: 'commitment/ one',
  auctionId: 'auction-1',
  ownerId: 'seller-1',
  productId: 'product-1',
  reason: 'AUCTION_WITHOUT_BIDS' as const,
}
const pending = {
  operationId: 'auction:auction-1:inventory:pending-claim',
  commitmentId: 'commitment-1',
  auctionId: 'auction-1',
  sellerId: 'seller-1',
  winnerId: 'winner-1',
  productId: 'product-1',
}

const response = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const client = (fetchImpl: typeof fetch, timeoutMs = 1_000) =>
  new HttpAuctionInventoryClient({
    baseUrl: 'https://inventory.example.com/',
    secret: 'secret',
    timeoutMs,
    fetchImpl,
    now: () => now,
  })

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

describe('HttpAuctionInventoryClient', () => {
  it('envia commit firmado con body y ruta canonicos', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: commit.operationId,
          commitmentId: 'commitment-1',
          status: 'ACTIVE',
          applied: true,
        }),
      ),
    )

    await expect(client(fetchImpl).commit(commit)).resolves.toMatchObject({
      commitmentId: 'commitment-1',
      status: 'ACTIVE',
      applied: true,
    })

    const [url, request] = fetchImpl.mock.calls[0]!
    const body = JSON.parse(request?.body as string) as Record<string, unknown>
    const path = '/api/internal/v1/inventory/auction-commitments'
    expect(url).toBe(`https://inventory.example.com${path}`)
    expect(body).toEqual({ ...commit, expiresAt: commit.expiresAt.toISOString() })
    expect(request?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(now.getTime()),
      'x-internal-signature': signInternalRequest('secret', {
        service: 'auction',
        method: 'POST',
        path,
        timestamp: String(now.getTime()),
        body,
      }),
    })
  })

  it('acepta replay de commit', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: commit.operationId,
          commitmentId: 'commitment-1',
          status: 'ACTIVE',
          applied: false,
        }),
      ),
    )
    await expect(client(fetchImpl).commit(commit)).resolves.toMatchObject({ applied: false })
  })

  it.each([400, 401, 409, 422])('clasifica commit HTTP %i como terminal', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))
    await expect(client(fetchImpl).commit(commit)).rejects.toBeInstanceOf(ExternalContractError)
  })

  it('clasifica commit 404 como terminal de recurso', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(404, {})))
    await expect(client(fetchImpl).commit(commit)).rejects.toBeInstanceOf(
      ExternalResourceNotFoundError,
    )
  })

  it.each([
    ['HTTP 503', () => Promise.resolve(response(503, {}))],
    ['red', () => Promise.reject(new Error('network'))],
  ])('clasifica commit %s como retryable', async (_caseName, implementation) => {
    const fetchImpl = mockFetch(implementation)
    await expect(client(fetchImpl).commit(commit)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('clasifica commit 200 invalido como terminal', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, { operationId: commit.operationId, status: 'ACTIVE', applied: true }),
      ),
    )
    await expect(client(fetchImpl).commit(commit)).rejects.toBeInstanceOf(ExternalContractError)
  })

  it('libera commitment con URL codificada y valida el replay', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: release.operationId,
          commitmentId: release.commitmentId,
          status: 'RELEASED',
          applied: false,
        }),
      ),
    )
    await expect(client(fetchImpl).release(release)).resolves.toMatchObject({ applied: false })
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'https://inventory.example.com/api/internal/v1/inventory/auction-commitments/commitment%2F%20one/release',
    )
    expect(JSON.parse(request?.body as string)).toEqual({
      operationId: release.operationId,
      auctionId: release.auctionId,
      ownerId: release.ownerId,
      productId: release.productId,
      reason: 'AUCTION_WITHOUT_BIDS',
    })
  })

  it.each([
    { operationId: 'other', commitmentId: release.commitmentId, status: 'RELEASED', applied: true },
    { operationId: release.operationId, commitmentId: 'other', status: 'RELEASED', applied: true },
    {
      operationId: release.operationId,
      commitmentId: release.commitmentId,
      status: 'ACTIVE',
      applied: true,
    },
  ])('rechaza respuesta release inconsistente', async (value) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, value)))
    await expect(client(fetchImpl).release(release)).rejects.toBeInstanceOf(ExternalContractError)
  })

  it('marca pending claim y valida winner/replay', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: pending.operationId,
          commitmentId: pending.commitmentId,
          status: 'PENDING_CLAIM',
          winnerId: pending.winnerId,
          applied: false,
        }),
      ),
    )
    await expect(client(fetchImpl).markPendingClaim(pending)).resolves.toMatchObject({
      status: 'PENDING_CLAIM',
      applied: false,
    })
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'https://inventory.example.com/api/internal/v1/inventory/auction-commitments/commitment-1/pending-claim',
    )
    expect(JSON.parse(request?.body as string)).toEqual({
      operationId: pending.operationId,
      auctionId: pending.auctionId,
      sellerId: pending.sellerId,
      winnerId: pending.winnerId,
      productId: pending.productId,
    })
  })

  it.each([
    {
      operationId: pending.operationId,
      commitmentId: pending.commitmentId,
      status: 'PENDING_CLAIM',
      winnerId: 'other',
      applied: true,
    },
    {
      operationId: pending.operationId,
      commitmentId: pending.commitmentId,
      status: 'ACTIVE',
      winnerId: pending.winnerId,
      applied: true,
    },
  ])('rechaza respuesta pending claim inconsistente', async (value) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, value)))
    await expect(client(fetchImpl).markPendingClaim(pending)).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('convierte timeout en retryable', async () => {
    const fetchImpl = jest.fn(
      (_url: string, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    ) as unknown as typeof fetch
    await expect(client(fetchImpl, 1).commit(commit)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})
