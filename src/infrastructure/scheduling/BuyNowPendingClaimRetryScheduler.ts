import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { RetryBuyNowPendingClaims } from '../../application/use-cases/RetryBuyNowPendingClaims'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'
import type { SchedulerTimerHandle, SchedulerTimerPort } from './SchedulerTimer'

export interface BuyNowPendingClaimRetrySchedulerOptions {
  readonly enabled: boolean
  readonly pollIntervalMs: number
}
export class BuyNowPendingClaimRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private timerHandle: SchedulerTimerHandle | null = null
  private activeBatch: Promise<void> | null = null
  private stopped = true
  constructor(
    private readonly worker: Pick<RetryBuyNowPendingClaims, 'runBatch'>,
    private readonly timer: SchedulerTimerPort,
    private readonly logger: Logger,
    private readonly options: BuyNowPendingClaimRetrySchedulerOptions,
  ) {}
  onModuleInit(): void {
    if (!this.options.enabled) return
    this.stopped = false
    this.timerHandle = this.timer.setInterval(() => this.tick(), this.options.pollIntervalMs)
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    const handle = this.timerHandle
    this.timerHandle = null
    if (handle !== null) {
      this.timer.clearInterval(handle)
      await this.activeBatch
    }
  }
  private tick(): void {
    if (this.stopped || this.activeBatch !== null) return
    const batch = this.worker
      .runBatch()
      .then(() => undefined)
      .catch((error: unknown) =>
        this.logger.error('buy_now_pending_claim_retry_scheduler_error', {
          detail: describeError(error),
        }),
      )
      .finally(() => {
        if (this.activeBatch === batch) this.activeBatch = null
      })
    this.activeBatch = batch
  }
}
