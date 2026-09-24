import { SqsAuctionSettlementEventPublisher } from '../../src/adapters/outbound/messaging/SqsAuctionSettlementEventPublisher'
import { createAuctionSettledEventV1 } from '../../src/domain/events/AuctionSettledEventV1'

describe('SqsAuctionSettlementEventPublisher', () => {
  it('envia el envelope completo como cuerpo SQS sin semantica FIFO', async () => {
    const send = jest.fn().mockResolvedValue({})
    const event = createAuctionSettledEventV1({
      auctionId: 'auction',
      productId: 'product',
      sellerId: 'seller',
      resultType: 'WITHOUT_BIDS',
      settledAt: new Date('2026-10-01T12:00:00.000Z'),
    })
    const publisher = new SqsAuctionSettlementEventPublisher({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/auction',
      client: { send },
    })

    await publisher.publish(event)

    const command = send.mock.calls[0]?.[0]
    expect(command.input).toEqual({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/auction',
      MessageBody: JSON.stringify(event),
    })
    expect(command.input.MessageGroupId).toBeUndefined()
    expect(command.input.MessageDeduplicationId).toBeUndefined()
  })
})
