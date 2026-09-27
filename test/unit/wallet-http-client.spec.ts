import { createHash, createHmac } from 'node:crypto'

import { WalletHttpClient } from '../../src/adapters/outbound/http/WalletHttpClient'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'

const fixedNow = new Date('2026-09-24T12:00:00.000Z')
const timestamp = String(fixedNow.getTime())

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

const client = (fetchImpl: typeof fetch, timeoutMs = 100) =>
  new WalletHttpClient({
    baseUrl: 'http://wallet:3009',
    secret: 'shared-secret',
    serviceName: 'auction',
    timeoutMs,
    logger: { warn: jest.fn() },
    fetchImpl,
    now: () => fixedNow,
  })

/** Firma calculada sin reutilizar el codigo del cliente. */
const expectedSignature = (method: string, path: string, canonicalBody: string): string => {
  const canonical = [
    'auction',
    method,
    path,
    timestamp,
    createHash('sha256').update(canonicalBody, 'utf8').digest('hex'),
  ].join('\n')

  return createHmac('sha256', 'shared-secret').update(canonical, 'utf8').digest('hex')
}

const balancePath = '/api/internal/v1/wallet/buy-now-transfers/balance/buyer%2F1'

describe('WalletHttpClient: GET de saldo (HU-64)', () => {
  it('hace GET a la ruta exacta, como auction, sin cuerpo HTTP y firmando sobre {}', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, { playerId: 'buyer/1', balance: 5000, reserved: 1200, available: 3800 }),
      ),
    )

    await expect(client(fetchImpl).getAvailableCredits('buyer/1')).resolves.toBe(3800)

    const [url, request] = fetchImpl.mock.calls[0]!

    expect(url).toBe(`http://wallet:3009${balancePath}`)
    expect(request?.method).toBe('GET')
    expect(request?.body).toBeUndefined()
    expect(request?.headers).not.toHaveProperty('content-type')
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': timestamp,
    })

    // El guard interno de Wallet verifica `request.body ?? {}`: la firma de un
    // GET sin cuerpo debe calcularse sobre `{}`, nunca sobre `null`.
    const signature = (request?.headers as Record<string, string>)['x-internal-signature']

    expect(signature).toBe(expectedSignature('GET', balancePath, '{}'))
    expect(signature).not.toBe(expectedSignature('GET', balancePath, 'null'))
  })

  it('401 de Wallet se traduce a dependencia no disponible', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(401, {})))

    await expect(client(fetchImpl).getAvailableCredits('buyer/1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('un saldo sin available numerico es error de contrato', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { playerId: 'buyer/1' })))

    await expect(client(fetchImpl).getAvailableCredits('buyer/1')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('un fallo de red es dependencia no disponible', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).getAvailableCredits('buyer/1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('un timeout aborta la peticion y es dependencia no disponible', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    ) as unknown as typeof fetch

    await expect(client(fetchImpl, 5).getAvailableCredits('buyer/1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})

describe('WalletHttpClient: POST sin cambios', () => {
  it('la transferencia sigue firmando exactamente el cuerpo enviado', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: 'op-1',
          transferId: 'op-1',
          status: 'APPLIED',
          applied: true,
        }),
      ),
    )

    await expect(
      client(fetchImpl).transferBuyNowCredits({
        operationId: 'op-1',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        amount: 2500,
      }),
    ).resolves.toEqual({ transferId: 'op-1' })

    const [, request] = fetchImpl.mock.calls[0]!
    const path = '/api/internal/v1/wallet/buy-now-transfers'

    expect(request?.method).toBe('POST')
    expect(request?.body).toBe(
      JSON.stringify({
        operationId: 'op-1',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        amount: 2500,
      }),
    )
    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(
      expectedSignature(
        'POST',
        path,
        '{"amount":2500,"buyerId":"buyer-1","operationId":"op-1","sellerId":"seller-1"}',
      ),
    )
  })
})
