import { createHash, createHmac } from 'node:crypto'

import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { HttpSellerSanctionClient } from '../../src/adapters/outbound/http/HttpSellerSanctionClient'

const fixedNow = new Date('2026-09-24T12:00:00.000Z')

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch) {
  return new HttpSellerSanctionClient({
    baseUrl: 'http://account:3001',
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

describe('HttpSellerSanctionClient', () => {
  it.each([
    [true, true],
    [false, false],
  ])('traduce hasActiveSanctions=%s tal cual', async (hasActiveSanctions, expected) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { hasActiveSanctions })))

    await expect(client(fetchImpl).hasActiveSanctions('seller-1')).resolves.toBe(expected)
  })

  it('firma exactamente la ruta codificada y no envia cuerpo en GET', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { hasActiveSanctions: false })))

    await client(fetchImpl).hasActiveSanctions('seller/1')

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://account:3001/api/internal/accounts/seller%2F1/active-sanctions')
    expect(request?.method).toBe('GET')
    expect(request?.body).toBeUndefined()
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(fixedNow.getTime()),
    })

    // El guard receptor verifica `request.body ?? {}`: un GET sin cuerpo se firma sobre `{}`.
    const bodyHash = createHash('sha256').update('{}', 'utf8').digest('hex')
    const canonical = [
      'auction',
      'GET',
      '/api/internal/accounts/seller%2F1/active-sanctions',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')
    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(
      createHmac('sha256', 'shared-secret').update(canonical).digest('hex'),
    )
  })

  /**
   * Un vendedor sin cuenta en Account no es una identidad de la que se pueda
   * afirmar que esta libre de sancion: publicar exige fail-closed, igual que
   * cualquier otro contrato interno de HU-62/HU-66.
   */
  it('trata un sujeto sin cuenta (404) como sancionado', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(404, {})))

    await expect(client(fetchImpl).hasActiveSanctions('seller-sin-cuenta')).resolves.toBe(true)
  })

  it.each([401, 500, 503])('falla cerrado ante HTTP %i', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(client(fetchImpl).hasActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('falla cerrado ante una respuesta con forma incorrecta', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, {})))

    await expect(client(fetchImpl).hasActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('falla cerrado ante errores de red', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).hasActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})
