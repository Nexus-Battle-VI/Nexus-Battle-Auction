import type { BidSnapshot } from '../../domain/entities/Bid'
import { Bid } from '../../domain/entities/Bid'
import {
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
} from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdentifierGeneratorPort } from '../ports/IdentifierGeneratorPort'
import type { PersistBidWithCredits } from './PersistBidWithCredits'

export interface RegisterBidCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly bidderId: string
  readonly amountCredits: number
}

export class RegisterBid {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly persistence: PersistBidWithCredits,
    private readonly clock: ClockPort,
    private readonly identifiers: IdentifierGeneratorPort,
  ) {}

  async execute(command: RegisterBidCommand): Promise<BidSnapshot> {
    /*
     * Antes de crear un identificador nuevo comprobamos si
     * Idempotency-Key ya representa una operacion durable.
     *
     * Esto es esencial porque un reintento HTTP debe conservar el
     * mismo bidId y continuar la misma saga de creditos.
     */
    const existingOperation = await this.repository.findBidCreditOperation(command.operationId)

    if (existingOperation !== null) {
      return await this.resumeExistingOperation(command, existingOperation)
    }

    return await this.registerNewBid(command)
  }

  private async registerNewBid(command: RegisterBidCommand): Promise<BidSnapshot> {
    const auction = await this.repository.findById(command.auctionId)

    if (auction === null) {
      throw new PersistedAuctionNotFoundError(command.auctionId)
    }

    const now = this.clock.now()

    const [leadingBid, lastBidByBidder, activeBidCount] = await Promise.all([
      this.repository.findLeadingBid(command.auctionId),
      this.repository.findLastBidByBidder(command.bidderId),
      this.repository.countActiveBidsByBidder(command.bidderId),
    ])

    const effectiveAuctionStatus =
      now.getTime() < auction.closesAt.getTime() ? auction.status : 'CLOSED'

    const bid = Bid.register({
      bidId: this.identifiers.generate(),
      auctionId: auction.id,
      bidderId: command.bidderId,
      amountCredits: command.amountCredits,
      placedAt: now,
      eligibility: {
        auctionStatus: effectiveAuctionStatus,
        sellerId: auction.sellerId,
        currentBidCredits: leadingBid?.amountCredits ?? null,
        minimumIncrementCredits: auction.minimumBidCredits,
        lastBidAtByBidder: lastBidByBidder?.placedAt ?? null,
        activeBidCount,
      },
    })

    const result = await this.persistence.execute({
      operationId: command.operationId,
      bid,
      expiresAt: auction.closesAt,
    })

    return result.bid
  }

  private async resumeExistingOperation(
    command: RegisterBidCommand,
    operation: BidCreditOperationSnapshot,
  ): Promise<BidSnapshot> {
    this.assertSameIntent(command, operation)

    const auction = await this.repository.findById(operation.auctionId)

    if (auction === null) {
      throw new PersistedAuctionNotFoundError(operation.auctionId)
    }

    /*
     * La operacion durable conserva el bidId original.
     *
     * No llamamos Bid.register() porque no estamos intentando
     * registrar una nueva puja. Estamos reanudando exactamente
     * la misma operacion.
     */
    const bid = Bid.restore({
      id: operation.bidId,
      auctionId: operation.auctionId,
      bidderId: operation.bidderId,
      amountCredits: operation.amountCredits,
      placedAt: operation.createdAt,
    })

    const result = await this.persistence.execute({
      operationId: command.operationId,
      bid,
      expiresAt: auction.closesAt,
    })

    return result.bid
  }

  private assertSameIntent(
    command: RegisterBidCommand,
    operation: BidCreditOperationSnapshot,
  ): void {
    const sameIntent =
      operation.auctionId === command.auctionId &&
      operation.bidderId === command.bidderId &&
      operation.amountCredits === command.amountCredits

    if (!sameIntent) {
      throw new IdempotencyConflictError()
    }
  }
}
