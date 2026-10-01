import {
  CATALOG_LOOKUP_MAX_REFERENCES,
  CatalogProductLookupClient,
} from '../../src/adapters/outbound/http/CatalogProductLookupClient'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

const requestBody = (fetchImpl: jest.MockedFunction<typeof fetch>, call: number): unknown => {
  const body = fetchImpl.mock.calls[call]?.[1]?.body
  if (typeof body !== 'string') throw new Error('El cliente debe enviar un body JSON string.')
  return JSON.parse(body)
}

const client = (fetchImpl: typeof fetch) =>
  new CatalogProductLookupClient({
    baseUrl: 'http://catalog:3003/',
    timeoutMs: 100,
    logger: { warn: jest.fn() },
    fetchImpl,
  })

describe('CatalogProductLookupClient', () => {
  it('hace POST al endpoint publico con JSON, query y references exactos', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { items: [{ productId: 'id-1', sku: 'sword' }] })),
    )

    await expect(
      client(fetchImpl).findReferencesMatchingName(['id-1', 'missing'], 'espada'),
    ).resolves.toEqual(new Set(['id-1']))
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://catalog:3003/api/v1/catalog/products/lookup')
    expect(request).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(request?.body).toBe(JSON.stringify({ references: ['id-1', 'missing'], query: 'espada' }))
  })

  it('mapea referencias SKU y elimina duplicados de entrada y salida', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { items: [{ productId: 'uuid-1', sku: 'sword' }] })),
    )

    await expect(
      client(fetchImpl).findReferencesMatchingName(['sword', 'sword', 'uuid-1'], 'espada'),
    ).resolves.toEqual(new Set(['sword', 'uuid-1']))
    expect(requestBody(fetchImpl, 0)).toEqual({
      references: ['sword', 'uuid-1'],
      query: 'espada',
    })
  })

  it.each([1, CATALOG_LOOKUP_MAX_REFERENCES])(
    'envia un solo bloque de %i references',
    async (size) => {
      const references = Array.from({ length: size }, (_, index) => `product-${String(index)}`)
      const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [] })))

      await client(fetchImpl).findReferencesMatchingName(references, 'x')

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect((requestBody(fetchImpl, 0) as { references: unknown[] }).references).toHaveLength(size)
    },
  )

  it('divide 501 references en exactamente dos requests y combina los resultados', async () => {
    const references = Array.from({ length: 501 }, (_, index) => `product-${String(index)}`)
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [] })))
    fetchImpl.mockResolvedValueOnce(
      response(200, { items: [{ productId: 'product-0', sku: 'zero' }] }),
    )
    fetchImpl.mockResolvedValueOnce(
      response(200, { items: [{ productId: 'product-500', sku: 'last' }] }),
    )

    await expect(client(fetchImpl).findReferencesMatchingName(references, 'x')).resolves.toEqual(
      new Set(['product-0', 'product-500']),
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect((requestBody(fetchImpl, 0) as { references: unknown[] }).references).toHaveLength(500)
    expect((requestBody(fetchImpl, 1) as { references: unknown[] }).references).toEqual([
      'product-500',
    ])
  })

  it.each([401, 500, 503])('traduce HTTP %i a dependencia no disponible', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))
    await expect(
      client(fetchImpl).findReferencesMatchingName(['product-1'], 'x'),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })

  it.each([
    () => Promise.reject(new TypeError('network')),
    () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
  ])('traduce red o timeout a dependencia no disponible', async (implementation) => {
    const fetchImpl = mockFetch(implementation)
    await expect(
      client(fetchImpl).findReferencesMatchingName(['product-1'], 'x'),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })

  it('traduce JSON ilegible a dependencia no disponible', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError()),
      } as Response),
    )
    await expect(
      client(fetchImpl).findReferencesMatchingName(['id-1'], 'x'),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })

  it('rechaza un payload con contrato invalido', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { items: [{ productId: 'id-1' }] })),
    )
    await expect(
      client(fetchImpl).findReferencesMatchingName(['id-1'], 'x'),
    ).rejects.toBeInstanceOf(ExternalContractError)
  })
})
