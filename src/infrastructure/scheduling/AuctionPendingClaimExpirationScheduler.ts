import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'

import type { ExpirePendingClaims } from '../../application/use-cases/ExpirePendingClaims'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'
import type { SchedulerTimerHandle, SchedulerTimerPort } from './SchedulerTimer'

export interface AuctionPendingClaimExpirationSchedulerOptions {
  readonly enabled: boolean
  readonly pollIntervalMs: number
}

/** HU-69.6. Reutiliza SchedulerTimerPort, el mismo mecanismo que AuctionSettlementScheduler (HU-65.5). */
export class AuctionPendingClaimExpirationScheduler implements OnModuleInit, OnModuleDestroy {
  private timerHandle: SchedulerTimerHandle | null = null

  private activeBatch: Promise<void> | null = null

  private stopped = true

  constructor(
    private readonly worker: Pick<ExpirePendingClaims, 'runBatch'>,
    private readonly timer: SchedulerTimerPort,
    private readonly logger: Logger,
    private readonly options: AuctionPendingClaimExpirationSchedulerOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) return

    this.stopped = false
    this.timerHandle = this.timer.setInterval(() => {
      this.tick()
    }, this.options.pollIntervalMs)
    this.logger.info('auction_pending_claim_expiration_scheduler_started', {
      pollIntervalMs: this.options.pollIntervalMs,
    })
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    const handle = this.timerHandle
    this.timerHandle = null
    if (handle !== null) {
      this.timer.clearInterval(handle)
      await this.activeBatch
      this.logger.info('auction_pending_claim_expiration_scheduler_stopped')
    }
  }

  private tick(): void {
    if (this.stopped) return
    if (this.activeBatch !== null) {
      this.logger.warn('auction_pending_claim_expiration_scheduler_tick_skipped')
      return
    }

    const batch = this.worker
      .runBatch()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error('auction_pending_claim_expiration_scheduler_error', {
          detail: describeError(error),
        })
      })
      .finally(() => {
        if (this.activeBatch === batch) this.activeBatch = null
      })
    this.activeBatch = batch
  }
}
