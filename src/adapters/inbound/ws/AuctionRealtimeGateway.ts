import { Inject, Optional } from '@nestjs/common'
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets'

import {
  AuctionRealtimeHub,
  type RealtimeSubscriber,
} from '../../../application/services/AuctionRealtimeHub'
import type { ConsumeRealtimeTicket } from '../../../application/use-cases/RealtimeTickets'
import type { Logger } from '../../../infrastructure/observability/logger'
import {
  AUCTION_REALTIME_HUB,
  CONSUME_REALTIME_TICKET,
  REALTIME_GATEWAY_LOGGER,
  REALTIME_GATEWAY_OPTIONS,
} from './realtime.tokens'

/** `readyState` de un socket abierto (RFC 6455). */
const SOCKET_OPEN = 1

/** Cierre por falta de autenticacion o ticket invalido (ADR-020). */
export const CLOSE_UNAUTHENTICATED = 4401
/** Cierre por un mensaje que no es JSON valido o de un tipo no permitido. */
export const CLOSE_BAD_MESSAGE = 4400
/** Cierre por exceder las conexiones simultaneas de un mismo usuario. */
export const CLOSE_TOO_MANY_CONNECTIONS = 4429

/** Segundos que ADR-020 concede para autenticarse tras conectar. */
export const AUTH_TIMEOUT_MS = 5_000
/** Latido del servidor (ADR-020): cada 25 segundos. */
export const HEARTBEAT_INTERVAL_MS = 25_000
/** Tamano maximo de un mensaje entrante (contrato): 1 KiB. */
export const MAX_MESSAGE_BYTES = 1024
/** Conexiones simultaneas por usuario (contrato). */
export const MAX_CONNECTIONS_PER_USER = 3

export interface AuctionRealtimeGatewayOptions {
  readonly authTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
}

/**
 * Lo minimo que el gateway necesita de un socket. `ws` lo cumple tal cual; las pruebas lo
 * sustituyen por un doble sin red.
 */
export interface RealtimeSocket {
  readonly readyState: number
  on(event: 'message', listener: (data: { toString(): string }) => void): void
  on(event: 'close' | 'pong', listener: () => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
  ping?(): void
  terminate?(): void
}

interface ConnectionState {
  subject: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeat: ReturnType<typeof setInterval> | null
  alive: boolean
  readonly subscriber: RealtimeSubscriber
}

/**
 * Gateway WebSocket de Subasta (EN-034, ADR-024, que extiende ADR-020): canal de SOLO LECTURA.
 * Difunde senales de invalidacion; no recibe comandos de negocio.
 *
 * Protocolo (docs/contracts/auction-realtime-v1.md):
 *  - Primer mensaje `{"type":"auth","ticket"}`. Sin ticket valido en 5 s, o con uno usado,
 *    caducado o desconocido, se cierra con `4401`. El JWT nunca viaja por el socket.
 *  - Despues solo `subscribe` y `unsubscribe`. Cualquier otro tipo cierra con `4400`.
 *  - Latido cada 25 s; una conexion que no responde con pong se cierra.
 *  - Mensajes de hasta 1 KiB (`maxPayload`); mayores cierran la conexion.
 *  - Hasta 3 conexiones por usuario (`4429`) y 20 suscripciones por conexion.
 *
 * El rol (Player o GameMaster) se comprueba al emitir el ticket por HTTP: el `sub` del ticket es
 * la unica identidad de la conexion.
 */
@WebSocketGateway({
  // Literal, no derivado de `AppConfig.globalPrefix`: la metadata del decorador es estatica.
  // Coincide con el valor por defecto de `GLOBAL_PREFIX` ('api') y con el contrato.
  path: '/api/v1/auctions/realtime',
  maxPayload: MAX_MESSAGE_BYTES,
})
export class AuctionRealtimeGateway
  implements OnGatewayConnection<RealtimeSocket>, OnGatewayDisconnect<RealtimeSocket>
{
  @WebSocketServer()
  server: unknown

  private readonly connections = new Map<RealtimeSocket, ConnectionState>()
  private readonly authTimeoutMs: number
  private readonly heartbeatIntervalMs: number

  constructor(
    @Inject(CONSUME_REALTIME_TICKET) private readonly consumeTicket: ConsumeRealtimeTicket,
    @Inject(AUCTION_REALTIME_HUB) private readonly hub: AuctionRealtimeHub,
    @Inject(REALTIME_GATEWAY_LOGGER) private readonly logger: Logger,
    @Optional()
    @Inject(REALTIME_GATEWAY_OPTIONS)
    options: AuctionRealtimeGatewayOptions = {},
  ) {
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  }

  handleConnection(client: RealtimeSocket): void {
    const state: ConnectionState = {
      subject: null,
      authTimer: null,
      heartbeat: null,
      alive: true,
      subscriber: {
        send: (message: string): void => {
          if (client.readyState === SOCKET_OPEN) client.send(message)
        },
      },
    }
    this.connections.set(client, state)

    state.authTimer = setTimeout(() => {
      if (state.subject === null) client.close(CLOSE_UNAUTHENTICATED, 'auth timeout')
    }, this.authTimeoutMs)
    state.authTimer.unref()

    // Latido: un cliente que no responde con pong se da por perdido y se cierra.
    state.heartbeat = setInterval(() => {
      if (!state.alive) {
        if (client.terminate === undefined) client.close()
        else client.terminate()
        return
      }
      state.alive = false
      client.ping?.()
    }, this.heartbeatIntervalMs)
    state.heartbeat.unref()

    client.on('pong', () => {
      state.alive = true
    })
    client.on('message', (data) => {
      this.onMessage(client, state, data.toString())
    })
    client.on('close', () => {
      this.release(client)
    })
  }

  handleDisconnect(client: RealtimeSocket): void {
    this.release(client)
  }

  /** Cierra todas las conexiones, p. ej. al apagar el servicio o desactivar la funcion. */
  closeAll(code = 1001, reason = 'going away'): void {
    for (const client of [...this.connections.keys()]) {
      client.close(code, reason)
    }
  }

  connectionCount(): number {
    return this.connections.size
  }

  private onMessage(client: RealtimeSocket, state: ConnectionState, raw: string): void {
    const message = this.parse(raw)
    if (message === null) {
      client.close(CLOSE_BAD_MESSAGE, 'invalid message')
      return
    }

    if (state.subject === null) {
      this.authenticate(client, state, message)
      return
    }

    switch (message.type) {
      case 'subscribe':
        this.subscribe(client, state, message.channel)
        return
      case 'unsubscribe':
        this.unsubscribe(client, state, message.channel)
        return
      default:
        // `auth` repetido o cualquier otro tipo: este canal no admite comandos.
        client.close(CLOSE_BAD_MESSAGE, 'message type not allowed')
    }
  }

  private authenticate(
    client: RealtimeSocket,
    state: ConnectionState,
    message: { readonly type: string; readonly [key: string]: unknown },
  ): void {
    const subject = message.type === 'auth' ? this.consumeTicket.execute(message.ticket) : null
    if (subject === null) {
      client.close(CLOSE_UNAUTHENTICATED, 'unauthenticated')
      return
    }

    if (this.connectionsOf(subject) >= MAX_CONNECTIONS_PER_USER) {
      client.close(CLOSE_TOO_MANY_CONNECTIONS, 'too many connections')
      return
    }

    state.subject = subject
    if (state.authTimer !== null) clearTimeout(state.authTimer)
    state.authTimer = null
    client.send(JSON.stringify({ type: 'authenticated' }))
  }

  private subscribe(client: RealtimeSocket, state: ConnectionState, channel: unknown): void {
    const result = this.hub.subscribe(state.subscriber, channel)
    if (result === 'INVALID_CHANNEL') {
      client.send(JSON.stringify({ type: 'error', code: 'INVALID_CHANNEL' }))
    } else if (result === 'LIMIT') {
      client.send(JSON.stringify({ type: 'error', code: 'SUBSCRIPTION_LIMIT' }))
    } else {
      // Tambien confirma `ALREADY_SUBSCRIBED`: suscribirse es idempotente.
      client.send(JSON.stringify({ type: 'subscribed', channel }))
    }
  }

  private unsubscribe(client: RealtimeSocket, state: ConnectionState, channel: unknown): void {
    this.hub.unsubscribe(state.subscriber, channel)
    client.send(JSON.stringify({ type: 'unsubscribed', channel }))
  }

  private connectionsOf(subject: string): number {
    let count = 0
    for (const state of this.connections.values()) {
      if (state.subject === subject) count += 1
    }
    return count
  }

  private release(client: RealtimeSocket): void {
    const state = this.connections.get(client)
    if (state === undefined) return

    if (state.authTimer !== null) clearTimeout(state.authTimer)
    if (state.heartbeat !== null) clearInterval(state.heartbeat)
    this.hub.disconnect(state.subscriber)
    this.connections.delete(client)
    this.logger.debug('auction_realtime_disconnected', { connections: this.connections.size })
  }

  private parse(raw: string): { readonly type: string; readonly [key: string]: unknown } | null {
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
      return typeof record.type === 'string' ? { ...record, type: record.type } : null
    } catch {
      return null
    }
  }
}
