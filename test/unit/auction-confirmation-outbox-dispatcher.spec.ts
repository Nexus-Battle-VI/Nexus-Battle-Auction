import { AuctionConfirmationOutboxDispatcher } from '../../src/application/use-cases/AuctionConfirmationOutboxDispatcher'
import type { AuctionConfirmationEventPublisherPort } from '../../src/application/ports/AuctionConfirmationEventPublisherPort'
import type {
  AuctionConfirmationEvent,
  AuctionConfirmationOutboxRepositoryPort,
} from '../../src/application/ports/AuctionConfirmationOutboxRepositoryPort'
import type { AuctionConfirmationDispatcherLogger } from '../../src/application/use-cases/AuctionConfirmationOutboxDispatcher'

const now = new Date('2026-10-03T20:01:00.000Z')

const event = (eventId: string): AuctionConfirmationEvent => ({
  eventId,
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
})

const logger = (): AuctionConfirmationDispatcherLogger => ({
  info: jest.fn(),
  error: jest.fn(),
})

describe('AuctionConfirmationOutboxDispatcher HU-92.2', () => {
  it('no consulta el outbox cuando el despacho esta deshabilitado', async () => {
    const outbox: AuctionConfirmationOutboxRepositoryPort = {
      findPending: jest.fn(),
      markPublished: jest.fn(),
    }
    const publisher: AuctionConfirmationEventPublisherPort = { publish: jest.fn() }
    const dispatcher = new AuctionConfirmationOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      logger(),
      25,
      false,
    )

    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 0, published: 0, failed: 0 })
    expect(outbox.findPending).not.toHaveBeenCalled()
  })

  it('publica y confirma todos los eventos pendientes dentro del lote', async () => {
    const first = event('publication-1')
    const second = event('publication-2')
    const outbox: AuctionConfirmationOutboxRepositoryPort = {
      findPending: jest.fn().mockResolvedValue([first, second]),
      markPublished: jest.fn(),
    }
    const publisher: AuctionConfirmationEventPublisherPort = { publish: jest.fn() }
    const dispatcher = new AuctionConfirmationOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      logger(),
      2,
      true,
    )

    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 2, published: 2, failed: 0 })
    expect(outbox.findPending).toHaveBeenCalledWith({ limit: 2 })
    expect(publisher.publish).toHaveBeenCalledWith(first)
    expect(outbox.markPublished).toHaveBeenCalledWith({ eventId: first.eventId, publishedAt: now })
  })

  it('mantiene pendiente un evento fallido y lo recupera con la misma identidad', async () => {
    const retry = event('publication-retry')
    const pending = [retry]
    const outbox: AuctionConfirmationOutboxRepositoryPort = {
      findPending: jest.fn(() => Promise.resolve([...pending])),
      markPublished: jest.fn(() => {
        pending.splice(0, 1)
        return Promise.resolve()
      }),
    }
    const publisher: AuctionConfirmationEventPublisherPort = {
      publish: jest.fn().mockRejectedValueOnce(new Error('notifications unavailable')),
    }
    const dispatcher = new AuctionConfirmationOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      logger(),
      25,
      true,
    )

    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 1, published: 0, failed: 1 })
    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 1, published: 1, failed: 0 })
    expect(publisher.publish).toHaveBeenCalledTimes(2)
    expect(publisher.publish).toHaveBeenNthCalledWith(1, retry)
    expect(publisher.publish).toHaveBeenNthCalledWith(2, retry)
  })
})
