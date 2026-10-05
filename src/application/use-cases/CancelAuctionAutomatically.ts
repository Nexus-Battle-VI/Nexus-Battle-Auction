import { AuctionStatus } from '../../domain/entities/Auction'
import { AuctionRuleCode, AuctionRuleViolation } from '../../domain/errors/AuctionRuleViolation'
import { AuctionCancellationOrigin } from '../../domain/events/AuctionCancelledEventV1'
import { AuctionCancellationNotFoundError } from '../errors/AuctionCancellationError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../errors/ExternalDependencyError'
import type {
  AuctionCancellationRepositoryPort,
  AuctionCancellationReservationReleaseSnapshot,
  AuctionCancellationSnapshot,
} from '../ports/AuctionCancellationRepositoryPort'
import { AuctionCancellationEffectStatus } from '../ports/AuctionCancellationRepositoryPort'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { AuctionWalletPort } from '../ports/AuctionWalletPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  inventoryCancellationReleaseOperationId,
  type ProductInventoryPort,
} from '../ports/ProductInventoryPort'

export interface CancelAuctionAutomaticallyCommand {
  readonly auctionId: string
  /** Id de la sancion AUCTION_TERMS_VIOLATION que dispara la cancelacion. */
  readonly sanctionId: string
}

export const AutomaticCancellationOutcome = {
  /** Esta ejecucion hizo la transicion ACTIVE -> CANCELLED. */
  Cancelled: 'CANCELLED',
  /** Ya estaba cancelada automaticamente: solo se retomaron efectos pendientes. */
  AlreadyCancelled: 'ALREADY_CANCELLED',
  /** La subasta ya no estaba ACTIVE por otro motivo; no se hizo nada. */
  NotActive: 'NOT_ACTIVE',
} as const

export type AutomaticCancellationOutcome =
  (typeof AutomaticCancellationOutcome)[keyof typeof AutomaticCancellationOutcome]

export interface CancelAuctionAutomaticallyResponse {
  readonly outcome: AutomaticCancellationOutcome
  /** `null` solo con `NOT_ACTIVE` sin seguimiento de cancelacion automatica. */
  readonly cancellation: AuctionCancellationSnapshot | null
}

/** HU-90, CA-05. Idempotencia por sancion + subasta. */
export const automaticCancellationOperationId = (sanctionId: string, auctionId: string): string =>
  `automatic-cancellation:${sanctionId}:${auctionId}`

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const isResolved = (status: AuctionCancellationEffectStatus): boolean =>
  status === AuctionCancellationEffectStatus.Confirmed ||
  status === AuctionCancellationEffectStatus.TerminalError

/**
 * HU-90, CA-05. Cancelacion automatica de una subasta ACTIVE cuyo vendedor
 * tiene una sancion activa con reasonCode AUCTION_TERMS_VIOLATION.
 *
 * Caso de uso SEPARADO de `CancelAuction` -no un flag sobre el-, porque las
 * reglas son otras: es una operacion de sistema (sin propietario que
 * validar), no la impiden ni las pujas ni la ventana de 6 horas, NO
 * reembolsa la comision de publicacion y, como puede haber pujas, libera las
 * reservas de creditos de todos los postores, incluido el lider. Nunca elige
 * ganador ni dispara settlement: la subasta queda CANCELLED, estado que
 * `findSettlementCandidates` excluye.
 *
 * Mismo orden de efectos que la manual: la transicion local, el evento
 * `auction.cancelled.v1` y el seguimiento de efectos se confirman en una sola
 * transaccion antes de tocar Wallet o Player-Inventory; lo que falle despues
 * queda en `RETRYABLE`/`TERMINAL_ERROR` y lo retoma
 * `AuctionCancellationReconciler` con los mismos `operationId`.
 */
export class CancelAuctionAutomatically {
  constructor(
    private readonly auctions: AuctionRepositoryPort,
    private readonly cancellations: AuctionCancellationRepositoryPort,
    private readonly wallet: AuctionWalletPort,
    private readonly inventory: ProductInventoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(
    command: CancelAuctionAutomaticallyCommand,
  ): Promise<CancelAuctionAutomaticallyResponse> {
    const existing = await this.cancellations.getByAuctionId(command.auctionId)
    if (existing !== null) return this.resumeExisting(existing)

    const committed = await this.commitCancellation(command)
    if (!committed) {
      // Otra transicion terminal gano la carrera. Si fue otra cancelacion
      // automatica (otro worker), sus efectos se retoman aqui mismo.
      const raced = await this.cancellations.getByAuctionId(command.auctionId)
      if (raced !== null) return this.resumeExisting(raced)
      return { outcome: AutomaticCancellationOutcome.NotActive, cancellation: null }
    }

    return {
      outcome: AutomaticCancellationOutcome.Cancelled,
      cancellation: await this.resolveAndRefresh(command.auctionId),
    }
  }

  /**
   * Una subasta se cancela una sola vez. Si ya la cancelo el vendedor, sus
   * efectos (refund + inventario) son de `CancelAuction` y no se tocan aqui.
   * Si ya se cancelo automaticamente -por esta sancion o por otra- solo se
   * retoman los efectos que falten, con los `operationId` ya persistidos.
   */
  private async resumeExisting(
    existing: AuctionCancellationSnapshot,
  ): Promise<CancelAuctionAutomaticallyResponse> {
    if (existing.origin !== AuctionCancellationOrigin.TermsViolation) {
      return { outcome: AutomaticCancellationOutcome.NotActive, cancellation: null }
    }
    return {
      outcome: AutomaticCancellationOutcome.AlreadyCancelled,
      cancellation: await this.resolveAndRefresh(existing.auctionId),
    }
  }

  /** `false` si la subasta ya no estaba ACTIVE (antes o bajo el lock). */
  private async commitCancellation(command: CancelAuctionAutomaticallyCommand): Promise<boolean> {
    const auction = await this.auctions.findAuctionAggregate(command.auctionId)
    if (auction === null) throw new AuctionCancellationNotFoundError(command.auctionId)
    if (auction.status !== AuctionStatus.Active) return false

    const now = this.clock.now()
    auction.cancelAutomatically({ now })

    try {
      await this.auctions.cancelAuctionAutomatically({
        operationId: automaticCancellationOperationId(command.sanctionId, command.auctionId),
        auctionId: command.auctionId,
        triggerReferenceId: command.sanctionId,
        cancelledAt: now,
        inventoryReleaseOperationId: inventoryCancellationReleaseOperationId(command.auctionId),
      })
    } catch (error: unknown) {
      if (
        error instanceof AuctionRuleViolation &&
        error.code === AuctionRuleCode.AuctionNotActive
      ) {
        return false
      }
      throw error
    }
    return true
  }

  private async resolveAndRefresh(auctionId: string): Promise<AuctionCancellationSnapshot> {
    const cancellation = await this.cancellations.getByAuctionId(auctionId)
    if (cancellation === null) throw new Error(`La cancelacion de ${auctionId} no existe.`)

    await this.resolvePendingEffects(cancellation)

    const refreshed = await this.cancellations.getByAuctionId(auctionId)
    if (refreshed === null) throw new Error(`La cancelacion de ${auctionId} no existe.`)
    return refreshed
  }

  /**
   * Resuelve lo que falte de una cancelacion automatica YA confirmada
   * localmente. Punto de entrada compartido por `execute` y por
   * `AuctionCancellationReconciler`. Deliberadamente NO hay refund de la
   * comision de publicacion: una cancelacion por incumplimiento la retiene
   * entera y tampoco cobra nada adicional.
   */
  async resolvePendingEffects(cancellation: AuctionCancellationSnapshot): Promise<void> {
    for (const release of cancellation.reservationReleases) {
      await this.resolveReservationRelease(cancellation.auctionId, release)
    }
    await this.resolveInventoryRelease(cancellation)
  }

  private async resolveReservationRelease(
    auctionId: string,
    release: AuctionCancellationReservationReleaseSnapshot,
  ): Promise<void> {
    if (isResolved(release.status)) return

    const result = await this.wallet.releaseHold({
      holdId: release.reservationId,
      operationId: release.operationId,
      // Reason propio de cancelacion (distinto de AUCTION_OUTBID y de
      // AUCTION_SETTLEMENT_LOST): el `operationId`
      // (`...:cancellation:reservation:...`) ya distinguia el origen para
      // Auction, pero Wallet necesita el reason correcto para su propia
      // trazabilidad y para no confundir esta liberacion con una de fin de
      // subasta normal.
      reason: 'AUCTION_CANCELLED',
    })
    const now = this.clock.now()

    // Un hold ya no ACTIVE por outbid o por expiracion responde 200 con
    // holdStatus RELEASED o EXPIRED (ambos son el efecto buscado: creditos
    // no retenidos). `applied` puede ser true o false, no importa cual.
    if (
      result.outcome === 'SUCCESS' &&
      (result.holdStatus === 'RELEASED' || result.holdStatus === 'EXPIRED')
    ) {
      await this.cancellations.markReservationReleaseConfirmed(
        auctionId,
        release.reservationId,
        now,
      )
      return
    }
    if (result.outcome === 'RETRYABLE' || result.outcome === 'INVALID_RESPONSE') {
      await this.cancellations.markReservationReleaseRetryable(
        auctionId,
        release.reservationId,
        `El release Wallet requiere reintento: ${result.outcome}.`,
        now,
      )
      return
    }
    // TERMINAL_RULE_ERROR (el unico 422 real de este endpoint es un hold
    // CAPTURED, cuyos creditos ya no vuelven al postor), TERMINAL_NOT_FOUND
    // (Auction afirma que esta reserva deberia existir) o TERMINAL_CONFLICT:
    // ninguno es un release exitoso, no se infiere liberacion por el mensaje
    // ni se reintenta indefinidamente.
    await this.cancellations.markReservationReleaseTerminal(
      auctionId,
      release.reservationId,
      `El release Wallet fallo terminalmente: ${result.outcome}.`,
      now,
    )
  }

  private async resolveInventoryRelease(cancellation: AuctionCancellationSnapshot): Promise<void> {
    if (isResolved(cancellation.inventoryReleaseStatus)) return
    try {
      await this.inventory.release({
        operationId: cancellation.inventoryReleaseOperationId,
        commitmentId: cancellation.inventoryCommitmentId,
        auctionId: cancellation.auctionId,
        ownerId: cancellation.sellerId,
        productId: cancellation.productId,
        reason: 'AUCTION_CANCELLED',
      })
      await this.cancellations.markInventoryReleaseConfirmed(
        cancellation.auctionId,
        this.clock.now(),
      )
    } catch (error: unknown) {
      if (error instanceof ExternalDependencyUnavailableError) {
        await this.cancellations.markInventoryReleaseRetryable(
          cancellation.auctionId,
          reasonOf(error),
          this.clock.now(),
        )
        return
      }
      if (
        error instanceof ExternalContractError ||
        error instanceof ExternalResourceNotFoundError
      ) {
        await this.cancellations.markInventoryReleaseTerminal(
          cancellation.auctionId,
          reasonOf(error),
          this.clock.now(),
        )
        return
      }
      throw error
    }
  }
}
