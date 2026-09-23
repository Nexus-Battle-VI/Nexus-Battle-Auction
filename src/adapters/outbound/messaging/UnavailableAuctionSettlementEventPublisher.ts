import type { AuctionSettlementEventPublisherPort } from '../../../application/ports/AuctionSettlementEventPublisherPort'

export class UnavailableAuctionSettlementEventPublisher implements AuctionSettlementEventPublisherPort {
  publish(): Promise<void> {
    return Promise.reject(new Error('El publisher de settlement no esta configurado.'))
  }
}
