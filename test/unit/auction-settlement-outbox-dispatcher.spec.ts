import { AuctionSettlementOutboxDispatcher } from '../../src/application/use-cases/AuctionSettlementOutboxDispatcher'
import { SqsAuctionSettlementEventPublisher } from '../../src/adapters/outbound/messaging/SqsAuctionSettlementEventPublisher'
import type { AuctionSettlementEventPublisherPort } from '../../src/application/ports/AuctionSettlementEventPublisherPort'
import type { AuctionSettlementOutboxRepositoryPort } from '../../src/application/ports/AuctionSettlementOutboxRepositoryPort'
import { createAuctionSettledEventV1 } from '../../src/domain/events/AuctionSettledEventV1'
import type { AuctionSettlementOutboxDispatcherLogger } from '../../src/application/use-cases/AuctionSettlementOutboxDispatcher'

const now = new Date('2026-10-01T12:00:00.000Z')
const event = (auctionId: string) =>
  createAuctionSettledEventV1({
    auctionId,
    productId: 'product',
    sellerId: 'seller',
    resultType: 'WITHOUT_BIDS',
    settledAt: now,
  })

const logger = (): AuctionSettlementOutboxDispatcherLogger => ({
  info: jest.fn(),
  error: jest.fn(),
})

describe('AuctionSettlementOutboxDispatcher', () => {
  it('no consulta ni publica cuando el feature flag esta deshabilitado', async () => {
    const outbox: AuctionSettlementOutboxRepositoryPort = {
      findPending: jest.fn(),
      markPublished: jest.fn(),
    }
    const publisher: AuctionSettlementEventPublisherPort = { publish: jest.fn() }
    const dispatcher = new AuctionSettlementOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      logger(),
      25,
      false,
    )

    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 0, published: 0, failed: 0 })
    expect(outbox.findPending).not.toHaveBeenCalled()
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it('publica y marca todos los eventos pendientes dentro del limite', async () => {
    const first = event('first')
    const second = event('second')
    const outbox: AuctionSettlementOutboxRepositoryPort = {
      findPending: jest.fn().mockResolvedValue([first, second]),
      markPublished: jest.fn(),
    }
    const publisher: AuctionSettlementEventPublisherPort = { publish: jest.fn() }
    const dispatcher = new AuctionSettlementOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      logger(),
      2,
    )

    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 2, published: 2, failed: 0 })
    expect(outbox.findPending).toHaveBeenCalledWith({ limit: 2 })
    expect(publisher.publish).toHaveBeenCalledWith(first)
    expect(publisher.publish).toHaveBeenCalledWith(second)
    expect(outbox.markPublished).toHaveBeenCalledWith({ eventId: first.eventId, publishedAt: now })
  })

  it('continua el lote tras fallos de publicacion y de marcado', async () => {
    const first = event('first')
    const second = event('second')
    const third = event('third')
    const outbox: AuctionSettlementOutboxRepositoryPort = {
      findPending: jest.fn().mockResolvedValue([first, second, third]),
      markPublished: jest.fn().mockRejectedValueOnce(new Error('write failed')),
    }
    const publisher: AuctionSettlementEventPublisherPort = {
      publish: jest
        .fn()
        .mockRejectedValueOnce(new Error('send failed'))
        .mockResolvedValue(undefined),
    }
    const eventsLogger = logger()
    const dispatcher = new AuctionSettlementOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      eventsLogger,
      3,
    )

    await expect(dispatcher.runBatch()).resolves.toEqual({ pending: 3, published: 1, failed: 2 })
    expect(outbox.markPublished).toHaveBeenCalledTimes(2)
    expect(eventsLogger.error).toHaveBeenCalledWith(
      'auction_settlement_event_publish_failed',
      expect.objectContaining({ eventId: first.eventId }),
    )
    expect(eventsLogger.error).toHaveBeenCalledWith(
      'auction_settlement_event_mark_published_failed',
      expect.objectContaining({ eventId: second.eventId }),
    )
  })

  it('reintenta con el mismo evento despues de la ventana publish/mark', async () => {
    const replayEvent = event('replay')
    const pending = [replayEvent]
    const send = jest.fn().mockResolvedValue({})
    const outbox: AuctionSettlementOutboxRepositoryPort = {
      findPending: jest.fn(() => Promise.resolve(pending)),
      markPublished: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary database failure'))
        .mockImplementationOnce(() => {
          pending.splice(0, 1)
          return Promise.resolve()
        }),
    }
    const publisher = new SqsAuctionSettlementEventPublisher({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/auction',
      client: { send },
    })
    const dispatcher = new AuctionSettlementOutboxDispatcher(
      outbox,
      publisher,
      { now: () => now },
      logger(),
      25,
    )

    await dispatcher.runBatch()
    await dispatcher.runBatch()
    expect(send).toHaveBeenCalledTimes(2)
    expect(replayEvent.eventId).toBe('auction:replay:settled')
    expect(send.mock.calls[0]?.[0].input.MessageBody).toBe(JSON.stringify(replayEvent))
    expect(send.mock.calls[1]?.[0].input.MessageBody).toBe(JSON.stringify(replayEvent))
  })
})
