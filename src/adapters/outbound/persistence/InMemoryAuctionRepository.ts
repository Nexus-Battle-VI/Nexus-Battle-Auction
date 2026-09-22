import { createHash } from 'node:crypto'

import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  IdempotencyConflictError,
} from '../../../application/errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
  CreateBidCreditOperationCommand,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  PersistBidResult,
  RecordBidCreditFailureCommand,
  RecordPublicationFailureCommand,
  UpdateBidCreditOperationCommand,
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

interface StoredBid {
  readonly snapshot: BidSnapshot
  readonly creditReservationId: string | null
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

const cloneBidCreditOperation = (
  operation: BidCreditOperationSnapshot,
): BidCreditOperationSnapshot => ({
  ...operation,
  createdAt: new Date(operation.createdAt),
  updatedAt: new Date(operation.updatedAt),
})

export class InMemoryAuctionRepository implements AuctionRepositoryPort {
  private readonly auctions = new Map<string, AuctionSnapshot>()

  private readonly operations = new Map<string, OperationRecord>()

  private readonly failures = new Map<string, RecordPublicationFailureCommand>()

  private readonly bidCreditFailures = new Map<string, RecordBidCreditFailureCommand>()

  private readonly bidCreditOperations = new Map<string, BidCreditOperationSnapshot>()

  private readonly bids = new Map<string, StoredBid>()

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

  recordBidCreditFailure(command: RecordBidCreditFailureCommand): Promise<void> {
    this.bidCreditFailures.set(command.operationId, command)

    return Promise.resolve()
  }

  createBidCreditOperation(command: CreateBidCreditOperationCommand): Promise<void> {
    const previous = this.bidCreditOperations.get(command.operationId)

    if (previous !== undefined) {
      const sameIntent =
        previous.bidId === command.bidId &&
        previous.auctionId === command.auctionId &&
        previous.bidderId === command.bidderId &&
        previous.amountCredits === command.amountCredits

      if (!sameIntent) {
        return Promise.reject(new IdempotencyConflictError())
      }

      return Promise.resolve()
    }

    const operationForSameBid = [...this.bidCreditOperations.values()].find(
      (operation) => operation.bidId === command.bidId,
    )

    if (operationForSameBid !== undefined) {
      return Promise.reject(new IdempotencyConflictError())
    }

    const createdAt = new Date(command.createdAt)

    this.bidCreditOperations.set(command.operationId, {
      operationId: command.operationId,
      bidId: command.bidId,
      auctionId: command.auctionId,
      bidderId: command.bidderId,
      amountCredits: command.amountCredits,
      status: 'PENDING_RESERVATION',
      reservationId: null,
      previousReservationId: null,
      createdAt,
      updatedAt: new Date(createdAt),
    })

    return Promise.resolve()
  }

  updateBidCreditOperation(command: UpdateBidCreditOperationCommand): Promise<void> {
    const previous = this.bidCreditOperations.get(command.operationId)

    if (previous === undefined) {
      return Promise.reject(new Error(`La operacion de creditos ${command.operationId} no existe.`))
    }

    this.bidCreditOperations.set(command.operationId, {
      ...previous,
      status: command.status,
      reservationId: command.reservationId,
      previousReservationId: command.previousReservationId,
      updatedAt: new Date(command.updatedAt),
    })

    return Promise.resolve()
  }

  findBidCreditOperation(operationId: string): Promise<BidCreditOperationSnapshot | null> {
    const operation = this.bidCreditOperations.get(operationId)

    if (operation === undefined) {
      return Promise.resolve(null)
    }

    return Promise.resolve(cloneBidCreditOperation(operation))
  }

  findById(auctionId: string): Promise<AuctionSnapshot | null> {
    return Promise.resolve(this.auctions.get(auctionId) ?? null)
  }

  countActiveBySeller(sellerId: string): Promise<number> {
    return Promise.resolve(this.count(sellerId))
  }

  persistBid(
    bid: Bid,
    creditReservationId: string | null = null,
    operationId: string | null = null,
  ): Promise<PersistBidResult> {
    const snapshot = bid.snapshot()

    if (!this.auctions.has(snapshot.auctionId)) {
      return Promise.reject(new Error(`La subasta ${snapshot.auctionId} no existe.`))
    }

    if (this.bids.has(snapshot.id)) {
      return Promise.reject(new BidAlreadyExistsError(snapshot.id))
    }

    const previousLeaderId = this.leadingBidByAuction.get(snapshot.auctionId)

    const previousStored =
      previousLeaderId === undefined ? null : (this.bids.get(previousLeaderId) ?? null)

    const previousLeader = previousStored === null ? null : cloneBid(previousStored.snapshot)

    const previousLeaderReservationId =
      previousStored === null ? null : previousStored.creditReservationId

    if (operationId !== null) {
      const operation = this.bidCreditOperations.get(operationId)

      if (operation === undefined) {
        return Promise.reject(new Error(`La operacion de creditos ${operationId} no existe.`))
      }

      if (
        operation.bidId !== snapshot.id ||
        operation.auctionId !== snapshot.auctionId ||
        operation.bidderId !== snapshot.bidderId ||
        operation.amountCredits !== snapshot.amountCredits
      ) {
        return Promise.reject(new IdempotencyConflictError())
      }
    }

    const stored: StoredBid = {
      snapshot: cloneBid(snapshot),
      creditReservationId,
    }

    this.bids.set(snapshot.id, stored)

    this.leadingBidByAuction.set(snapshot.auctionId, snapshot.id)

    const existingAuction = this.auctions.get(snapshot.auctionId)
    if (existingAuction) {
      this.auctions.set(snapshot.auctionId, {
        ...existingAuction,
        // Si el snapshot de la subasta guarda el id de la puja líder o la última puja:
        leadingBidId: snapshot.id,
      } as AuctionSnapshot)
    }

    if (operationId !== null) {
      const operation = this.bidCreditOperations.get(operationId)

      if (operation !== undefined) {
        this.bidCreditOperations.set(operationId, {
          ...operation,
          status: 'BID_PERSISTED',
          reservationId: creditReservationId,
          previousReservationId: previousLeaderReservationId,
          updatedAt: new Date(snapshot.placedAt),
        })
      }
    }

    return Promise.resolve({
      bid: cloneBid(stored.snapshot),
      previousLeader,
      previousLeaderReservationId,
    })
  }

  findLeadingBid(auctionId: string): Promise<BidSnapshot | null> {
    const bidId = this.leadingBidByAuction.get(auctionId)

    if (bidId === undefined) {
      return Promise.resolve(null)
    }

    const stored = this.bids.get(bidId)

    if (stored === undefined) {
      return Promise.resolve(null)
    }

    return Promise.resolve(cloneBid(stored.snapshot))
  }

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]> {
    const history = [...this.bids.values()]
      .map((stored) => stored.snapshot)
      .filter((bid) => bid.auctionId === auctionId)
      .sort((left, right) => left.placedAt.getTime() - right.placedAt.getTime())
      .map(cloneBid)

    return Promise.resolve(history)
  }

  findLastBidByBidder(bidderId: string): Promise<BidSnapshot | null> {
    const lastBid = [...this.bids.values()]
      .map((stored) => stored.snapshot)
      .filter((bid) => bid.bidderId === bidderId)
      .sort((left, right) => right.placedAt.getTime() - left.placedAt.getTime())[0]

    return Promise.resolve(lastBid === undefined ? null : cloneBid(lastBid))
  }

  countActiveBidsByBidder(bidderId: string): Promise<number> {
    const activeBidCount = [...this.leadingBidByAuction.values()]
      .map((bidId) => this.bids.get(bidId))
      .filter((stored): stored is StoredBid => stored?.snapshot.bidderId === bidderId).length

    return Promise.resolve(activeBidCount)
  }

  private count(sellerId: string): number {
    return [...this.auctions.values()].filter((auction) => auction.sellerId === sellerId).length
  }
}
