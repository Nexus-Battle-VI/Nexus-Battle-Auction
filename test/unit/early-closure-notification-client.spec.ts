import { createHash, createHmac } from 'node:crypto'

import {
  AUCTION_CLOSED_BY_BUY_NOW_NOTIFICATION_PATH,
  HttpEarlyClosureNotificationClient,
} from '../../src/adapters/outbound/http/HttpEarlyClosureNotificationClient'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'
import type { NotifyAuctionClosedEarlyCommand } from '../../src/application/ports/NotificationPort'

const fixedNow = new Date('2026-09-24T14:00:05.000Z')

const command: NotifyAuctionClosedEarlyCommand = {
  operationId: 'txn-1:bidder-a',
  auctionId: 'auction-1',
  recipientId: 'bidder-a',
  transactionId: 'txn-1',
  closedAt: new Date('2026-09-24T14:00:00.000Z'),
}

const response = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

const canonicalBody = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalBody).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalBody(item)}`)

  return `{${entries.join(',')}}`
}

const requireStringBody = (body: BodyInit | null | undefined): string => {
  if (typeof body !== 'string') {
    throw new Error('La prueba esperaba un cuerpo HTTP serializado como string.')
  }

  return body
}

const client = (fetchImpl: typeof fetch, timeoutMs = 100) =>
  new HttpEarlyClosureNotificationClient({
    baseUrl: 'http://notifications:3005',
    secret: 'shared-secret',
    serviceName: 'auction',
    timeoutMs,
    logger: { warn: jest.fn() },
    fetchImpl,
    now: () => fixedNow,
  })

const created = () =>
  mockFetch(() =>
    Promise.resolve(response(201, { notificationId: command.operationId, status: 'created' })),
  )

describe('HttpEarlyClosureNotificationClient HU-64.5', () => {
  it('A. 201 created es exito y devuelve el notificationId', async () => {
    await expect(client(created()).notifyAuctionClosedEarly(command)).resolves.toEqual({
      notificationId: command.operationId,
    })
  })

  it('B. 200 duplicated es exito idempotente', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { notificationId: command.operationId, status: 'duplicated' })),
    )

    await expect(client(fetchImpl).notifyAuctionClosedEarly(command)).resolves.toEqual({
      notificationId: command.operationId,
    })
  })

  it('C/D/E/G. usa la ruta exacta, el payload exacto con closedAt ISO y el caller auction', async () => {
    const fetchImpl = created()

    await client(fetchImpl).notifyAuctionClosedEarly(command)

    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const [url, request] = fetchImpl.mock.calls[0]!

    expect(AUCTION_CLOSED_BY_BUY_NOW_NOTIFICATION_PATH).toBe(
      '/api/internal/v1/notifications/auction/closed-by-buy-now',
    )
    expect(url).toBe(
      'http://notifications:3005/api/internal/v1/notifications/auction/closed-by-buy-now',
    )
    expect(request?.method).toBe('POST')
    expect(JSON.parse(requireStringBody(request?.body))).toEqual({
      operationId: 'txn-1:bidder-a',
      auctionId: 'auction-1',
      recipientId: 'bidder-a',
      transactionId: 'txn-1',
      closedAt: '2026-09-24T14:00:00.000Z',
    })
    expect(request?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(fixedNow.getTime()),
    })
  })

  it('F. firma exactamente servicio, POST, ruta de closed-by-buy-now, timestamp y payload', async () => {
    const fetchImpl = created()

    await client(fetchImpl).notifyAuctionClosedEarly(command)

    const [, request] = fetchImpl.mock.calls[0]!
    const body = JSON.parse(requireStringBody(request?.body)) as unknown
    const bodyHash = createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex')
    const canonical = [
      'auction',
      'POST',
      '/api/internal/v1/notifications/auction/closed-by-buy-now',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')
    const expected = createHmac('sha256', 'shared-secret').update(canonical, 'utf8').digest('hex')

    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(expected)
  })

  it('H. 409 conflict es error de contrato, no exito silencioso', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(409, { error: 'operation_conflict' })),
    )

    await expect(client(fetchImpl).notifyAuctionClosedEarly(command)).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it.each([400, 401, 500, 503])('I. HTTP %i es dependencia no disponible', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(client(fetchImpl).notifyAuctionClosedEarly(command)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('J. un fallo de red es dependencia no disponible', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).notifyAuctionClosedEarly(command)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('J. un timeout aborta la peticion y es dependencia no disponible', async () => {
    const fetchImpl = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    ) as unknown as typeof fetch

    await expect(client(fetchImpl, 5).notifyAuctionClosedEarly(command)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('K. una respuesta 2xx que no es JSON es error de contrato', async () => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(201, 'no-json')))

    await expect(client(fetchImpl).notifyAuctionClosedEarly(command)).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it.each([
    { notificationId: 'otra-operacion', status: 'created' },
    { notificationId: command.operationId, status: 'unknown' },
    { status: 'created' },
  ])('K. una respuesta 2xx con contrato incompatible es error de contrato: %o', async (body) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(201, body)))

    await expect(client(fetchImpl).notifyAuctionClosedEarly(command)).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })
})
