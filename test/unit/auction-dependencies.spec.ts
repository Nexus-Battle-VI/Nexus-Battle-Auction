import { createHash, createHmac } from 'node:crypto'

import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import { CatalogProductPolicyClient } from '../../src/adapters/outbound/http/CatalogProductPolicyClient'
import {
  UnavailableProductInventory,
  UnavailablePublicationFee,
  UnavailableSellerSanctions,
} from '../../src/adapters/outbound/http/UnavailableAuctionDependencies'

const fixedNow = new Date('2026-09-21T12:00:00.000Z')

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch) {
  return new CatalogProductPolicyClient({
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

describe('CatalogProductPolicyClient', () => {
  it.each([
    [false, true],
    [true, false],
  ])('traduce premium=%s a tradableInAuction=%s', async (premium, tradable) => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { productId: 'product-1', premium })),
    )

    await expect(client(fetchImpl).getPolicy('product-1')).resolves.toEqual({
      tradableInAuction: tradable,
    })
  })

  it('firma exactamente la ruta codificada y no envia cuerpo en GET', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { productId: 'product/1', premium: false })),
    )

    await client(fetchImpl).getPolicy('product/1')

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'http://catalog:3003/api/internal/v1/catalog/products/product%2F1/premium-status',
    )
    expect(request?.method).toBe('GET')
    expect(request?.body).toBeUndefined()
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(fixedNow.getTime()),
    })

    const bodyHash = createHash('sha256').update('null', 'utf8').digest('hex')
    const canonical = [
      'auction',
      'GET',
      '/api/internal/v1/catalog/products/product%2F1/premium-status',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')
    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(
      createHmac('sha256', 'shared-secret').update(canonical).digest('hex'),
    )
  })

  it('distingue producto inexistente de indisponibilidad', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(404, {})))

    await expect(client(fetchImpl).getPolicy('missing')).rejects.toBeInstanceOf(
      ExternalResourceNotFoundError,
    )
  })

  it.each([401, 500, 503])('falla cerrado ante HTTP %i', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(client(fetchImpl).getPolicy('product-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('rechaza una respuesta con forma o identidad incorrecta', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { productId: 'other-product', premium: false })),
    )

    await expect(client(fetchImpl).getPolicy('product-1')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('falla cerrado ante errores de red', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).getPolicy('product-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})

describe('Dependencias de HU-62 aun no publicadas', () => {
  it('Inventory falla cerrado en consulta, compromiso y liberacion', async () => {
    const inventory = new UnavailableProductInventory()
    await expect(inventory.inspect('seller', 'product')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
    await expect(
      inventory.commit({
        operationId: 'operation',
        ownerId: 'seller',
        productId: 'product',
        expiresAt: fixedNow,
      }),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
    await expect(inventory.release('operation', 'commitment')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('Wallet falla cerrado en cobro y devolucion', async () => {
    const wallet = new UnavailablePublicationFee()
    await expect(
      wallet.charge({ operationId: 'operation', sellerId: 'seller', amount: 1 }),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
    await expect(wallet.refund('operation', 'charge')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('Account no afirma que no existen sanciones si carece de contrato', async () => {
    await expect(
      new UnavailableSellerSanctions().hasActiveSanctions('seller'),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })
})
