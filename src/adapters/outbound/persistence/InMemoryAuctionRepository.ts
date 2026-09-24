import { createHash } from 'node:crypto'

import {
  ActiveAuctionLimitExceededError,
  BidAlreadyExistsError,
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../../../application/errors/AuctionPersistenceError'
import {
  AuctionAlreadyClosedError,
  BuyNowIdempotencyConflictError,
} from '../../../application/errors/BuyNowTransactionError'
import type {
  AuctionRepositoryPort,
  ActiveAuctionList,
  BidCreditOperationSnapshot,
  BuyNowOperationRecord,
  CloseAuctionByBuyNowCommand,
  CloseAuctionByBuyNowResult,
  CreateBidCreditOperationCommand,
  PersistAuctionPublicationCommand,
  PersistAuctionPublicationResult,
  ListActiveAuctionsInput,
  PersistBidResult,
  FinishAuctionCommand,
  RecordBidCreditFailureCommand,
  RecordBuyNowFailureCommand,
  PersistOfficialAuctionPublicationCommand,
  PersistOfficialAuctionPublicationResult,
  RecordPublicationFailureCommand,
  UpdateBidCreditOperationCommand,
} from '../../../application/ports/AuctionRepositoryPort'
import type {
  AuctionSettlementCandidate,
  AuctionSettlementCandidateReaderPort,
} from '../../../application/ports/AuctionSettlementWorkRepositoryPort'
import {
  Auction,
  AuctionStatus,
  MAX_ACTIVE_AUCTIONS_PER_SELLER,
  type AuctionSnapshot,
} from '../../../domain/entities/Auction'
import type { AutoBidConfig, AutoBidConfigSnapshot } from '../../../domain/entities/AutoBidConfig'
import type { Bid, BidSnapshot } from '../../../domain/entities/Bid'
import type { OfficialAuctionSnapshot } from '../../../domain/entities/OfficialAuction'

interface OperationRecord {
  readonly hash: string
  readonly auctionId: string
}

interface StoredBid {
  readonly snapshot: BidSnapshot
  readonly creditReservationId: string | null
}

const officialHashOf = (command: PersistOfficialAuctionPublicationCommand): string => {
  const auction = command.auction.snapshot()
  return createHash('sha256')
    .update(
      JSON.stringify([
        auction.publisherId,
        auction.productId,
        auction.durationHours,
        auction.currency,
        auction.minimumBidAmountMinor,
        auction.buyNowAmountMinor,
        auction.mark,
        auction.status,
      ]),
    )
    .digest('hex')
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

const toBidSnapshot = (bid: StoredBid): BidSnapshot => ({
  ...cloneBid(bid.snapshot),
  ...(bid.creditReservationId === null ? {} : { creditReservationId: bid.creditReservationId }),
})

const cloneBidCreditOperation = (
  operation: BidCreditOperationSnapshot,
): BidCreditOperationSnapshot => ({
  ...operation,
  createdAt: new Date(operation.createdAt),
  updatedAt: new Date(operation.updatedAt),
})

const cloneAutoBidConfig = (config: AutoBidConfigSnapshot): AutoBidConfigSnapshot => ({
  ...config,
  configuredAt: new Date(config.configuredAt),
})

const autoBidKey = (auctionId: string, bidderId: string): string => `${auctionId}:${bidderId}`

const cloneAuction = (auction: AuctionSnapshot): AuctionSnapshot => ({
  ...auction,
  publishedAt: new Date(auction.publishedAt),
  closesAt: new Date(auction.closesAt),
  ...(auction.completion === undefined
    ? {}
    : {
        completion: {
          ...auction.completion,
          finishedAt: new Date(auction.completion.finishedAt),
        },
      }),
})

interface BuyNowOperationEntry {
  readonly hash: string
  readonly auctionId: string
  readonly transactionId: string
  readonly buyerId: string
  readonly transferId: string
  readonly priceCredits: number
  readonly remainingCredits: number
  readonly completedAt: Date
}

const buyNowHashOf = (command: CloseAuctionByBuyNowCommand): string =>
  createHash('sha256')
    .update(JSON.stringify([command.auctionId, command.buyerId, command.priceCredits]))
    .digest('hex')

export class InMemoryAuctionRepository
  implements AuctionRepositoryPort, AuctionSettlementCandidateReaderPort
{
  private readonly auctions = new Map<string, AuctionSnapshot>()

  private readonly inventoryCommitmentIds = new Map<string, string>()

  private readonly officialAuctions = new Map<string, OfficialAuctionSnapshot>()

  private readonly operations = new Map<string, OperationRecord>()

  private readonly failures = new Map<string, RecordPublicationFailureCommand>()

  private readonly bidCreditFailures = new Map<string, RecordBidCreditFailureCommand>()

  private readonly bidCreditOperations = new Map<string, BidCreditOperationSnapshot>()

  private readonly bids = new Map<string, StoredBid>()

  private readonly leadingBidByAuction = new Map<string, string>()

  private readonly autoBidConfigs = new Map<string, AutoBidConfigSnapshot>()

  private readonly buyNowOperations = new Map<string, BuyNowOperationEntry>()

  private readonly buyNowFailures = new Map<string, RecordBuyNowFailureCommand>()

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
    this.inventoryCommitmentIds.set(snapshot.id, command.inventoryCommitmentId)

    this.operations.set(command.operationId, {
      hash,
      auctionId: snapshot.id,
    })

    return Promise.resolve({
      auction: snapshot,
      replayed: false,
    })
  }

  publishOfficial(
    command: PersistOfficialAuctionPublicationCommand,
  ): Promise<PersistOfficialAuctionPublicationResult> {
    const hash = officialHashOf(command)
    const previous = this.operations.get(command.operationId)
    if (previous !== undefined) {
      if (previous.hash !== hash) return Promise.reject(new IdempotencyConflictError())
      const auction = this.officialAuctions.get(previous.auctionId)
      if (auction === undefined) {
        return Promise.reject(new PersistedAuctionNotFoundError(previous.auctionId))
      }
      return Promise.resolve({ auction, replayed: true })
    }

    const snapshot = command.auction.snapshot()
    this.officialAuctions.set(snapshot.id, snapshot)
    this.operations.set(command.operationId, { hash, auctionId: snapshot.id })
    return Promise.resolve({ auction: snapshot, replayed: false })
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

  findBidCreditOperationByBid(bidId: string): Promise<BidCreditOperationSnapshot | null> {
    const operation = [...this.bidCreditOperations.values()].find(
      (candidate) => candidate.bidId === bidId,
    )

    return Promise.resolve(operation === undefined ? null : cloneBidCreditOperation(operation))
  }

  findById(auctionId: string): Promise<AuctionSnapshot | null> {
    const auction = this.auctions.get(auctionId)

    return Promise.resolve(auction === undefined ? null : cloneAuction(auction))
  }

  findSettlementCandidates(now: Date): Promise<readonly AuctionSettlementCandidate[]> {
    return Promise.resolve(
      [...this.auctions.values()]
        .filter((auction) => auction.closesAt.getTime() <= now.getTime())
        .map((auction) => ({
          auctionId: auction.id,
          status: auction.status,
          closesAt: new Date(auction.closesAt),
        }))
        .sort(
          (left, right) =>
            left.closesAt.getTime() - right.closesAt.getTime() ||
            left.auctionId.localeCompare(right.auctionId),
        ),
    )
  }

  findAuctionAggregate(auctionId: string): Promise<Auction | null> {
    const auction = this.auctions.get(auctionId)

    if (auction === undefined) {
      return Promise.resolve(null)
    }

    const snapshot = cloneAuction(auction)

    return Promise.resolve(
      Auction.rehydrate({
        ...snapshot,
        finishedAt:
          snapshot.status === AuctionStatus.Finished
            ? (snapshot.completion?.finishedAt ?? null)
            : null,
        closingResult:
          snapshot.status === AuctionStatus.Finished ? (snapshot.completion ?? null) : null,
      }),
    )
  }

  findInventoryCommitmentId(auctionId: string): Promise<string | null> {
    return Promise.resolve(this.inventoryCommitmentIds.get(auctionId) ?? null)
  }

  /** Replica la ventana `(from, until]` utilizada por PostgreSQL. */
  findActiveClosingBetween(from: Date, until: Date): Promise<readonly AuctionSnapshot[]> {
    return Promise.resolve(
      [...this.auctions.values()]
        .filter(
          (auction) =>
            auction.closesAt.getTime() > from.getTime() &&
            auction.closesAt.getTime() <= until.getTime(),
        )
        .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime()),
    )
  }

  listActive(input: ListActiveAuctionsInput): Promise<ActiveAuctionList> {
    const playerItems: ActiveAuctionList['items'][number][] = [...this.auctions.values()]
      .filter(
        (auction) =>
          auction.status === AuctionStatus.Active &&
          auction.closesAt.getTime() > input.now.getTime(),
      )
      .map((auction) => {
        const leaderId = this.leadingBidByAuction.get(auction.id)
        const leader = leaderId === undefined ? undefined : this.bids.get(leaderId)
        return {
          id: auction.id,
          sellerId: auction.sellerId,
          publisherType: 'PLAYER' as const,
          productId: auction.productId,
          priceKind: 'CREDITS' as const,
          minimumBidCredits: auction.minimumBidCredits,
          buyNowCredits: auction.buyNowCredits,
          currency: null,
          minimumBidAmountMinor: null,
          buyNowAmountMinor: null,
          officialMark: null,
          status: AuctionStatus.Active,
          publishedAt: new Date(auction.publishedAt),
          closesAt: new Date(auction.closesAt),
          currentBidAmount: leader?.snapshot.amountCredits ?? null,
        }
      })
    const officialItems: ActiveAuctionList['items'][number][] = [...this.officialAuctions.values()]
      .filter(
        (auction) =>
          auction.status === AuctionStatus.Active &&
          auction.closesAt.getTime() > input.now.getTime(),
      )
      .map((auction) => ({
        id: auction.id,
        sellerId: auction.publisherId,
        publisherType: 'GAME_MASTER' as const,
        productId: auction.productId,
        priceKind: 'REAL_MONEY' as const,
        minimumBidCredits: null,
        buyNowCredits: null,
        currency: auction.currency,
        minimumBidAmountMinor: auction.minimumBidAmountMinor,
        buyNowAmountMinor: auction.buyNowAmountMinor,
        officialMark: auction.mark,
        status: AuctionStatus.Active,
        publishedAt: new Date(auction.publishedAt),
        closesAt: new Date(auction.closesAt),
        currentBidAmount: null,
      }))
    const active = [...officialItems, ...playerItems].sort(
      (left, right) =>
        (left.publisherType === right.publisherType
          ? 0
          : left.publisherType === 'GAME_MASTER'
            ? -1
            : 1) ||
        left.closesAt.getTime() - right.closesAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    const offset = (input.page - 1) * input.pageSize
    return Promise.resolve({
      total: active.length,
      items: active.slice(offset, offset + input.pageSize),
    })
  }

  findOfficialById(auctionId: string): Promise<OfficialAuctionSnapshot | null> {
    return Promise.resolve(this.officialAuctions.get(auctionId) ?? null)
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

    const previousLeader = previousStored === null ? null : toBidSnapshot(previousStored)

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
      bid: toBidSnapshot(stored),
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

    return Promise.resolve(toBidSnapshot(stored))
  }

  findBidHistory(auctionId: string): Promise<readonly BidSnapshot[]> {
    const history = [...this.bids.values()]
      .filter((stored) => stored.snapshot.auctionId === auctionId)
      .sort((left, right) => left.snapshot.placedAt.getTime() - right.snapshot.placedAt.getTime())
      .map(toBidSnapshot)

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

  saveAutoBidConfig(config: AutoBidConfig): Promise<AutoBidConfigSnapshot> {
    const snapshot = config.snapshot()

    if (!this.auctions.has(snapshot.auctionId)) {
      return Promise.reject(new PersistedAuctionNotFoundError(snapshot.auctionId))
    }

    const stored = cloneAutoBidConfig(snapshot)

    this.autoBidConfigs.set(autoBidKey(snapshot.auctionId, snapshot.bidderId), stored)

    return Promise.resolve(cloneAutoBidConfig(stored))
  }

  findAutoBidConfig(auctionId: string, bidderId: string): Promise<AutoBidConfigSnapshot | null> {
    const stored = this.autoBidConfigs.get(autoBidKey(auctionId, bidderId))

    return Promise.resolve(stored === undefined ? null : cloneAutoBidConfig(stored))
  }

  findActiveAutoBidsForAuction(
    auctionId: string,
    excludeBidderId: string,
  ): Promise<readonly AutoBidConfigSnapshot[]> {
    const configs = [...this.autoBidConfigs.values()]
      .filter(
        (config) =>
          config.auctionId === auctionId && config.isActive && config.bidderId !== excludeBidderId,
      )
      .map(cloneAutoBidConfig)

    return Promise.resolve(configs)
  }

  finishAuction(command: FinishAuctionCommand): Promise<void> {
    const auction = this.auctions.get(command.auctionId)
    if (auction === undefined) throw new Error(`No existe ${command.auctionId}`)
    if (auction.status !== AuctionStatus.Active) throw new Error('La subasta ya fue finalizada.')
    this.auctions.set(command.auctionId, {
      ...auction,
      status: AuctionStatus.Finished,
      completion: {
        ...command.closingResult.snapshot(),
        finishedAt: new Date(command.finishedAt),
      },
    })
    return Promise.resolve()
  }

  closeByBuyNow(command: CloseAuctionByBuyNowCommand): Promise<CloseAuctionByBuyNowResult> {
    const hash = buyNowHashOf(command)
    const previous = this.buyNowOperations.get(command.operationId)

    if (previous !== undefined) {
      if (previous.hash !== hash) {
        return Promise.reject(new BuyNowIdempotencyConflictError())
      }

      const auction = this.auctions.get(previous.auctionId)

      if (auction === undefined) {
        return Promise.reject(new PersistedAuctionNotFoundError(previous.auctionId))
      }

      return Promise.resolve({
        auction,
        transactionId: previous.transactionId,
        replayed: true,
      })
    }

    const auction = this.auctions.get(command.auctionId)

    if (auction === undefined) {
      return Promise.reject(new PersistedAuctionNotFoundError(command.auctionId))
    }

    if (auction.status !== AuctionStatus.Active) {
      return Promise.reject(new AuctionAlreadyClosedError(command.auctionId))
    }

    const closed: AuctionSnapshot = {
      ...auction,
      status: AuctionStatus.SoldByBuyNow,
      closesAt: new Date(command.closedAt),
    }

    this.auctions.set(closed.id, closed)

    this.buyNowOperations.set(command.operationId, {
      hash,
      auctionId: closed.id,
      transactionId: command.transactionId,
      buyerId: command.buyerId,
      transferId: command.transferId,
      priceCredits: command.priceCredits,
      remainingCredits: command.remainingCredits,
      completedAt: new Date(command.closedAt),
    })

    return Promise.resolve({
      auction: closed,
      transactionId: command.transactionId,
      replayed: false,
    })
  }

  recordBuyNowFailure(command: RecordBuyNowFailureCommand): Promise<void> {
    this.buyNowFailures.set(command.operationId, command)

    return Promise.resolve()
  }

  findBuyNowOperation(operationId: string): Promise<BuyNowOperationRecord | null> {
    const entry = this.buyNowOperations.get(operationId)

    if (entry === undefined) {
      return Promise.resolve(null)
    }

    const auction = this.auctions.get(entry.auctionId)

    if (auction === undefined) {
      return Promise.reject(new PersistedAuctionNotFoundError(entry.auctionId))
    }

    return Promise.resolve({
      auction,
      transactionId: entry.transactionId,
      buyerId: entry.buyerId,
      transferId: entry.transferId,
      priceCredits: entry.priceCredits,
      remainingCredits: entry.remainingCredits,
      completedAt: new Date(entry.completedAt),
    })
  }

  private count(sellerId: string): number {
    return [...this.auctions.values()].filter((auction) => auction.sellerId === sellerId).length
  }
}
