import type { AuctionCancellationRepositoryPort } from '../ports/AuctionCancellationRepositoryPort'
import {
  AuctionCancellationEffectStatus,
  applicableCancellationEffectStatuses,
} from '../ports/AuctionCancellationRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { CancelAuction } from './CancelAuction'

export interface AuctionCancellationReconcilerLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  warn(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  error(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

export interface AuctionCancellationReconcilerOptions {
  readonly batchSize: number
  readonly leaseMs: number
  readonly workerId: string
}

export interface AuctionCancellationReconcilerResult {
  readonly claimed: number
  readonly confirmed: number
  readonly retryable: number
  readonly terminal: number
  readonly unexpectedErrors: number
}

const isSettled = (status: AuctionCancellationEffectStatus): boolean =>
  status === AuctionCancellationEffectStatus.Confirmed ||
  status === AuctionCancellationEffectStatus.TerminalError

/**
 * HU-90 (PR3), `7.7.10`. Recuperacion durable de cancelaciones cuyo refund en
 * Wallet y/o release en Inventory quedaron en `PENDING`/`RETRYABLE` -por un
 * fallo transitorio o porque el proceso murio despues de confirmar la
 * transicion local-. `TERMINAL_ERROR` nunca se reintenta aqui: el reclamo
 * (`claimPendingCancellations`) ya lo excluye por construccion (`7.9`).
 *
 * Reutiliza `CancelAuction.resolvePendingEffects` -el MISMO codigo que el
 * endpoint sincrono usa en el happy path- para no duplicar logica ni
 * operationIds: un reintento del reconciler usa exactamente
 * `walletRefundOperationId`/`inventoryReleaseOperationId`, nunca un UUID
 * nuevo (ver reporte final seccion O/P).
 *
 * CA-05: tambien reconcilia las cancelaciones automaticas (release de
 * inventario y de cada reserva de puja). Quien resuelve cada una lo decide
 * `AuctionCancellationEffectsResolver` segun su origen; este worker solo
 * reclama, delega y clasifica el resultado.
 */
export class AuctionCancellationReconciler {
  constructor(
    private readonly cancellations: AuctionCancellationRepositoryPort,
    private readonly cancelAuction: Pick<CancelAuction, 'resolvePendingEffects'>,
    private readonly clock: ClockPort,
    private readonly logger: AuctionCancellationReconcilerLogger,
    private readonly options: AuctionCancellationReconcilerOptions,
  ) {}

  async runBatch(): Promise<AuctionCancellationReconcilerResult> {
    const now = this.clock.now()
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs)
    const claimed = await this.cancellations.claimPendingCancellations({
      now,
      workerId: this.options.workerId,
      leaseUntil,
      limit: this.options.batchSize,
    })

    const result: AuctionCancellationReconcilerResult = {
      claimed: claimed.length,
      confirmed: 0,
      retryable: 0,
      terminal: 0,
      unexpectedErrors: 0,
    }
    if (claimed.length === 0) return result

    this.logger.info('auction_cancellation_reconciler_batch_started', {
      workerId: this.options.workerId,
      claimed: claimed.length,
    })

    for (const cancellation of claimed) {
      await this.processOne(cancellation.auctionId, result)
    }

    this.logger.info('auction_cancellation_reconciler_batch_completed', {
      workerId: this.options.workerId,
      ...result,
    })
    return result
  }

  private async processOne(
    auctionId: string,
    result: {
      -readonly [
        Key in keyof AuctionCancellationReconcilerResult
      ]: AuctionCancellationReconcilerResult[Key]
    },
  ): Promise<void> {
    try {
      const cancellation = await this.cancellations.getByAuctionId(auctionId)
      if (cancellation === null) return // Reclamado y luego borrado: no deberia pasar en operacion normal.

      await this.cancelAuction.resolvePendingEffects(cancellation)

      const refreshed = await this.cancellations.getByAuctionId(auctionId)
      if (refreshed === null) return

      // Wallet (si aplica), Inventory y, en una automatica, cada release de reserva.
      const statuses = applicableCancellationEffectStatuses(refreshed)
      if (statuses.every(isSettled)) {
        const allConfirmed = statuses.every(
          (status) => status === AuctionCancellationEffectStatus.Confirmed,
        )
        if (allConfirmed) {
          result.confirmed += 1
          this.logger.info('auction_cancellation_reconciler_confirmed', {
            workerId: this.options.workerId,
            auctionId,
          })
        } else {
          result.terminal += 1
          this.logger.error('auction_cancellation_reconciler_terminal', {
            workerId: this.options.workerId,
            auctionId,
          })
        }
        return
      }

      result.retryable += 1
      this.logger.warn('auction_cancellation_reconciler_retryable', {
        workerId: this.options.workerId,
        auctionId,
      })
    } catch (error) {
      result.unexpectedErrors += 1
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.logger.error('auction_cancellation_reconciler_unexpected_error', {
        workerId: this.options.workerId,
        auctionId,
        detail,
      })
    }
  }
}
