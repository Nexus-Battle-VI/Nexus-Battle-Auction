import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { AuctionConfirmationOutboxDispatcher } from '../../application/use-cases/AuctionConfirmationOutboxDispatcher'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'
import type { SchedulerTimerHandle, SchedulerTimerPort } from './SchedulerTimer'

export interface AuctionConfirmationDispatchSchedulerOptions {
  readonly enabled: boolean
  readonly pollIntervalMs: number
}

export class AuctionConfirmationDispatchScheduler implements OnModuleInit, OnModuleDestroy {
  private timerHandle: SchedulerTimerHandle | null = null
  private activeBatch: Promise<void> | null = null
  private stopped = true

  constructor(
    private readonly worker: Pick<AuctionConfirmationOutboxDispatcher, 'runBatch'>,
    private readonly timer: SchedulerTimerPort,
    private readonly logger: Logger,
    private readonly options: AuctionConfirmationDispatchSchedulerOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled || !this.stopped) return
    this.stopped = false
    this.timerHandle = this.timer.setInterval(() => {
      this.tick()
    }, this.options.pollIntervalMs)
    this.logger.info('auction_confirmation_dispatch_scheduler_started', {
      pollIntervalMs: this.options.pollIntervalMs,
    })
    this.tick()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    const handle = this.timerHandle
    this.timerHandle = null
    if (handle !== null) this.timer.clearInterval(handle)
    await this.activeBatch
    this.logger.info('auction_confirmation_dispatch_scheduler_stopped')
  }

  private tick(): void {
    if (this.stopped || this.activeBatch !== null) return
    const batch = Promise.resolve()
      .then(() => this.worker.runBatch())
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error('auction_confirmation_dispatch_scheduler_error', {
          detail: describeError(error),
        })
      })
      .finally(() => {
        if (this.activeBatch === batch) this.activeBatch = null
      })
    this.activeBatch = batch
  }
}
