import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'

import type { AuctionSettlementEventPublisherPort } from '../../../application/ports/AuctionSettlementEventPublisherPort'
import {
  serializeAuctionSettledEventV1,
  type AuctionSettledEventV1,
} from '../../../domain/events/AuctionSettledEventV1'

export interface SqsAuctionSettlementEventPublisherOptions {
  readonly queueUrl: string
  readonly client?: Pick<SQSClient, 'send'>
}

export class SqsAuctionSettlementEventPublisher implements AuctionSettlementEventPublisherPort {
  private readonly client: Pick<SQSClient, 'send'>

  constructor(private readonly options: SqsAuctionSettlementEventPublisherOptions) {
    this.client = options.client ?? new SQSClient({})
  }

  async publish(event: AuctionSettledEventV1): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.queueUrl,
        MessageBody: serializeAuctionSettledEventV1(event),
      }),
    )
  }
}
