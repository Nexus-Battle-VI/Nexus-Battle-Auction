import { HttpAuctionWalletClient } from '../../src/adapters/outbound/http/HttpAuctionWalletClient'
import { UnavailableAuctionWalletClient } from '../../src/adapters/outbound/http/UnavailableAuctionWalletClient'
import {
  canonicalBody,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'

const capture = {
  holdId: 'hold-1',
  operationId: 'op-capture',
  beneficiaryPlayerId: 'seller-1',
  auctionId: 'auction-1',
  winningBidId: 'bid-7',
}
const release = { holdId: 'hold-1', operationId: 'hu63-release', reason: 'AUCTION_OUTBID' as const }
const response = (status: number, value: unknown): Response =>
  ({ status, json: () => Promise.resolve(value) }) as unknown as Response
const valid = (applied = true) => ({
  operationId: 'op-capture',
  holdId: 'hold-1',
  holdStatus: 'CAPTURED',
  beneficiaryPlayerId: 'seller-1',
  applied,
})
const client = (fetchImpl: typeof fetch, baseUrl = 'https://wallet.example.com/') =>
  new HttpAuctionWalletClient({
    baseUrl,
    secret: 'secret',
    timeoutMs: 1000,
    fetchImpl,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  })

describe('HttpAuctionWalletClient', () => {
  it('envia capture firmado con cuerpo exacto y URL normalizada', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve(response(200, valid())),
    ) as unknown as typeof fetch
    await expect(client(fetchImpl).captureHold(capture)).resolves.toMatchObject({
      outcome: 'SUCCESS',
      applied: true,
    })
    const [url, request] = (fetchImpl as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://wallet.example.com/api/internal/v1/wallet/holds/hold-1/captures')
    expect(request).toMatchObject({ method: 'POST' })
    expect(JSON.parse(request.body as string)).toEqual({
      operationId: 'op-capture',
      beneficiaryPlayerId: 'seller-1',
      auctionId: 'auction-1',
      winningBidId: 'bid-7',
    })
    expect(request.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': '1790164800000',
    })
  })

  it.each([
    [404, 'TERMINAL_NOT_FOUND'],
    [409, 'TERMINAL_CONFLICT'],
    [422, 'TERMINAL_RULE_ERROR'],
    [503, 'RETRYABLE'],
  ] as const)('mapea HTTP %i', async (status, outcome) => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve(response(status, {})),
    ) as unknown as typeof fetch
    await expect(
      client(fetchImpl).releaseHold({ ...release, reason: 'AUCTION_SETTLEMENT_LOST' }),
    ).resolves.toMatchObject({ outcome, operationId: 'hu63-release' })
  })

  it('acepta replay y codifica holdId', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve(response(200, { ...valid(false), holdId: 'hold/ space' })),
    ) as unknown as typeof fetch
    await expect(
      client(fetchImpl, 'https://wallet.example.com').captureHold({
        ...capture,
        holdId: 'hold/ space',
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCESS', applied: false })
    expect((fetchImpl as jest.Mock).mock.calls[0][0]).toContain('hold%2F%20space')
  })

  it.each([
    {},
    { ...valid(), applied: 'true' },
    { ...valid(), holdStatus: 'SETTLED' },
    { ...valid(), operationId: 'other' },
    { ...valid(), holdId: 'other' },
  ])('rechaza respuesta invalida', async (value) => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve(response(200, value)),
    ) as unknown as typeof fetch
    await expect(client(fetchImpl).captureHold(capture)).resolves.toMatchObject({
      outcome: 'INVALID_RESPONSE',
    })
  })

  it('mapea red y fail-closed a retryable', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.reject(new Error('ECONNRESET')),
    ) as unknown as typeof fetch
    await expect(client(fetchImpl).captureHold(capture)).resolves.toMatchObject({
      outcome: 'RETRYABLE',
    })
    await expect(new UnavailableAuctionWalletClient().releaseHold(release)).resolves.toMatchObject({
      outcome: 'RETRYABLE',
      operationId: 'hu63-release',
    })
  })

  it('firma el JSON canonico enviado y rechaza beneficiario distinto', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve(response(200, { ...valid(), beneficiaryPlayerId: 'seller-B' })),
    ) as unknown as typeof fetch
    await expect(
      client(fetchImpl).captureHold({ ...capture, beneficiaryPlayerId: 'seller-A' }),
    ).resolves.toMatchObject({ outcome: 'INVALID_RESPONSE' })
    const request = (fetchImpl as jest.Mock).mock.calls[0][1] as RequestInit
    const body = JSON.parse(request.body as string) as Record<string, unknown>
    const path = '/api/internal/v1/wallet/holds/hold-1/captures'
    expect(canonicalBody(body)).toBe(
      canonicalBody(JSON.parse(request.body as string) as Record<string, unknown>),
    )
    expect((request.headers as Record<string, string>)['x-internal-signature']).toBe(
      signInternalRequest('secret', {
        service: 'auction',
        method: 'POST',
        path,
        timestamp: '1790164800000',
        body,
      }),
    )
  })

  it('aborta timeout y devuelve retryable', async () => {
    const fetchImpl = jest.fn(
      (_url: string, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    ) as unknown as typeof fetch
    const timed = new HttpAuctionWalletClient({
      baseUrl: 'https://wallet.example.com',
      secret: 'secret',
      timeoutMs: 1,
      fetchImpl,
    })
    await expect(timed.releaseHold(release)).resolves.toMatchObject({
      outcome: 'RETRYABLE',
      operationId: 'hu63-release',
      holdId: 'hold-1',
    })
  })
})
