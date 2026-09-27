import { createHash, createHmac } from 'node:crypto'

import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import { OfficialAuctionEligibilityClient } from '../../src/adapters/outbound/http/OfficialAuctionEligibilityClient'
import { UnavailableOfficialAuctionEligibility } from '../../src/adapters/outbound/http/UnavailableAuctionDependencies'

const fixedNow = new Date('2026-09-23T12:00:00.000Z')

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch) {
  return new OfficialAuctionEligibilityClient({
    baseUrl: 'http://catalog:3003',
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

describe('OfficialAuctionEligibilityClient', () => {
  it('traduce un producto de tiraje unico a OFFICIAL publicable', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          productId: 'product-1',
          exclusive: true,
          officialMark: 'OFFICIAL',
          publishable: true,
        }),
      ),
    )

    await expect(client(fetchImpl).getEligibility('product-1')).resolves.toEqual({
      productId: 'product-1',
      exclusive: true,
      officialMark: 'OFFICIAL',
      publishable: true,
    })
  })

  it('traduce un producto premium a PREMIUM publicable', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          productId: 'product-2',
          exclusive: true,
          officialMark: 'PREMIUM',
          publishable: true,
        }),
      ),
    )

    await expect(client(fetchImpl).getEligibility('product-2')).resolves.toEqual({
      productId: 'product-2',
      exclusive: true,
      officialMark: 'PREMIUM',
      publishable: true,
    })
  })

  it('acepta un producto ordinario o suspendido como no publicable', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          productId: 'product-3',
          exclusive: false,
          officialMark: null,
          publishable: false,
        }),
      ),
    )

    await expect(client(fetchImpl).getEligibility('product-3')).resolves.toEqual({
      productId: 'product-3',
      exclusive: false,
      officialMark: null,
      publishable: false,
    })
  })

  it('firma exactamente la ruta codificada y no envia cuerpo en GET', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          productId: 'product/1',
          exclusive: true,
          officialMark: 'OFFICIAL',
          publishable: true,
        }),
      ),
    )

    await client(fetchImpl).getEligibility('product/1')

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'http://catalog:3003/api/internal/v1/catalog/products/product%2F1/official-auction-eligibility',
    )
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
      '/api/internal/v1/catalog/products/product%2F1/official-auction-eligibility',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')
    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(
      createHmac('sha256', 'shared-secret').update(canonical).digest('hex'),
    )
  })

  it('distingue producto inexistente de indisponibilidad', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(404, {})))

    await expect(client(fetchImpl).getEligibility('missing')).rejects.toBeInstanceOf(
      ExternalResourceNotFoundError,
    )
  })

  it.each([401, 500, 503])('falla cerrado ante HTTP %i', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(client(fetchImpl).getEligibility('product-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('rechaza una respuesta con identidad incorrecta', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          productId: 'other-product',
          exclusive: true,
          officialMark: 'OFFICIAL',
          publishable: true,
        }),
      ),
    )

    await expect(client(fetchImpl).getEligibility('product-1')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it.each([
    { officialMark: 'GOLD' },
    { exclusive: 'yes' },
    { publishable: 'no' },
    { productId: undefined },
  ])('rechaza un contrato invalido %j', async (overrides) => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          productId: 'product-1',
          exclusive: true,
          officialMark: 'OFFICIAL',
          publishable: true,
          ...overrides,
        }),
      ),
    )

    await expect(client(fetchImpl).getEligibility('product-1')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('falla cerrado ante errores de red', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).getEligibility('product-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})

describe('UnavailableOfficialAuctionEligibility', () => {
  it('falla cerrado cuando el secreto interno no esta configurado', async () => {
    await expect(
      new UnavailableOfficialAuctionEligibility().getEligibility('product-1'),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })
})
