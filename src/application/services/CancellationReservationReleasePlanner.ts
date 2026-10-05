import type { BidCreditOperationStatus } from '../ports/AuctionRepositoryPort'

/** Lo minimo de una puja persistida que necesita el plan. */
export interface PlannedBid {
  readonly creditReservationId?: string | null
}

/** Lo minimo de una operacion de creditos de puja que necesita el plan. */
export interface PlannedBidCreditOperation {
  readonly status: BidCreditOperationStatus
  readonly reservationId: string | null
  readonly previousReservationId: string | null
}

export interface PlannedReservationRelease {
  readonly reservationId: string
  readonly operationId: string
}

/**
 * HU-90, CA-05. OperationId determinista del release de UNA reserva al
 * cancelar automaticamente. Mismo namespace `auction:<id>:cancellation:` que
 * `walletCancellationRefundOperationId`/`inventoryCancellationReleaseOperationId`.
 */
export const cancellationReservationReleaseOperationId = (
  auctionId: string,
  reservationId: string,
): string => `auction:${auctionId}:cancellation:reservation:${reservationId}:release`

/**
 * HU-90, CA-05. Reservas de Wallet de una subasta que PUEDEN seguir activas
 * en el momento de cancelarla, a partir de sus pujas y de sus operaciones de
 * creditos leidas bajo el lock de la subasta.
 *
 * No se asume que solo la reserva del lider este viva. `PersistBidWithCredits`
 * libera la del lider anterior DESPUES de persistir la puja nueva y ese
 * release puede fallar (la operacion se queda en `BID_PERSISTED`), asi que
 * una reserva solo se da por liberada con evidencia durable:
 *
 * - es la `previousReservationId` de una operacion `COMPLETED` (Wallet
 *   confirmo el release del lider superado), o
 * - su propia operacion esta `COMPENSATED` (Wallet confirmo el release de una
 *   reserva cuya puja no llego a persistirse).
 *
 * Todo lo demas entra en el plan: la reserva del lider, la de un lider
 * superado cuyo release no se confirmo, y la de una operacion `RESERVED` o
 * `COMPENSATION_PENDING` cuya puja nunca se persistio. Liberar de mas es
 * inocuo -Wallet rechaza el release de un hold que ya no esta ACTIVE sin
 * mover saldo-; liberar de menos dejaria creditos retenidos.
 */
export const planCancellationReservationReleases = (
  auctionId: string,
  bids: readonly PlannedBid[],
  operations: readonly PlannedBidCreditOperation[],
): readonly PlannedReservationRelease[] => {
  const released = new Set<string>()
  for (const operation of operations) {
    if (operation.status === 'COMPLETED' && operation.previousReservationId !== null) {
      released.add(operation.previousReservationId)
    }
    if (operation.status === 'COMPENSATED' && operation.reservationId !== null) {
      released.add(operation.reservationId)
    }
  }

  const candidates = new Set<string>()
  for (const bid of bids) {
    if (bid.creditReservationId != null) candidates.add(bid.creditReservationId)
  }
  for (const operation of operations) {
    if (operation.reservationId !== null) candidates.add(operation.reservationId)
    if (operation.previousReservationId !== null) candidates.add(operation.previousReservationId)
  }

  return [...candidates]
    .filter((reservationId) => !released.has(reservationId))
    .sort((left, right) => left.localeCompare(right))
    .map((reservationId) => ({
      reservationId,
      operationId: cancellationReservationReleaseOperationId(auctionId, reservationId),
    }))
}
