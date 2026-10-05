import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import { findAuctionTermsViolation } from '../../src/application/ports/SellerSanctionPort'
import { HttpSellerSanctionClient } from '../../src/adapters/outbound/http/HttpSellerSanctionClient'
import { UnavailableSellerSanctions } from '../../src/adapters/outbound/http/UnavailableAuctionDependencies'

const fixedNow = new Date('2026-09-24T12:00:00.000Z')

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

function setup(fetchImpl: typeof fetch) {
  const warn = jest.fn()
  const client = new HttpSellerSanctionClient({
    baseUrl: 'http://account:3001',
    secret: 'shared-secret',
    serviceName: 'auction',
    timeoutMs: 100,
    logger: { warn },
    fetchImpl,
    now: () => fixedNow,
  })
  return { client, warn }
}

const violation = {
  id: 'sanction-1',
  type: 'TEMPORARY_SUSPENSION',
  reasonCode: 'AUCTION_TERMS_VIOLATION',
  expiresAt: '2026-10-24T12:00:00.000Z',
}

const ok = (body: unknown) => mockFetch(() => Promise.resolve(response(200, body)))

describe('HttpSellerSanctionClient.getActiveSanctions (HU-90, CA-05)', () => {
  it('devuelve el contrato tipado y usa el mismo endpoint firmado que la publicacion', async () => {
    const fetchImpl = ok({ hasActiveSanctions: true, sanctions: [violation] })
    const { client } = setup(fetchImpl)

    const status = await client.getActiveSanctions('seller/1')

    expect(status).toEqual({
      hasActiveSanctions: true,
      sanctions: [
        {
          id: 'sanction-1',
          type: 'TEMPORARY_SUSPENSION',
          reasonCode: 'AUCTION_TERMS_VIOLATION',
          expiresAt: new Date('2026-10-24T12:00:00.000Z'),
        },
      ],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://account:3001/api/internal/accounts/seller%2F1/active-sanctions')
    expect(request?.method).toBe('GET')
    expect(request?.headers).toMatchObject({ 'x-internal-service': 'auction' })
  })

  it('AUCTION_TERMS_VIOLATION dispara', async () => {
    const { client } = setup(ok({ hasActiveSanctions: true, sanctions: [violation] }))

    expect(findAuctionTermsViolation(await client.getActiveSanctions('seller-1'))?.id).toBe(
      'sanction-1',
    )
  })

  it('un veto permanente llega con expiresAt null', async () => {
    const { client } = setup(
      ok({
        hasActiveSanctions: true,
        sanctions: [{ ...violation, type: 'PERMANENT_BAN', expiresAt: null }],
      }),
    )

    await expect(client.getActiveSanctions('seller-1')).resolves.toMatchObject({
      sanctions: [{ type: 'PERMANENT_BAN', expiresAt: null }],
    })
  })

  it('una sancion OTHER no dispara', async () => {
    const { client } = setup(
      ok({ hasActiveSanctions: true, sanctions: [{ ...violation, reasonCode: 'OTHER' }] }),
    )

    expect(findAuctionTermsViolation(await client.getActiveSanctions('seller-1'))).toBeNull()
  })

  it('hasActiveSanctions=true con sanctions vacio (BANNED legado) no dispara', async () => {
    const { client } = setup(ok({ hasActiveSanctions: true, sanctions: [] }))

    const status = await client.getActiveSanctions('seller-1')

    expect(status).toEqual({ hasActiveSanctions: true, sanctions: [] })
    expect(findAuctionTermsViolation(status)).toBeNull()
  })

  it('un reasonCode que Auction no conoce se conserva y no dispara', async () => {
    const { client } = setup(
      ok({ hasActiveSanctions: true, sanctions: [{ ...violation, reasonCode: 'FUTURE_CODE' }] }),
    )

    expect(findAuctionTermsViolation(await client.getActiveSanctions('seller-1'))).toBeNull()
  })

  it('un type WARNING esta fuera de contrato: error controlado, nunca una cancelacion', async () => {
    const { client, warn } = setup(
      ok({ hasActiveSanctions: true, sanctions: [{ ...violation, type: 'WARNING' }] }),
    )

    await expect(client.getActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
    expect(warn).toHaveBeenCalledWith('seller_sanction_respuesta_invalida')
  })

  it.each([
    ['sin lista de sanciones', { hasActiveSanctions: true }],
    ['sanctions no es una lista', { hasActiveSanctions: true, sanctions: {} }],
    ['hasActiveSanctions no booleano', { hasActiveSanctions: 'true', sanctions: [] }],
    ['payload no objeto', []],
    ['payload nulo', null],
    ['entrada no objeto', { hasActiveSanctions: true, sanctions: ['x'] }],
    ['id vacio', { hasActiveSanctions: true, sanctions: [{ ...violation, id: '' }] }],
    ['id no texto', { hasActiveSanctions: true, sanctions: [{ ...violation, id: 7 }] }],
    ['type ausente', { hasActiveSanctions: true, sanctions: [{ ...violation, type: undefined }] }],
    [
      'reasonCode vacio',
      { hasActiveSanctions: true, sanctions: [{ ...violation, reasonCode: '' }] },
    ],
    [
      'reasonCode ausente',
      {
        hasActiveSanctions: true,
        sanctions: [{ id: 'x', type: 'PERMANENT_BAN', expiresAt: null }],
      },
    ],
    [
      'expiresAt ausente',
      {
        hasActiveSanctions: true,
        sanctions: [{ id: 'x', type: 'PERMANENT_BAN', reasonCode: 'OTHER' }],
      },
    ],
    [
      'expiresAt no fecha',
      { hasActiveSanctions: true, sanctions: [{ ...violation, expiresAt: 'nunca' }] },
    ],
    [
      'expiresAt numerico',
      { hasActiveSanctions: true, sanctions: [{ ...violation, expiresAt: 5 }] },
    ],
  ])('falla cerrado ante un payload malformado: %s', async (_label, body) => {
    const { client } = setup(ok(body))

    await expect(client.getActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('un 404 NO se trata como sancion: se propaga como recurso no encontrado, sin el subject', async () => {
    const { client } = setup(mockFetch(() => Promise.resolve(response(404, {}))))

    const error = await client.getActiveSanctions('seller-sin-cuenta').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ExternalResourceNotFoundError)
    expect((error as Error).message).not.toContain('seller-sin-cuenta')
  })

  it.each([401, 403, 500, 503])('falla cerrado ante HTTP %i', async (status) => {
    const { client } = setup(mockFetch(() => Promise.resolve(response(status, {}))))

    await expect(client.getActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('falla cerrado ante un error de red o timeout', async () => {
    const { client } = setup(mockFetch(() => Promise.reject(new TypeError('network error'))))

    await expect(client.getActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('falla cerrado ante un cuerpo que no es JSON', async () => {
    const { client } = setup(
      mockFetch(() => Promise.resolve(new Response('<html>', { status: 200 }))),
    )

    await expect(client.getActiveSanctions('seller-1')).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})

describe('compatibilidad de la publicacion con el contrato estructurado', () => {
  it('hasActiveSanctions sigue derivando el booleano de la misma respuesta, con una sola llamada', async () => {
    const fetchImpl = ok({ hasActiveSanctions: true, sanctions: [violation] })
    const { client } = setup(fetchImpl)

    await expect(client.hasActiveSanctions('seller-1')).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('hasActiveSanctions no exige la lista de sanciones', async () => {
    const { client } = setup(ok({ hasActiveSanctions: false }))

    await expect(client.hasActiveSanctions('seller-1')).resolves.toBe(false)
  })
})

describe('UnavailableSellerSanctions', () => {
  it('sin Account configurado, el detalle de sanciones tampoco esta disponible', async () => {
    await expect(
      new UnavailableSellerSanctions().getActiveSanctions('seller-1'),
    ).rejects.toBeInstanceOf(ExternalDependencyUnavailableError)
  })
})
