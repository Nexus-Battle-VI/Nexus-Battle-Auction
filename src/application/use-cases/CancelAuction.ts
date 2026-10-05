import type { AuctionSnapshot } from '../../domain/entities/Auction'
import {
  AuctionCancellationNotFoundError,
  AuctionCancellationOwnershipError,
} from '../errors/AuctionCancellationError'
import { IdempotencyConflictError } from '../errors/AuctionPersistenceError'
import {
  ExternalContractError,
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../errors/ExternalDependencyError'
import type {
  AuctionCancellationRepositoryPort,
  AuctionCancellationSnapshot,
} from '../ports/AuctionCancellationRepositoryPort'
import { AuctionCancellationEffectStatus } from '../ports/AuctionCancellationRepositoryPort'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  inventoryCancellationReleaseOperationId,
  type ProductInventoryPort,
} from '../ports/ProductInventoryPort'
import {
  walletCancellationRefundOperationId,
  type PublicationFeePort,
} from '../ports/PublicationFeePort'

export interface CancelAuctionCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly sellerId: string
}

export interface CancelAuctionResponse {
  readonly auction: AuctionSnapshot
  readonly cancellation: AuctionCancellationSnapshot
  readonly replayed: boolean
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/**
 * HU-90 (PR3), `7.7.10`. Cancelacion manual completa de una subasta activa.
 *
 * Orden de efectos (ver reporte final, seccion R, para la justificacion
 * completa): la transicion local ACTIVE -> CANCELLED, el evento
 * `auction.cancelled.v1` y la fila de seguimiento de efectos externos se
 * confirman TODOS en una sola transaccion Postgres antes de tocar Wallet o
 * Player-Inventory -el hecho de negocio "esta subasta esta cancelada" debe
 * sobrevivir aunque Wallet/Inventory esten caidos-. Wallet e Inventory se
 * resuelven despues, con `operationId` deterministico y el mismo patron de
 * `resolveInventoryIntent` de `SettleAuction`: si fallan, el progreso queda
 * en `RETRYABLE`/`TERMINAL_ERROR` y un reintento del MISMO Idempotency-Key
 * (misma `operationId`) retoma exactamente donde quedo, sin repetir la
 * transicion local ni volver a cobrar/liberar lo que ya se confirmo.
 *
 * `AuctionCancellationReconciler` retoma en segundo plano lo que quede en
 * `RETRYABLE`/`PENDING` tras un fallo o un crash (ver `resolvePendingEffects`
 * abajo); el camino sincrono de este caso de uso sigue siendo el que resuelve
 * con baja latencia en el happy path, el reconciler es solo respaldo durable.
 * La cancelacion automatica (CA-05) es otro caso de uso, con otras reglas:
 * `CancelAuctionAutomatically`.
 */
export class CancelAuction {
  constructor(
    private readonly auctions: AuctionRepositoryPort,
    private readonly cancellations: AuctionCancellationRepositoryPort,
    private readonly fees: PublicationFeePort,
    private readonly inventory: ProductInventoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: CancelAuctionCommand): Promise<CancelAuctionResponse> {
    const existing = await this.cancellations.getByAuctionId(command.auctionId)
    const replayed = existing !== null && existing.operationId === command.operationId
    if (!replayed) {
      await this.commitCancellation(command)
    }

    return this.resumeAfterCommit(command.auctionId, replayed)
  }

  /**
   * Se llega aqui con `existing === null`, o con `existing` bajo un
   * `operationId` DISTINTO -lo que NO es un conflicto de idempotencia, sino
   * una peticion nueva contra una subasta que ya no esta ACTIVE-.
   * `auction.cancel()` la rechaza con el mismo AUCTION_NOT_ACTIVE que
   * usaria si hubiera terminado por cualquier otro motivo: no hace falta una
   * rama especial para ese caso.
   */
  private async commitCancellation(command: CancelAuctionCommand): Promise<void> {
    const auction = await this.auctions.findAuctionAggregate(command.auctionId)
    if (auction === null) throw new AuctionCancellationNotFoundError(command.auctionId)
    if (auction.sellerId.value !== command.sellerId) {
      throw new AuctionCancellationOwnershipError(command.auctionId)
    }

    const now = this.clock.now()
    const bidCount = await this.auctions.countBids(command.auctionId)
    auction.cancel({ now, bidCount })

    const [inventoryCommitmentId, feeChargeId] = await Promise.all([
      this.auctions.findInventoryCommitmentId(command.auctionId),
      this.auctions.findFeeChargeId(command.auctionId),
    ])
    if (inventoryCommitmentId === null) {
      throw new Error(`La subasta ${command.auctionId} no tiene un inventoryCommitmentId durable.`)
    }

    const snapshot = auction.snapshot()
    await this.auctions.cancelAuction({
      operationId: command.operationId,
      auctionId: command.auctionId,
      sellerId: snapshot.sellerId,
      productId: snapshot.productId,
      cancelledAt: now,
      inventoryCommitmentId,
      feeChargeId,
      // `7.7.10`: la mitad de lo cobrado (1 -> 0.5; 3 -> 1.5), sin redondear.
      refundAmountCredits: snapshot.publicationFeeCredits * 0.5,
      walletRefundOperationId: walletCancellationRefundOperationId(command.auctionId),
      inventoryReleaseOperationId: inventoryCancellationReleaseOperationId(command.auctionId),
    })
  }

  private async resumeAfterCommit(
    auctionId: string,
    replayed: boolean,
  ): Promise<CancelAuctionResponse> {
    const cancellation = await this.cancellations.getByAuctionId(auctionId)
    if (cancellation === null) throw new Error(`La cancelacion de ${auctionId} no existe.`)

    await this.resolvePendingEffects(cancellation)

    const auction = await this.auctions.findById(auctionId)
    if (auction === null) throw new Error(`La subasta ${auctionId} no existe.`)
    const refreshed = await this.cancellations.getByAuctionId(auctionId)
    if (refreshed === null) throw new Error(`La cancelacion de ${auctionId} no existe.`)

    return { auction, cancellation: refreshed, replayed }
  }

  /**
   * Resuelve lo que falte de Wallet/Inventory para una cancelacion YA
   * confirmada localmente, sin repetir la transicion ACTIVE -> CANCELLED.
   * Punto de entrada compartido por el camino sincrono (`resumeAfterCommit`,
   * arriba) y por `AuctionCancellationReconciler` (recuperacion durable en
   * segundo plano, ver reporte final seccion AC): ambos deben dejar el mismo
   * rastro y usar exactamente el mismo `operationId`, nunca uno generado de
   * nuevo, asi que comparten este metodo en vez de duplicar la logica.
   */
  async resolvePendingEffects(cancellation: AuctionCancellationSnapshot): Promise<void> {
    await this.resolveWalletRefund(cancellation)
    await this.resolveInventoryRelease(cancellation)
  }

  private async resolveWalletRefund(cancellation: AuctionCancellationSnapshot): Promise<void> {
    if (
      cancellation.walletRefundStatus === AuctionCancellationEffectStatus.Confirmed ||
      cancellation.walletRefundStatus === AuctionCancellationEffectStatus.TerminalError ||
      // Solo una cancelacion automatica (CA-05) queda sin refund, y sus
      // efectos los resuelve `CancelAuctionAutomatically`, no este caso de uso.
      cancellation.walletRefundStatus === AuctionCancellationEffectStatus.NotRequired ||
      cancellation.walletRefundOperationId === null
    )
      return
    if (cancellation.feeChargeId === null) {
      // Nunca deberia ocurrir con datos consistentes (no hay cancelacion sin
      // fee cobrado), pero si ocurriera no hay nada que reembolsar.
      await this.cancellations.markWalletRefundConfirmed(cancellation.auctionId, this.clock.now())
      return
    }
    try {
      await this.fees.refund(
        cancellation.walletRefundOperationId,
        cancellation.feeChargeId,
        cancellation.refundAmountCredits,
      )
      await this.cancellations.markWalletRefundConfirmed(cancellation.auctionId, this.clock.now())
    } catch (error: unknown) {
      if (error instanceof ExternalDependencyUnavailableError) {
        await this.cancellations.markWalletRefundRetryable(
          cancellation.auctionId,
          reasonOf(error),
          this.clock.now(),
        )
        return
      }
      // Unico otro error documentado de `PublicationFeePort.refund` (ver
      // `HttpPublicationFeeClient`): un conflicto de idempotencia es un bug
      // (el payload es deterministico, nunca deberia cambiar), terminal de
      // verdad. Cualquier OTRA cosa no contemplada se propaga -mismo
      // criterio que `resolveInventoryRelease`- en vez de enmascararse
      // silenciosamente como "ya se intento y fallo".
      if (error instanceof IdempotencyConflictError) {
        await this.cancellations.markWalletRefundTerminal(
          cancellation.auctionId,
          reasonOf(error),
          this.clock.now(),
        )
        return
      }
      throw error
    }
  }

  private async resolveInventoryRelease(cancellation: AuctionCancellationSnapshot): Promise<void> {
    if (
      cancellation.inventoryReleaseStatus === AuctionCancellationEffectStatus.Confirmed ||
      cancellation.inventoryReleaseStatus === AuctionCancellationEffectStatus.TerminalError
    )
      return
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

export const CANCEL_AUCTION = Symbol('CancelAuction')
