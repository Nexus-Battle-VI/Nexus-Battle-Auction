import { createHash, createHmac } from 'node:crypto'

import { HttpOutbidNotificationClient } from '../../src/adapters/outbound/http/HttpOutbidNotificationClient'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'
import type { OutbidNotification } from '../../src/application/ports/OutbidNotificationPort'

const fixedNow = new Date('2026-09-22T03:00:00.000Z')

const notification: OutbidNotification = {
  notificationId: 'operation-63-5:outbid',

  operationId: 'operation-63-5',

  recipientPlayerId: 'player-previous',

  auctionId: 'auction-63-5',

  outbidBidId: 'bid-old',

  winningBidId: 'bid-new',

  winningBidderId: 'player-new',

  winningAmountCredits: 75,

  occurredAt: new Date('2026-09-22T02:00:00.000Z'),
}

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,

    headers: {
      'content-type': 'application/json',
    },
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

const client = (fetchImpl: typeof fetch) =>
  new HttpOutbidNotificationClient({
    baseUrl: 'http://notifications:3005',

    secret: 'shared-secret',

    serviceName: 'auction',

    timeoutMs: 100,

    logger: {
      warn: jest.fn(),
    },

    fetchImpl,

    now: () => fixedNow,
  })

describe('HttpOutbidNotificationClient HU-63.5', () => {
  it('envia el payload correcto al endpoint interno de Notifications', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(201, {
          notificationId: notification.notificationId,

          status: 'created',
        }),
      ),
    )

    await expect(client(fetchImpl).publish(notification)).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const [url, request] = fetchImpl.mock.calls[0]!

    expect(url).toBe('http://notifications:3005/api/internal/v1/notifications/auction/outbid')

    expect(request?.method).toBe('POST')

    const body = JSON.parse(requireStringBody(request?.body)) as Record<string, unknown>

    expect(body).toEqual({
      notificationId: 'operation-63-5:outbid',

      operationId: 'operation-63-5',

      recipientPlayerId: 'player-previous',

      auctionId: 'auction-63-5',

      outbidBidId: 'bid-old',

      winningBidId: 'bid-new',

      winningBidderId: 'player-new',

      winningAmountCredits: 75,

      occurredAt: '2026-09-22T02:00:00.000Z',
    })

    expect(request?.headers).toMatchObject({
      'content-type': 'application/json',

      'x-internal-service': 'auction',

      'x-internal-timestamp': String(fixedNow.getTime()),
    })
  })

  it('firma exactamente servicio, metodo, ruta, timestamp y payload', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          notificationId: notification.notificationId,

          status: 'duplicated',
        }),
      ),
    )

    await client(fetchImpl).publish(notification)

    const [, request] = fetchImpl.mock.calls[0]!

    const body = JSON.parse(requireStringBody(request?.body)) as unknown

    const bodyHash = createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex')

    const canonical = [
      'auction',
      'POST',
      '/api/internal/v1/notifications/auction/outbid',
      String(fixedNow.getTime()),
      bodyHash,
    ].join('\n')

    const expected = createHmac('sha256', 'shared-secret').update(canonical, 'utf8').digest('hex')

    expect((request?.headers as Record<string, string>)['x-internal-signature']).toBe(expected)
  })

  it.each([400, 401, 500, 503])('trata HTTP %i como fallo de Notifications', async (status) => {
    const fetchImpl = mockFetch(() => Promise.resolve(response(status, {})))

    await expect(client(fetchImpl).publish(notification)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })

  it('acepta un replay idempotente confirmado por Notifications', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(200, {
          notificationId: notification.notificationId,

          status: 'duplicated',
        }),
      ),
    )

    await expect(client(fetchImpl).publish(notification)).resolves.toBeUndefined()
  })

  it('rechaza una respuesta con notificationId incorrecto', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(201, {
          notificationId: 'otra-notificacion',

          status: 'created',
        }),
      ),
    )

    await expect(client(fetchImpl).publish(notification)).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('rechaza una respuesta 2xx con contrato desconocido', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(201, {
          notificationId: notification.notificationId,

          status: 'unknown',
        }),
      ),
    )

    await expect(client(fetchImpl).publish(notification)).rejects.toBeInstanceOf(
      ExternalContractError,
    )
  })

  it('trata un fallo de red como dependencia no disponible', async () => {
    const fetchImpl = mockFetch(() => Promise.reject(new TypeError('network error')))

    await expect(client(fetchImpl).publish(notification)).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
  })
})
