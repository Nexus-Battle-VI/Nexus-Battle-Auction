import type {
  AuctionRepositoryPort,
  BidCreditOperationSnapshot,
  PersistBidResult,
} from '../ports/AuctionRepositoryPort'
import type { BidCreditsPort } from '../ports/BidCreditsPort'
import type { ClockPort } from '../ports/ClockPort'
import { BidCreditCompensationError, InsufficientBidCreditsError } from '../errors/BidCreditError'
import type { Bid } from '../../domain/entities/Bid'

export interface PersistBidWithCreditsCommand {
  readonly operationId: string
  readonly bid: Bid
  readonly expiresAt: Date
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const reserveOperationId = (operationId: string): string => `${operationId}:reserve`

const releaseNewOperationId = (operationId: string): string => `${operationId}:release-new`

const releasePreviousOperationId = (operationId: string): string =>
  `${operationId}:release-previous`

export class PersistBidWithCredits {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly credits: BidCreditsPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: PersistBidWithCreditsCommand): Promise<PersistBidResult> {
    const bid = command.bid.snapshot()

    /*
     * La intencion local se registra antes de llamar a Wallet.
     * El repositorio hace esta operacion idempotente.
     */
    await this.repository.createBidCreditOperation({
      operationId: command.operationId,
      bidId: bid.id,
      auctionId: bid.auctionId,
      bidderId: bid.bidderId,
      amountCredits: bid.amountCredits,
      createdAt: this.clock.now(),
    })

    let operation = await this.requireOperation(command.operationId)

    /*
     * Una operacion ya compensada no debe crear una nueva reserva.
     */
    if (operation.status === 'COMPENSATED') {
      throw new Error(`La operacion de puja ${command.operationId} ya fue compensada.`)
    }

    /*
     * Si una compensacion quedo pendiente, el reintento continua
     * exactamente desde la liberacion de la reserva nueva.
     */
    if (operation.status === 'COMPENSATION_PENDING') {
      await this.retryPendingCompensation(command, operation)

      throw new Error(`La operacion de puja ${command.operationId} fue compensada.`)
    }

    /*
     * Solo las operaciones nuevas consultan saldo y reservan.
     */
    if (operation.status === 'PENDING_RESERVATION') {
      operation = await this.reserveCredits(command)
    }

    /*
     * Si Wallet ya habia reservado en un intento anterior,
     * reutilizamos reservationId.
     */
    if (operation.status === 'RESERVED') {
      operation = await this.persistReservedBid(command, operation)
    }

    /*
     * Si la puja ya se persistio, solo queda liberar la reserva
     * del lider anterior.
     */
    if (operation.status === 'BID_PERSISTED') {
      operation = await this.releasePreviousReservation(command, operation)
    }

    if (operation.status !== 'COMPLETED') {
      throw new Error(`Estado inesperado de la operacion de creditos: ${operation.status}.`)
    }

    return await this.rebuildPersistedResult(command, operation)
  }

  private async reserveCredits(
    command: PersistBidWithCreditsCommand,
  ): Promise<BidCreditOperationSnapshot> {
    const bid = command.bid.snapshot()

    const balance = await this.credits.getAvailableCredits(bid.bidderId)

    if (balance.availableCredits < bid.amountCredits) {
      const error = new InsufficientBidCreditsError(balance.availableCredits, bid.amountCredits)

      await this.repository.recordBidCreditFailure({
        operationId: command.operationId,
        bidId: bid.id,
        auctionId: bid.auctionId,
        bidderId: bid.bidderId,
        stage: 'CHECKING_BALANCE',
        reason: reasonOf(error),
        newReservationId: null,
        previousReservationId: null,
        newReservationReleased: false,
        previousReservationReleased: false,
        occurredAt: this.clock.now(),
      })

      throw error
    }

    try {
      const reservation = await this.credits.reserve({
        operationId: reserveOperationId(command.operationId),
        bidderId: bid.bidderId,
        bidId: bid.id,
        auctionId: bid.auctionId,
        amount: bid.amountCredits,
        expiresAt: command.expiresAt,
      })

      await this.repository.updateBidCreditOperation({
        operationId: command.operationId,
        status: 'RESERVED',
        reservationId: reservation.reservationId,
        previousReservationId: null,
        updatedAt: this.clock.now(),
      })

      return await this.requireOperation(command.operationId)
    } catch (error: unknown) {
      await this.repository.recordBidCreditFailure({
        operationId: command.operationId,
        bidId: bid.id,
        auctionId: bid.auctionId,
        bidderId: bid.bidderId,
        stage: 'RESERVING_CREDITS',
        reason: reasonOf(error),
        newReservationId: null,
        previousReservationId: null,
        newReservationReleased: false,
        previousReservationReleased: false,
        occurredAt: this.clock.now(),
      })

      throw error
    }
  }

  private async persistReservedBid(
    command: PersistBidWithCreditsCommand,
    operation: BidCreditOperationSnapshot,
  ): Promise<BidCreditOperationSnapshot> {
    const bid = command.bid.snapshot()

    const reservationId = operation.reservationId

    if (reservationId === null) {
      throw new Error('Una operacion RESERVED debe tener reservationId.')
    }

    try {
      /*
       * persistBid guarda atomicamente:
       * - nueva puja;
       * - nuevo lider;
       * - reservationId;
       * - previousReservationId;
       * - estado BID_PERSISTED.
       */
      await this.repository.persistBid(command.bid, reservationId, command.operationId)

      return await this.requireOperation(command.operationId)
    } catch (error: unknown) {
      try {
        /*
         * Si la persistencia falla despues de reservar,
         * liberamos la reserva nueva usando un operationId distinto.
         */
        await this.credits.release(releaseNewOperationId(command.operationId), reservationId)

        await this.repository.updateBidCreditOperation({
          operationId: command.operationId,
          status: 'COMPENSATED',
          reservationId,
          previousReservationId: null,
          updatedAt: this.clock.now(),
        })

        await this.repository.recordBidCreditFailure({
          operationId: command.operationId,
          bidId: bid.id,
          auctionId: bid.auctionId,
          bidderId: bid.bidderId,
          stage: 'PERSISTING_BID',
          reason: reasonOf(error),
          newReservationId: reservationId,
          previousReservationId: null,
          newReservationReleased: true,
          previousReservationReleased: false,
          occurredAt: this.clock.now(),
        })

        throw error
      } catch (compensationError: unknown) {
        /*
         * Si entramos aqui porque relanzamos el error original,
         * la compensacion ya termino correctamente.
         */
        if (compensationError === error) {
          throw error
        }

        /*
         * Wallet fallo al liberar la reserva nueva.
         * Dejamos evidencia durable para reintentar despues.
         */
        await this.repository.updateBidCreditOperation({
          operationId: command.operationId,
          status: 'COMPENSATION_PENDING',
          reservationId,
          previousReservationId: null,
          updatedAt: this.clock.now(),
        })

        await this.repository.recordBidCreditFailure({
          operationId: command.operationId,
          bidId: bid.id,
          auctionId: bid.auctionId,
          bidderId: bid.bidderId,
          stage: 'RELEASING_NEW_RESERVATION',
          reason: reasonOf(compensationError),
          newReservationId: reservationId,
          previousReservationId: null,
          newReservationReleased: false,
          previousReservationReleased: false,
          occurredAt: this.clock.now(),
        })

        throw new BidCreditCompensationError(reservationId, compensationError)
      }
    }
  }

  private async releasePreviousReservation(
    command: PersistBidWithCreditsCommand,
    operation: BidCreditOperationSnapshot,
  ): Promise<BidCreditOperationSnapshot> {
    const bid = command.bid.snapshot()

    const previousReservationId = operation.previousReservationId

    if (previousReservationId !== null) {
      try {
        await this.credits.release(
          releasePreviousOperationId(command.operationId),
          previousReservationId,
        )
      } catch (error: unknown) {
        await this.repository.recordBidCreditFailure({
          operationId: command.operationId,
          bidId: bid.id,
          auctionId: bid.auctionId,
          bidderId: bid.bidderId,
          stage: 'RELEASING_PREVIOUS_RESERVATION',
          reason: reasonOf(error),
          newReservationId: operation.reservationId,
          previousReservationId,
          newReservationReleased: false,
          previousReservationReleased: false,
          occurredAt: this.clock.now(),
        })

        /*
         * El estado se mantiene BID_PERSISTED.
         * Un reintento no reserva ni persiste otra vez.
         */
        throw error
      }
    }

    await this.repository.updateBidCreditOperation({
      operationId: command.operationId,
      status: 'COMPLETED',
      reservationId: operation.reservationId,
      previousReservationId,
      updatedAt: this.clock.now(),
    })

    return await this.requireOperation(command.operationId)
  }

  private async retryPendingCompensation(
    command: PersistBidWithCreditsCommand,
    operation: BidCreditOperationSnapshot,
  ): Promise<void> {
    const reservationId = operation.reservationId

    if (reservationId === null) {
      throw new Error('Una compensacion pendiente debe tener reservationId.')
    }

    try {
      await this.credits.release(releaseNewOperationId(command.operationId), reservationId)
    } catch (error: unknown) {
      const bid = command.bid.snapshot()

      await this.repository.recordBidCreditFailure({
        operationId: command.operationId,
        bidId: bid.id,
        auctionId: bid.auctionId,
        bidderId: bid.bidderId,
        stage: 'RELEASING_NEW_RESERVATION',
        reason: reasonOf(error),
        newReservationId: reservationId,
        previousReservationId: operation.previousReservationId,
        newReservationReleased: false,
        previousReservationReleased: false,
        occurredAt: this.clock.now(),
      })

      throw new BidCreditCompensationError(reservationId, error)
    }

    await this.repository.updateBidCreditOperation({
      operationId: command.operationId,
      status: 'COMPENSATED',
      reservationId,
      previousReservationId: operation.previousReservationId,
      updatedAt: this.clock.now(),
    })
  }

  private async requireOperation(operationId: string): Promise<BidCreditOperationSnapshot> {
    const operation = await this.repository.findBidCreditOperation(operationId)

    if (operation === null) {
      throw new Error(`La operacion de creditos ${operationId} no existe.`)
    }

    return operation
  }

  private async rebuildPersistedResult(
    command: PersistBidWithCreditsCommand,
    operation: BidCreditOperationSnapshot,
  ): Promise<PersistBidResult> {
    const expected = command.bid.snapshot()

    const history = await this.repository.findBidHistory(expected.auctionId)

    const index = history.findIndex((bid) => bid.id === expected.id)

    if (index < 0) {
      throw new Error(
        `La puja ${expected.id} no existe aunque la operacion figura como completada.`,
      )
    }

    const persistedBid = history[index]

    if (persistedBid === undefined) {
      throw new Error(`La puja ${expected.id} no pudo reconstruirse desde el historial.`)
    }

    return {
      bid: persistedBid,
      previousLeader: index === 0 ? null : (history[index - 1] ?? null),
      previousLeaderReservationId: operation.previousReservationId,
    }
  }
}
