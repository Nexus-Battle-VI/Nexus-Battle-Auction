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

describe('CatalogProductLookupClient.findSuggestions', () => {
  it('hace POST al mismo endpoint y devuelve productId, name y type', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          items: [{ productId: 'id-1', sku: 'sword', name: 'Espada de dragon', type: 'ARMA' }],
        }),
      ),
    )

    await expect(client(fetchImpl).findSuggestions(['id-1', 'missing'], 'dragon')).resolves.toEqual(
      [{ productId: 'id-1', name: 'Espada de dragon', type: 'ARMA' }],
    )
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://catalog:3003/api/v1/catalog/products/lookup')
    expect(request?.body).toBe(JSON.stringify({ references: ['id-1', 'missing'], query: 'dragon' }))
  })

  it('descarta items que no estaban entre las references enviadas', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          items: [
            { productId: 'id-1', sku: 'sword', name: 'Espada', type: 'ARMA' },
            { productId: 'ajeno', sku: 'ajeno-sku', name: 'Otro', type: 'ITEM' },
          ],
        }),
      ),
    )

    await expect(client(fetchImpl).findSuggestions(['id-1'], 'x')).resolves.toEqual([
      { productId: 'id-1', name: 'Espada', type: 'ARMA' },
    ])
  })

  it('elimina duplicados de entrada antes de consultar Catalog', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, { items: [{ productId: 'id-1', sku: 's', name: 'A', type: 'ITEM' }] }),
      ),
    )

    await client(fetchImpl).findSuggestions(['id-1', 'id-1'], 'x')

    expect(requestBody(fetchImpl, 0)).toEqual({ references: ['id-1'], query: 'x' })
  })

  it('ordena el resultado final por nombre ascendente', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          items: [
            { productId: 'z', sku: 'z', name: 'Zafiro', type: 'ITEM' },
            { productId: 'a', sku: 'a', name: 'Armadura', type: 'ARMADURA' },
          ],
        }),
      ),
    )

    await expect(client(fetchImpl).findSuggestions(['z', 'a'], 'x')).resolves.toEqual([
      { productId: 'a', name: 'Armadura', type: 'ARMADURA' },
      { productId: 'z', name: 'Zafiro', type: 'ITEM' },
    ])
  })

  it('divide mas de 500 references en varios requests y combina los resultados ordenados', async () => {
    const references = Array.from({ length: 501 }, (_, index) => `product-${String(index)}`)
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [] })))
    fetchImpl.mockResolvedValueOnce(
      response(200, {
        items: [{ productId: 'product-0', sku: 'zero', name: 'Alfa', type: 'ITEM' }],
      }),
    )
    fetchImpl.mockResolvedValueOnce(
      response(200, {
        items: [{ productId: 'product-500', sku: 'last', name: 'Zeta', type: 'ITEM' }],
      }),
    )

    await expect(client(fetchImpl).findSuggestions(references, 'x')).resolves.toEqual([
      { productId: 'product-0', name: 'Alfa', type: 'ITEM' },
      { productId: 'product-500', name: 'Zeta', type: 'ITEM' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([401, 500, 503])('traduce HTTP %i a dependencia no disponible', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))
    await expect(client(fetchImpl).findSuggestions(['product-1'], 'x')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('traduce red o timeout a dependencia no disponible', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network')))
    await expect(client(fetchImpl).findSuggestions(['product-1'], 'x')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('rechaza un payload sin name/type con contrato invalido', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { items: [{ productId: 'id-1', sku: 'sword' }] })),
    )
    await expect(client(fetchImpl).findSuggestions(['id-1'], 'x')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })
})

describe('CatalogProductLookupClient.findProducts (HU-91.3)', () => {
  const item = (productId: string, extra: Record<string, unknown> = {}) => ({
    productId,
    sku: `sku-${productId}`,
    name: `Nombre ${productId}`,
    type: 'ARMA',
    imageUrl: `https://img/${productId}.png`,
    ...extra,
  })

  it('hace POST al lookup publico SIN query y devuelve solo los 5 campos del contrato', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          items: [
            item('id-1', { description: 'x', creditsPrice: 5, premium: true, brand: 'ACME' }),
          ],
        }),
      ),
    )

    const found = await client(fetchImpl).findProducts(['id-1', 'missing'])

    expect(found).toEqual([item('id-1')])
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://catalog:3003/api/v1/catalog/products/lookup')
    expect(request).toMatchObject({ method: 'POST' })
    expect(request?.body).toBe(JSON.stringify({ references: ['id-1', 'missing'] }))
  })

  it('omite las referencias inexistentes sin fallar (el lookup no las devuelve)', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [] })))

    await expect(client(fetchImpl).findProducts(['nope'])).resolves.toEqual([])
  })

  it('elimina referencias duplicadas y acepta el alias sku', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [item('uuid-1')] })))

    const found = await client(fetchImpl).findProducts(['sku-uuid-1', 'sku-uuid-1', 'uuid-1'])

    expect(found).toEqual([item('uuid-1')])
    expect(requestBody(fetchImpl, 0)).toEqual({ references: ['sku-uuid-1', 'uuid-1'] })
  })

  it('no devuelve productos que no se pidieron aunque Catalog los incluya', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { items: [item('pedido'), item('ajeno')] })),
    )

    const found = await client(fetchImpl).findProducts(['pedido'])

    expect(found.map((product) => product.productId)).toEqual(['pedido'])
  })

  it('trocea en bloques de 500 referencias y concatena los resultados', async () => {
    const references = Array.from(
      { length: CATALOG_LOOKUP_MAX_REFERENCES + 1 },
      (_, i) => `id-${String(i)}`,
    )
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [] })))
    fetchImpl
      .mockResolvedValueOnce(response(200, { items: [item('id-0')] }))
      .mockResolvedValueOnce(response(200, { items: [item('id-500')] }))

    const found = await client(fetchImpl).findProducts(references)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect((requestBody(fetchImpl, 0) as { references: string[] }).references).toHaveLength(500)
    expect((requestBody(fetchImpl, 1) as { references: string[] }).references).toEqual(['id-500'])
    expect(found.map((product) => product.productId).sort()).toEqual(['id-0', 'id-500'])
  })

  it.each([
    ['sin imageUrl', { ...item('id-1'), imageUrl: undefined }],
    ['sin name', { ...item('id-1'), name: undefined }],
    ['sin type', { ...item('id-1'), type: undefined }],
    ['sin sku', { ...item('id-1'), sku: undefined }],
    ['con name no textual', { ...item('id-1'), name: 42 }],
  ])('un item %s es una ruptura de contrato (ExternalContractError)', async (_name, broken) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, { items: [broken] })))

    await expect(client(fetchImpl).findProducts(['id-1'])).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it.each([
    ['sin items', {}],
    ['items no es lista', { items: 'x' }],
    ['null', null],
  ])('un cuerpo %s es ExternalContractError', async (_name, body) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, body)))

    await expect(client(fetchImpl).findProducts(['id-1'])).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('HTTP no OK, fallo de red o JSON invalido -> ExternalDependencyUnavailableError', async () => {
    await expect(
      client(mockFetch(() => Promise.resolve(response(503, {})))).findProducts(['id-1']),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
    await expect(
      client(mockFetch(() => Promise.reject(new TypeError('fetch failed')))).findProducts(['id-1']),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
    await expect(
      client(
        mockFetch(() => Promise.resolve(new Response('no es json', { status: 200 }))),
      ).findProducts(['id-1']),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })

  it('findReferencesMatchingName no cambia: sigue enviando query', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { items: [{ productId: 'id-1', sku: 'sword' }] })),
    )

    await client(fetchImpl).findReferencesMatchingName(['id-1'], 'espada')

    expect(requestBody(fetchImpl, 0)).toEqual({ references: ['id-1'], query: 'espada' })
  })
})
