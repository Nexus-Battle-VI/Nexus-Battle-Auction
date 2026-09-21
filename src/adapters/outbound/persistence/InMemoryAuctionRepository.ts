import { createHash } from 'node:crypto'

import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  IdempotencyConflictError,
} from '../../../application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  PersistBidResult,
  RecordPublicationFailureCommand,
} from '../../../application/ports/AuctionRepositoryPort'
import {
  MAX_ACTIVE_AUCTIONS_PER_SELLER,
  type AuctionSnapshot,
} from '../../../domain/entities/Auction'
import type { Bid, BidSnapshot } from '../../../domain/entities/Bid'

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

const cloneBid = (bid: BidSnapshot): BidSnapshot => ({
  ...bid,
  placedAt: new Date(bid.placedAt),
})

export class InMemoryAuctionRepository implements AuctionRepositoryPort {
  private readonly auctions = new Map<string, AuctionSnapshot>()

  private readonly operations = new Map<string, OperationRecord>()

  private readonly failures = new Map<string, RecordPublicationFailureCommand>()

  private readonly bids = new Map<string, BidSnapshot>()

  private readonly leadingBidByAuction = new Map<string, string>()

  publish(command: PersistAuctionPublicationCommand): Promise<PersistAuctionPublicationResult> {
    const hash = hashOf(command)

    const previous = this.operations.get(command.operationId)

    if (previous !== undefined) {
      if (previous.hash !== hash) {
        return Promise.reject(new IdempotencyConflictError())
      }

      const auction = this.auctions.get(previous.auctionId)

      if (auction === undefined) {
        return Promise.reject(new Error('La operacion referencia una subasta inexistente.'))
      }

      return Promise.resolve({
        auction,
        replayed: true,
      })
    }

    const snapshot = command.auction.snapshot()

    if (this.count(snapshot.sellerId) >= MAX_ACTIVE_AUCTIONS_PER_SELLER) {
      return Promise.reject(new ActiveAuctionLimitExceededError())
    }

    this.auctions.set(snapshot.id, snapshot)

    this.operations.set(command.operationId, {
      hash,
      auctionId: snapshot.id,
    })

    return Promise.resolve({
      auction: snapshot,
      replayed: false,
    })
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

  persistBid(bid: Bid): Promise<PersistBidResult> {
    const snapshot = bid.snapshot()

    if (!this.auctions.has(snapshot.auctionId)) {
      return Promise.reject(new Error(`La subasta ${snapshot.auctionId} no existe.`))
    }

    if (this.bids.has(snapshot.id)) {
      return Promise.reject(new BidAlreadyExistsError(snapshot.id))
    }

    const previousLeaderId = this.leadingBidByAuction.get(snapshot.auctionId)

    const previousLeader =
      previousLeaderId === undefined ? null : (this.bids.get(previousLeaderId) ?? null)

    const stored = cloneBid(snapshot)

    this.bids.set(stored.id, stored)

    this.leadingBidByAuction.set(stored.auctionId, stored.id)

    return Promise.resolve({
      bid: cloneBid(stored),
      previousLeader: previousLeader === null ? null : cloneBid(previousLeader),
    })
  }

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null> {
    const bidId = this.leadingBidByAuction.get(auctionId)

    if (bidId === undefined) {
      return Promise.resolve(null)
    }

    const bid = this.bids.get(bidId)

    if (bid === undefined) {
      return Promise.resolve(null)
    }

    return Promise.resolve(cloneBid(bid))
  }

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]> {
    const history = [...this.bids.values()]
      .filter((bid) => bid.auctionId === auctionId)
      .sort((left, right) => left.placedAt.getTime() - right.placedAt.getTime())
      .map(cloneBid)

    return Promise.resolve(history)
  }

  private count(sellerId: string): number {
    return [...this.auctions.values()].filter((auction) => auction.sellerId === sellerId).length
  }
}
