import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Client } from 'pg'

import {
  parseAuctionRealtimeNotice,
  type AuctionRealtimeSignalV1,
} from '../../../domain/events/AuctionRealtimeSignalV1'
import type { Logger } from '../../../infrastructure/observability/logger'

/** Canal que emiten los triggers de la migracion 021. */
export const AUCTION_REALTIME_CHANNEL = 'auction_realtime'

export interface AuctionRealtimeListenerOptions {
  readonly connectionString: string
  /** Primer reintento tras una caida; se duplica hasta `maxReconnectDelayMs`. */
  readonly reconnectDelayMs?: number
  readonly maxReconnectDelayMs?: number
}

export interface AuctionRealtimeListenerHandlers {
  /** Una senal valida, entregada por PostgreSQL SOLO tras confirmarse la transaccion. */
  onSignal(signal: AuctionRealtimeSignalV1): void
  /**
   * La conexion de escucha se perdio y se recupero: las senales emitidas mientras estuvo caida no
   * se recuperan, y los clientes deben releer por HTTP.
   */
  onResync(): void
}

/**
 * Oyente de `LISTEN auction_realtime` (EN-034, ADR-024). Usa UNA conexion propia, fuera del pool
 * de consultas: una conexion en LISTEN no puede devolverse al pool.
 *
 * Si la conexion cae, reintenta con backoff exponencial y, al recuperarla, pide a los clientes
 * que relean (`onResync`). Una carga mal formada se descarta sin afectar al resto.
 */
export class PostgresAuctionRealtimeListener implements OnModuleInit, OnModuleDestroy {
  private client: Client | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private stopped = true
  private delayMs: number
  private hadConnection = false

  constructor(
    private readonly options: AuctionRealtimeListenerOptions,
    private readonly handlers: AuctionRealtimeListenerHandlers,
    private readonly logger: Logger,
  ) {
    this.delayMs = options.reconnectDelayMs ?? 1_000
  }

  async onModuleInit(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    await this.dispose()
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.options.connectionString })

    // Sin oyente de `error`, Node trata el evento como no controlado y termina el proceso.
    client.on('error', (error: Error) => {
      this.logger.warn('auction_realtime_listener_error', { detail: error.name })
      void this.lost(client)
    })
    client.on('end', () => {
      void this.lost(client)
    })
    client.on('notification', (message) => {
      if (message.channel !== AUCTION_REALTIME_CHANNEL || message.payload === undefined) return
      const signal = parseAuctionRealtimeNotice(message.payload)
      if (signal === null) {
        this.logger.warn('auction_realtime_notice_discarded', {})
        return
      }
      this.handlers.onSignal(signal)
    })

    try {
      await client.connect()
      await client.query(`LISTEN ${AUCTION_REALTIME_CHANNEL}`)
    } catch (error: unknown) {
      this.logger.warn('auction_realtime_listener_unavailable', {
        detail: error instanceof Error ? error.name : 'unknown',
      })
      await client.end().catch(() => undefined)
      this.scheduleRetry()
      return
    }

    this.client = client
    this.delayMs = this.options.reconnectDelayMs ?? 1_000
    if (this.hadConnection) this.handlers.onResync()
    this.hadConnection = true
    this.logger.info('auction_realtime_listener_ready', {})
  }

  private async lost(client: Client): Promise<void> {
    // Cada fallo puede notificarse dos veces (`error` y luego `end`); solo importa el primero.
    if (this.client !== client) return
    this.client = null
    await client.end().catch(() => undefined)
    if (!this.stopped) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return
    const delay = this.delayMs
    this.delayMs = Math.min(delay * 2, this.options.maxReconnectDelayMs ?? 30_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
    this.retryTimer.unref()
  }

  private async dispose(): Promise<void> {
    const client = this.client
    this.client = null
    await client?.end().catch(() => undefined)
  }
}
