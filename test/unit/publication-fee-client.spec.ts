import { createHash, createHmac } from 'node:crypto'

import {
  IdempotencyConflictError,
  InsufficientPublicationFundsError,
} from '../../src/application/errors/AuctionPersistenceError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'
import { HttpPublicationFeeClient } from '../../src/adapters/outbound/http/HttpPublicationFeeClient'
import { canonicalBody } from '../../src/adapters/outbound/identity/internal-signature'

const fixedNow = new Date('2026-09-24T12:00:00.000Z')

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch) {
  return new HttpPublicationFeeClient({
    baseUrl: 'http://wallet:3006',
    secret: 'shared-secret',
    serviceName: 'auction',
    timeoutMs: 100,
    logger: { warn: jest.fn() },
    fetchImpl,
    now: () => fixedNow,
  })
}

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

describe('HttpPublicationFeeClient.charge', () => {
  it('traduce la respuesta de Wallet a un cargo con su chargeId', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: 'operation-1',
          chargeId: 'operation-1',
          sellerId: 'seller-1',
          amount: 1,
          status: 'CHARGED',
          applied: true,
        }),
      ),
    )

    await expect(
      client(fetchImpl).charge({ operationId: 'operation-1', sellerId: 'seller-1', amount: 1 }),
    ).resolves.toEqual({ chargeId: 'operation-1' })
  })

  it('firma la ruta y el cuerpo del cobro', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { chargeId: 'operation-1' })))

    await client(fetchImpl).charge({
      operationId: 'operation-1',
      sellerId: 'seller-1',
      amount: 3,
    })

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://wallet:3006/api/internal/v1/wallet/auction-publication-fees')
    expect(request?.method).toBe('POST')
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(fixedNow.getTime()),
    })

    const body = { operationId: 'operation-1', sellerId: 'seller-1', amount: 3 }
    const bodyHash = createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex')
    const canonical = [
      'auction',
      'POST',
      '/api/internal/v1/wallet/auction-publication-fees',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')
    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(
      createHmac('sha256', 'shared-secret').update(canonical).digest('hex'),
    )
  })

  it('traduce saldo insuficiente (422) a InsufficientPublicationFundsError', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(422, {})))

    await expect(
      client(fetchImpl).charge({ operationId: 'operation-1', sellerId: 'seller-1', amount: 1 }),
    ).rejects.toBeInstanceOf(InsufficientPublicationFundsError)
  })

  it('traduce un conflicto de operacion (409) a IdempotencyConflictError', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(409, {})))

    await expect(
      client(fetchImpl).charge({ operationId: 'operation-1', sellerId: 'seller-1', amount: 1 }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it.each([500, 503])('falla cerrado ante HTTP %i', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(
      client(fetchImpl).charge({ operationId: 'operation-1', sellerId: 'seller-1', amount: 1 }),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })

  it('rechaza una respuesta sin chargeId', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, {})))

    await expect(
      client(fetchImpl).charge({ operationId: 'operation-1', sellerId: 'seller-1', amount: 1 }),
    ).rejects.toBeInstanceOf(ExternalContractError)
  })

  it('falla cerrado ante errores de red', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(
      client(fetchImpl).charge({ operationId: 'operation-1', sellerId: 'seller-1', amount: 1 }),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })
})

describe('HttpPublicationFeeClient.refund', () => {
  it('firma la ruta con el chargeId codificado en el path', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, {})))

    await client(fetchImpl).refund('operation-1', 'charge/1')

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'http://wallet:3006/api/internal/v1/wallet/auction-publication-fees/charge%2F1/refunds',
    )
    expect(request?.method).toBe('POST')
  })

  it('trata un cargo ya inexistente (404) como reembolso resuelto', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(404, {})))

    await expect(client(fetchImpl).refund('operation-1', 'charge-1')).resolves.toBeUndefined()
  })

  it('traduce un conflicto de operacion (409) a IdempotencyConflictError', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(409, {})))

    await expect(client(fetchImpl).refund('operation-1', 'charge-1')).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    )
  })

  it.each([500, 503])('falla cerrado ante HTTP %i', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(client(fetchImpl).refund('operation-1', 'charge-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('falla cerrado ante errores de red', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).refund('operation-1', 'charge-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})
