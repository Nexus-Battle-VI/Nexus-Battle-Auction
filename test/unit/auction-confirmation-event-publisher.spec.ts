import { HttpAuctionConfirmationEventPublisher } from '../../src/adapters/outbound/http/HttpAuctionConfirmationEventPublisher'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
} from '../../src/application/errors/ExternalDependencyError'
import type { AuctionConfirmationEvent } from '../../src/application/ports/AuctionConfirmationOutboxRepositoryPort'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'

const now = new Date('2026-10-03T20:01:00.000Z')

const published: AuctionConfirmationEvent = {
  eventId: 'publication-op-1:published',
  eventType: 'auction.published',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-10-03T20:00:00.000Z',
  producer: 'auction',
  correlationId: 'publication-op-1',
  data: {
    auctionId: 'auction-1',
    sellerId: 'seller-1',
    productId: 'product-1',
    publishedAt: '2026-10-03T20:00:00.000Z',
    closesAt: '2026-10-04T20:00:00.000Z',
  },
}

const accepted: AuctionConfirmationEvent = {
  eventId: 'bid-op-1:bid-accepted',
  eventType: 'auction.bid.accepted',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-10-03T20:00:00.000Z',
  producer: 'auction',
  correlationId: 'bid-op-1',
  data: {
    operationId: 'bid-op-1',
    auctionId: 'auction-1',
    productId: 'product-1',
    sellerId: 'seller-1',
    bidderId: 'bidder-1',
    bidId: 'bid-1',
    amountCredits: 100,
    acceptedAt: '2026-10-03T20:00:00.000Z',
  },
}

const buyNowCompleted: AuctionConfirmationEvent = {
  eventId: 'buy-now-op-1:buy-now-completed',
  eventType: 'auction.buy-now.completed',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-10-03T20:00:00.000Z',
  producer: 'auction',
  correlationId: 'buy-now-op-1',
  data: {
    operationId: 'buy-now-op-1',
    transactionId: 'transaction-1',
    transferId: 'transfer-1',
    auctionId: 'auction-1',
    productId: 'product-1',
    sellerId: 'seller-1',
    buyerId: 'buyer-1',
    amountCredits: 100,
    completedAt: '2026-10-03T20:00:00.000Z',
  },
}

const productClaimed: AuctionConfirmationEvent = {
  eventId: 'auction:auction-1:product-claimed',
  eventType: 'auction.product.claimed',
  eventVersion: 1,
  aggregateId: 'auction-1',
  occurredAt: '2026-10-03T20:00:00.000Z',
  producer: 'auction',
  correlationId: 'auction:auction-1:inventory:claim',
  data: {
    auctionId: 'auction-1',
    winnerId: 'buyer-1',
    productId: 'product-1',
    claimedAt: '2026-10-03T20:00:00.000Z',
  },
}

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const mockFetch = (implementation: () => Promise<Response>): jest.MockedFunction<typeof fetch> =>
  jest.fn(implementation) as unknown as jest.MockedFunction<typeof fetch>

const jsonBody = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') throw new Error('La prueba esperaba un cuerpo JSON serializado.')
  return JSON.parse(body) as unknown
}

const client = (fetchImpl: typeof fetch) =>
  new HttpAuctionConfirmationEventPublisher({
    baseUrl: 'http://notifications:3005/',
    secret: 'shared-secret',
    serviceName: 'auction',
    timeoutMs: 100,
    fetchImpl,
    now: () => now,
  })

describe('HttpAuctionConfirmationEventPublisher HU-92.2', () => {
  it('envia una publicacion firmada y acepta la confirmacion del vendedor', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(201, { eventId: published.eventId, created: 1, duplicated: 0 })),
    )

    await expect(client(fetchImpl).publish(published)).resolves.toBeUndefined()

    const [url, request] = fetchImpl.mock.calls[0]!
    expect(url).toBe(
      'http://notifications:3005/api/internal/v1/notifications/auction/confirmations',
    )
    expect(request?.method).toBe('POST')
    const body = jsonBody(request?.body)
    expect(request?.headers).toMatchObject({
      'x-internal-service': 'auction',
      'x-internal-timestamp': String(now.getTime()),
      'x-internal-signature': signInternalRequest('shared-secret', {
        service: 'auction',
        method: 'POST',
        path: '/api/internal/v1/notifications/auction/confirmations',
        timestamp: String(now.getTime()),
        body,
      }),
    })
  })

  it('acepta el replay de una puja cuando Notifications confirma los dos destinatarios', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(response(200, { eventId: accepted.eventId, created: 0, duplicated: 2 })),
    )

    await expect(client(fetchImpl).publish(accepted)).resolves.toBeUndefined()
  })

  it('exige los dos avisos de una compra inmediata confirmada', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(201, { eventId: buyNowCompleted.eventId, created: 2, duplicated: 0 }),
      ),
    )

    await expect(client(fetchImpl).publish(buyNowCompleted)).resolves.toBeUndefined()
  })

  it('acepta un unico aviso de producto reclamado', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        response(201, { eventId: productClaimed.eventId, created: 1, duplicated: 0 }),
      ),
    )

    await expect(client(fetchImpl).publish(productClaimed)).resolves.toBeUndefined()
  })

  it.each([
    [
      'respuesta incompleta',
      response(201, { eventId: published.eventId, created: 0, duplicated: 0 }),
      ExternalContractError,
    ],
    ['fallo temporal', response(503, {}), ExternalDependencyUnavailableError],
  ])('rechaza %s de Notifications', async (_label, result, ErrorType) => {
    const fetchImpl = mockFetch(() => Promise.resolve(result))

    await expect(client(fetchImpl).publish(published)).rejects.toBeInstanceOf(ErrorType)
  })
})
