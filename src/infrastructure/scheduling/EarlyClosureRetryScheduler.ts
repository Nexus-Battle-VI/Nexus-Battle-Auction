import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'

import type { EarlyClosureNotificationService } from '../../application/services/EarlyClosureNotificationService'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'
import type { SchedulerTimerHandle, SchedulerTimerPort } from './SchedulerTimer'

export interface EarlyClosureRetrySchedulerOptions {
  readonly enabled: boolean
  readonly pollIntervalMs: number
}

/**
 * HU-64.5. Reintenta de forma periodica las notificaciones de cierre temprano
 * que quedaron en FAILED. El servicio conserva la idempotencia de la entrega y
 * de la liberacion de creditos; este scheduler solo coordina sus reintentos.
 */
export class EarlyClosureRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private timerHandle: SchedulerTimerHandle | null = null

  private activeBatch: Promise<void> | null = null

  private stopped = true

  constructor(
    private readonly worker: Pick<EarlyClosureNotificationService, 'retryFailed'>,
    private readonly timer: SchedulerTimerPort,
    private readonly logger: Logger,
    private readonly options: EarlyClosureRetrySchedulerOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) return

    this.stopped = false
    this.timerHandle = this.timer.setInterval(() => {
      this.tick()
    }, this.options.pollIntervalMs)
    this.logger.info('early_closure_retry_scheduler_started', {
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
      this.logger.info('early_closure_retry_scheduler_stopped')
    }
  }

  private tick(): void {
    if (this.stopped) return
    if (this.activeBatch !== null) {
      this.logger.warn('early_closure_retry_scheduler_tick_skipped')
      return
    }

    const batch = this.worker
      .retryFailed()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error('early_closure_retry_scheduler_error', {
          detail: describeError(error),
        })
      })
      .finally(() => {
        if (this.activeBatch === batch) this.activeBatch = null
      })
    this.activeBatch = batch
  }
}
