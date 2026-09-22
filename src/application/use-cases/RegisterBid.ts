import type { BidSnapshot } from '../../domain/entities/Bid'
import { Bid } from '../../domain/entities/Bid'
import {
  IdempotencyConflictError,
  PersistedAuctionNotFoundError,
} from '../errors/AuctionPersistenceError'
import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
  PersistBidResult,
} from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdentifierGeneratorPort } from '../ports/IdentifierGeneratorPort'
import type { OutbidNotificationPort } from '../ports/OutbidNotificationPort'
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
    private readonly notifications: OutbidNotificationPort,
  ) {}

  async execute(command: RegisterBidCommand): Promise<BidSnapshot> {
    /*
     * Antes de crear un identificador nuevo comprobamos si
     * Idempotency-Key ya representa una operacion durable.
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

    /*
     * PersistBidWithCredits solo retorna cuando la operacion
     * alcanza COMPLETED.
     *
     * Por tanto, si existia un lider anterior, su reserva ya
     * fue liberada antes de llegar a notifyPreviousLeader().
     */
    const result = await this.persistence.execute({
      operationId: command.operationId,

      bid,

      expiresAt: auction.closesAt,
    })

    await this.notifyPreviousLeader(command.operationId, result)

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
     * Se restaura exactamente el bidId original.
     * No se vuelve a ejecutar Bid.register().
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

    /*
     * Notifications acepta el mismo notificationId como
     * replay idempotente.
     *
     * Esto permite reintentar una notificacion temporalmente
     * fallida sin duplicarla si la primera entrega si alcanzo
     * Notifications.
     */
    await this.notifyPreviousLeader(command.operationId, result)

    return result.bid
  }

  private async notifyPreviousLeader(operationId: string, result: PersistBidResult): Promise<void> {
    const previousLeader = result.previousLeader

    /*
     * Primera puja: no existe nadie a quien avisar.
     */
    if (previousLeader === null) {
      return
    }

    /*
     * Si el mismo jugador mejora su propia oferta no ha sido
     * desplazado por otro jugador.
     */
    if (previousLeader.bidderId === result.bid.bidderId) {
      return
    }

    try {
      await this.notifications.publish({
        notificationId: `${operationId}:outbid`,

        operationId,

        recipientPlayerId: previousLeader.bidderId,

        auctionId: result.bid.auctionId,

        outbidBidId: previousLeader.id,

        winningBidId: result.bid.id,

        winningBidderId: result.bid.bidderId,

        winningAmountCredits: result.bid.amountCredits,

        occurredAt: result.bid.placedAt,
      })
    } catch {
      /*
       * CA-05 no permite que un fallo temporal de
       * Notifications convierta en fallida una puja que ya
       * fue confirmada y cuya reserva anterior ya se libero.
       *
       * Un replay del mismo Idempotency-Key vuelve a utilizar
       * el mismo notificationId.
       */
    }
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
