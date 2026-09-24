import { createHash, createHmac } from 'node:crypto'

import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'
import { HttpBidCreditsClient } from '../../src/adapters/outbound/http/HttpBidCreditsClient'

const now = new Date('2026-09-23T12:00:00.000Z')
const reserve = {
  operationId: 'auction:bid-1:reserve',
  bidderId: 'player-1',
  bidId: 'bid-1',
  auctionId: 'auction-1',
  amount: 40,
  expiresAt: new Date('2026-09-24T12:00:00.000Z'),
}

const response = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

const client = (fetchImpl: typeof fetch, timeoutMs = 1_000) =>
  new HttpBidCreditsClient({
    baseUrl: 'https://wallet.example.com/api/',
    secret: 'secret',
    timeoutMs,
    fetchImpl,
    now: () => now,
  })

describe('HttpBidCreditsClient', () => {
  it('consulta saldo disponible con firma interna y devuelve solamente availableCredits', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, { playerId: 'player-1', balance: 100, reserved: 40, available: 60 }),
      ),
    )

    await expect(client(fetchImpl).getAvailableCredits('player-1')).resolves.toEqual({
      availableCredits: 60,
    })

    const [url, request] = fetchImpl.mock.calls[0]!
    const path = '/api/internal/v1/wallet/buy-now-transfers/balance/player-1'
    expect(url).toBe(`https://wallet.example.com${path}`)
    expect(request?.method).toBe('GET')
    expect(request?.body).toBeUndefined()

    // Calculo independiente del cliente: el guard de Wallet verifica
    // `request.body ?? {}`, asi que un GET sin cuerpo se firma sobre `{}`.
    const canonical = [
      'auction',
      'GET',
      path,
      String(now.getTime()),
      createHash('sha256').update('{}', 'utf8').digest('hex'),
    ].join('\n')
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(now.getTime()),
      'x-internal-signature': createHmac('sha256', 'secret').update(canonical).digest('hex'),
    })
  })

  it.each([
    { playerId: 'other', balance: 100, reserved: 0, available: 100 },
    { playerId: 'player-1', balance: 100, reserved: 0, available: -1 },
    { playerId: 'player-1', balance: 100, reserved: 0, available: 1.5 },
  ])('rechaza saldo invalido', async (value) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, value)))
    await expect(client(fetchImpl).getAvailableCredits('player-1')).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('reserva credits mediante hold y acepta replay idempotente', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: reserve.operationId,
          holdId: 'hold-1',
          holdStatus: 'ACTIVE',
          applied: false,
          playerId: reserve.bidderId,
          bidId: reserve.bidId,
          auctionId: reserve.auctionId,
        }),
      ),
    )
    await expect(client(fetchImpl).reserve(reserve)).resolves.toEqual({ reservationId: 'hold-1' })
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://wallet.example.com/api/internal/v1/wallet/holds')
    expect(JSON.parse(request?.body as string)).toEqual({
      operationId: reserve.operationId,
      playerId: reserve.bidderId,
      amount: reserve.amount,
      auctionId: reserve.auctionId,
      bidId: reserve.bidId,
      auctionClosesAt: reserve.expiresAt.toISOString(),
    })
  })

  it('libera el hold por AUCTION_OUTBID y valida correlacion', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          operationId: 'auction:bid-1:release',
          holdId: 'hold/ one',
          holdStatus: 'RELEASED',
          applied: true,
        }),
      ),
    )
    await expect(
      client(fetchImpl).release('auction:bid-1:release', 'hold/ one'),
    ).resolves.toBeUndefined()
    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'https://wallet.example.com/api/internal/v1/wallet/holds/hold%2F%20one/releases',
    )
    expect(JSON.parse(request?.body as string)).toEqual({
      operationId: 'auction:bid-1:release',
      reason: 'AUCTION_OUTBID',
    })
  })

  it.each([
    [
      'operacion inconsistente',
      { operationId: 'other', holdId: 'hold-1', holdStatus: 'ACTIVE', applied: true },
    ],
    ['JSON invalido', null],
  ])('rechaza %s', async (_caseName, value) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(200, value)))
    await expect(client(fetchImpl).reserve(reserve)).rejects.toBeInstanceOf(ExternalContractError)
  })

  it.each([
    ['HTTP 500', () => Promise.resolve(response(500, {}))],
    ['red', () => Promise.reject(new Error('network'))],
  ])('clasifica %s como dependencia no disponible', async (_caseName, implementation) => {
    const fetchImpl = mockFetch(implementation)
    await expect(client(fetchImpl).reserve(reserve)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('convierte timeout en dependencia no disponible', async () => {
    const fetchImpl = jest.fn(
      (_url: string, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    ) as unknown as typeof fetch
    await expect(client(fetchImpl, 1).reserve(reserve)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})
