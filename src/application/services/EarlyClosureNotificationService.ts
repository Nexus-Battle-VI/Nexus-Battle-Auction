import type { BidSnapshot } from '../../domain/entities/Bid'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { BidCreditsPort } from '../ports/BidCreditsPort'
import type { ClockPort } from '../ports/ClockPort'
import type {
  EarlyClosureNotificationRecord,
  EarlyClosureNotificationRepositoryPort,
  EarlyClosureNotificationStatus,
} from '../ports/EarlyClosureNotificationRepositoryPort'
import type { NotificationPort } from '../ports/NotificationPort'

/** Cuantos intentos ACUMULADOS (entre el primer intento y cualquier reintento) se hacen antes de dejar `FAILED` de forma permanente. */
export const MAX_DELIVERY_ATTEMPTS = 3

export interface AuctionClosedByBuyNowEvent {
  readonly auctionId: string
  readonly buyerId: string
  readonly transactionId: string
  readonly closedAt: Date
}

export interface BidderNotificationOutcome {
  readonly bidderId: string
  readonly status: EarlyClosureNotificationStatus
  readonly attempts: number
}

export interface EarlyClosureOutcome {
  readonly auctionId: string
  readonly notified: readonly BidderNotificationOutcome[]
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/**
 * Un postor por auctionId, con su puja MAS RECIENTE, excluido quien acaba de
 * comprar.
 */
const latestBidByBidder = (
  history: readonly BidSnapshot[],
  excludeBidderId: string,
): ReadonlyMap<string, BidSnapshot> => {
  const latest = new Map<string, BidSnapshot>()

  for (const bid of history) {
    if (bid.bidderId === excludeBidderId) {
      continue
    }

    const current = latest.get(bid.bidderId)

    if (current === undefined || bid.placedAt.getTime() >= current.placedAt.getTime()) {
      latest.set(bid.bidderId, bid)
    }
  }

  return latest
}

/**
 * NotificationService (HU-64.5): notifica el cierre anticipado a todo el que
 * participo con una puja y libera, cuando corresponde, el credito que esa
 * puja todavia tenia retenido.
 *
 * "Cuando corresponde" es solo el postor que iba LIDER al momento del cierre.
 * El resto ya recupero sus creditos en tiempo real, el momento en que otra
 * puja los desplazo -vease `RegisterBid.registerNewBid`, HU-63.2/63.4-: no
 * queda nada por liberar para ellos, y volver a intentarlo seria liberar una
 * reserva que ya no existe.
 *
 * `processClosure` se invoca desde `ExecuteBuyNowUseCase` justo despues de que
 * `TransactionProcessingService` (HU-64.3) completa la compra -es su propia
 * dependencia declarada-, nunca antes: solo entonces se sabe que la compra se
 * ejecuto de verdad. Un fallo aqui NUNCA debe deshacer ni demorar la respuesta
 * al comprador, que ya pago; por eso cada entrega es de mejor esfuerzo, con su
 * propio estado persistido y reintentable via `retryFailed`.
 */
export class EarlyClosureNotificationService {
  constructor(
    private readonly auctions: AuctionRepositoryPort,
    private readonly notifications: EarlyClosureNotificationRepositoryPort,
    private readonly credits: BidCreditsPort,
    private readonly notifier: NotificationPort,
    private readonly clock: ClockPort,
  ) {}

  async processClosure(event: AuctionClosedByBuyNowEvent): Promise<EarlyClosureOutcome> {
    const [history, leadingBid] = await Promise.all([
      this.auctions.findBidHistory(event.auctionId),
      this.auctions.findLeadingBid(event.auctionId),
    ])

    const losingBidders = latestBidByBidder(history, event.buyerId)
    const notified: BidderNotificationOutcome[] = []

    for (const [bidderId, bid] of losingBidders) {
      const isStillLeading = leadingBid !== null && leadingBid.id === bid.id

      let creditOperationId: string | null = null
      let creditReservationId: string | null = null

      if (isStillLeading) {
        const operation = await this.auctions.findBidCreditOperationByBid(bid.id)

        creditOperationId = operation?.operationId ?? null
        creditReservationId = operation?.reservationId ?? null
      }

      const record = await this.notifications.ensurePending({
        auctionId: event.auctionId,
        bidderId,
        transactionId: event.transactionId,
        bidId: bid.id,
        amountCredits: bid.amountCredits,
        closedAt: event.closedAt,
        creditOperationId,
        creditReservationId,
      })

      notified.push(await this.deliver(record))
    }

    return { auctionId: event.auctionId, notified }
  }

  /**
   * Reintento (HU-64.5): hace UN intento mas por cada notificacion que siga en
   * `FAILED` y no haya agotado `MAX_DELIVERY_ATTEMPTS`. Pensado para
   * invocarse repetidamente -por ejemplo desde un planificador externo, fuera
   * del alcance de esta Task-, no para agotar los reintentos de una sola vez.
   */
  async retryFailed(): Promise<readonly BidderNotificationOutcome[]> {
    const failed = await this.notifications.findFailed()
    const retryable = failed.filter((record) => record.attempts < MAX_DELIVERY_ATTEMPTS)

    const outcomes: BidderNotificationOutcome[] = []

    for (const record of retryable) {
      outcomes.push(await this.deliver(record))
    }

    return outcomes
  }

  /** Un unico intento de entrega; nunca reintenta dentro de si misma. */
  private async deliver(
    record: EarlyClosureNotificationRecord,
  ): Promise<BidderNotificationOutcome> {
    if (record.status === 'SENT') {
      return { bidderId: record.bidderId, status: 'SENT', attempts: record.attempts }
    }

    const attempts = record.attempts + 1
    let creditsReleased = record.creditsReleased
    let lastError: string | null
    let status: EarlyClosureNotificationStatus

    try {
      if (
        !creditsReleased &&
        record.creditOperationId !== null &&
        record.creditReservationId !== null
      ) {
        await this.credits.release(record.creditOperationId, record.creditReservationId)
        creditsReleased = true
      }

      await this.notifier.notifyAuctionClosedEarly({
        operationId: `${record.transactionId}:${record.bidderId}`,
        auctionId: record.auctionId,
        recipientId: record.bidderId,
        transactionId: record.transactionId,
        closedAt: record.closedAt,
      })

      status = 'SENT'
      lastError = null
    } catch (error: unknown) {
      status = 'FAILED'
      lastError = reasonOf(error)
    }

    await this.notifications.recordAttempt({
      auctionId: record.auctionId,
      bidderId: record.bidderId,
      transactionId: record.transactionId,
      status,
      attempts,
      creditsReleased,
      lastError,
      occurredAt: this.clock.now(),
    })

    return { bidderId: record.bidderId, status, attempts }
  }
}
