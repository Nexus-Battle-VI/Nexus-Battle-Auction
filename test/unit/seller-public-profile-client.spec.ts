import { createHash, createHmac } from 'node:crypto'

import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import { HttpSellerPublicProfileClient } from '../../src/adapters/outbound/http/HttpSellerPublicProfileClient'

const fixedNow = new Date('2026-09-24T12:00:00.000Z')

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch, timeoutMs = 100) {
  return new HttpSellerPublicProfileClient({
    baseUrl: 'http://account:3001',
    secret: 'shared-secret',
    serviceName: 'auction',
    timeoutMs,
    logger: { warn: jest.fn() },
    fetchImpl,
    now: () => fixedNow,
  })
}

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

describe('HttpSellerPublicProfileClient', () => {
  it('construye la URL correcta con el subject URL-encoded y hace GET sin cuerpo', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { subject: 'seller/1', displayName: 'Ana', avatarUrl: null })),
    )

    await client(fetchImpl).getPublicProfile('seller/1')

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://account:3001/api/internal/accounts/seller%2F1/battle-profile')
    expect(request?.method).toBe('GET')
    expect(request?.body).toBeUndefined()
  })

  it('firma la peticion con las cabeceras HMAC internas correctas', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { subject: 'seller-1', displayName: 'Ana', avatarUrl: null })),
    )

    await client(fetchImpl).getPublicProfile('seller-1')

    const [, request] = fetchImpl.mock.calls[0]!
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(fixedNow.getTime()),
    })

    const bodyHash = createHash('sha256').update('{}', 'utf8').digest('hex')
    const canonical = [
      'auction',
      'GET',
      '/api/internal/accounts/seller-1/battle-profile',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')
    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(
      createHmac('sha256', 'shared-secret').update(canonical).digest('hex'),
    )
  })

  it('200 con forma correcta: devuelve subject/displayName/avatarUrl tal cual', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          subject: 'seller-1',
          displayName: 'Ana Ramirez',
          avatarUrl: '/accounts/seller-1/avatar',
        }),
      ),
    )

    await expect(client(fetchImpl).getPublicProfile('seller-1')).resolves.toEqual({
      subject: 'seller-1',
      displayName: 'Ana Ramirez',
      avatarUrl: '/accounts/seller-1/avatar',
    })
  })

  it('200 con avatarUrl null: se conserva null, no se sustituye', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { subject: 'seller-1', displayName: 'Ana', avatarUrl: null })),
    )

    await expect(client(fetchImpl).getPublicProfile('seller-1')).resolves.toEqual({
      subject: 'seller-1',
      displayName: 'Ana',
      avatarUrl: null,
    })
  })

  it('404: lanza ExternalResourceNotFoundError (perfil ausente, no fail-closed-a-true)', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(404, {})))

    await expect(client(fetchImpl).getPublicProfile('seller-sin-cuenta')).rejects.toBeInstanceOf(
      ExternalResourceNotFoundError,
    )
  })

  it.each([401, 500, 503])(
    'HTTP %i no-404: lanza ExternalDependencyUnavailableError',
    async (status) => {
      const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

      await expect(client(fetchImpl).getPublicProfile('seller-1')).rejects.toBeInstanceOf(
        ExternalDependencyUnavailableError,
      )
    },
  )

  it('error de red: lanza ExternalDependencyUnavailableError', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).getPublicProfile('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('JSON invalido (parse falla): lanza ExternalDependencyUnavailableError', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        new Response('no es json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(client(fetchImpl).getPublicProfile('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it.each([
    ['sin displayName', { subject: 'seller-1', avatarUrl: null }],
    ['displayName no-string', { subject: 'seller-1', displayName: 42, avatarUrl: null }],
    ['avatarUrl no string ni null', { subject: 'seller-1', displayName: 'Ana', avatarUrl: 1 }],
    [
      'subject distinto al solicitado',
      { subject: 'otro-seller', displayName: 'Ana', avatarUrl: null },
    ],
  ])('contrato invalido (%s): lanza ExternalContractError', async (_label, body) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, body)))

    await expect(client(fetchImpl).getPublicProfile('seller-1')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('timeout: aborta la peticion y lanza ExternalDependencyUnavailableError', async () => {
    // Simula una red colgada: solo se destraba cuando el AbortController del
    // cliente aborta la senal, igual que haria un fetch real.
    const fetchImpl = jest.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as unknown as jest.MockedFunction<typeof fetch>

    await expect(client(fetchImpl, 20).getPublicProfile('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})
