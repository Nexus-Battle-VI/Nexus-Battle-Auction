import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { DispatchClosingSoonReminders } from '../../application/use-cases/DispatchClosingSoonReminders'
import type { Logger } from '../observability/logger'

const POLL_INTERVAL_MS = 60_000

/** Adaptador temporal que dispara la regla determinista una vez por minuto. */
export class AuctionReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly reminders: DispatchClosingSoonReminders,
    private readonly logger: Logger,
  ) {}

  /** Inicia un intervalo no bloqueante; el eventId estable soporta reintentos. */
  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
    this.timer.unref()
  }

  /** Libera el temporizador durante apagado y pruebas. */
  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer)
  }

  private async tick(): Promise<void> {
    try {
      const recipients = await this.reminders.execute()
      if (recipients > 0) this.logger.info('auction_closing_reminders_published', { recipients })
    } catch (error: unknown) {
      this.logger.warn('auction_closing_reminders_pending', {
        detail: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
}
