import { createHash } from 'node:crypto'

import {
  ActiveAuctionLimitExceededError,
  IdempotencyConflictError,
} from '../../../application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  RecordPublicationFailureCommand,
} from '../../../application/ports/AuctionRepositoryPort'
import {
  MAX_ACTIVE_AUCTIONS_PER_SELLER,
  type AuctionSnapshot,
} from '../../../domain/entities/Auction'

interface OperationRecord {
  readonly hash: string
  readonly auctionId: string
}

const hashOf = (command: PersistAuctionPublicationCommand): string => {
  const auction = command.auction.snapshot()
  return createHash('sha256')
    .update(
      JSON.stringify([
        auction.sellerId,
        auction.productId,
        auction.durationHours,
        auction.publicationFeeCredits,
        auction.minimumBidCredits,
        auction.buyNowCredits,
        auction.status,
      ]),
    )
    .digest('hex')
}

export class InMemoryAuctionRepository implements AuctionRepositoryPort {
  private readonly auctions = new Map<string, AuctionSnapshot>()
  private readonly operations = new Map<string, OperationRecord>()
  private readonly failures = new Map<string, RecordPublicationFailureCommand>()

  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult> {
    const hash = hashOf(command)
    const previous = this.operations.get(command.operationId)
    if (previous !== undefined) {
      if (previous.hash !== hash) return Promise.reject(new IdempotencyConflictError())
      const auction = this.auctions.get(previous.auctionId)
      if (auction === undefined) {
        return Promise.reject(new Error('La operacion referencia una subasta inexistente.'))
      }
      return Promise.resolve({ auction, replayed: true })
    }

    const snapshot = command.auction.snapshot()
    if (this.count(snapshot.sellerId) >= MAX_ACTIVE_AUCTIONS_PER_SELLER) {
      return Promise.reject(new ActiveAuctionLimitExceededError())
    }
    this.auctions.set(snapshot.id, snapshot)
    this.operations.set(command.operationId, { hash, auctionId: snapshot.id })
    return Promise.resolve({ auction: snapshot, replayed: false })
  }

  recordFailure(command: RecordPublicationFailureCommand): Promise<void> {
    this.failures.set(command.operationId, command)
    return Promise.resolve()
  }

  findById(auctionId: string): Promise<AuctionSnapshot | null> {
    return Promise.resolve(this.auctions.get(auctionId) ?? null)
  }

  countActiveBySeller(sellerId: string): Promise<number> {
    return Promise.resolve(this.count(sellerId))
  }

  private count(sellerId: string): number {
    return [...this.auctions.values()].filter((auction) => auction.sellerId === sellerId).length
  }
}
