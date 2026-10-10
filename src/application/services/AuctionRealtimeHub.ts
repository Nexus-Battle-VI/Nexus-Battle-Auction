import type { AuctionRealtimeSignalV1 } from '../../domain/events/AuctionRealtimeSignalV1'

/** Lo unico que el hub necesita de una conexion: poder enviarle texto. */
export interface RealtimeSubscriber {
  send(message: string): void
}

/** Canal agregado de Marketplace. */
export const AUCTIONS_CHANNEL = 'auctions'

const AUCTION_CHANNEL = /^auctions\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/

/** Suscripciones por conexion (contrato, seccion 8). */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 20

export type SubscribeResult = 'SUBSCRIBED' | 'ALREADY_SUBSCRIBED' | 'INVALID_CHANNEL' | 'LIMIT'

/** `true` si el nombre es `auctions` o `auctions/{auctionId}` con un id bien formado. */
export const isValidChannel = (channel: unknown): channel is string =>
  typeof channel === 'string' && (channel === AUCTIONS_CHANNEL || AUCTION_CHANNEL.test(channel))

/**
 * Registro de suscripciones y reparto de senales. Vive en la memoria del proceso (ADR-024): no
 * conoce `ws` ni PostgreSQL, solo reparte texto a quien se haya suscrito.
 *
 * - `auctions/{id}` recibe la senal COMPLETA (con `summary`).
 * - `auctions` (Marketplace) recibe la senal SIN `summary`: invalida, no parchea.
 */
export class AuctionRealtimeHub {
  private readonly channels = new Map<string, Set<RealtimeSubscriber>>()
  private readonly byConnection = new Map<RealtimeSubscriber, Set<string>>()

  subscribe(connection: RealtimeSubscriber, channel: unknown): SubscribeResult {
    if (!isValidChannel(channel)) return 'INVALID_CHANNEL'

    const owned = this.byConnection.get(connection) ?? new Set<string>()
    if (owned.has(channel)) return 'ALREADY_SUBSCRIBED'
    if (owned.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'LIMIT'

    owned.add(channel)
    this.byConnection.set(connection, owned)

    const members = this.channels.get(channel) ?? new Set<RealtimeSubscriber>()
    members.add(connection)
    this.channels.set(channel, members)
    return 'SUBSCRIBED'
  }

  unsubscribe(connection: RealtimeSubscriber, channel: unknown): boolean {
    if (!isValidChannel(channel)) return false
    const removed = this.byConnection.get(connection)?.delete(channel) ?? false
    if (removed) this.dropMember(channel, connection)
    return removed
  }

  /** Quita todas las suscripciones de una conexion que se cerro. */
  disconnect(connection: RealtimeSubscriber): void {
    for (const channel of this.byConnection.get(connection) ?? []) {
      this.dropMember(channel, connection)
    }
    this.byConnection.delete(connection)
  }

  /** Reparte una senal. Un fallo al enviar a una conexion no afecta a las demas. */
  publish(signal: AuctionRealtimeSignalV1): void {
    const withoutSummary: AuctionRealtimeSignalV1 = { ...signal }
    delete (withoutSummary as { summary?: unknown }).summary
    const detailChannel = `auctions/${signal.auctionId}`

    this.deliver(detailChannel, { type: 'signal', channel: detailChannel, signal })
    this.deliver(AUCTIONS_CHANNEL, {
      type: 'signal',
      channel: AUCTIONS_CHANNEL,
      signal: withoutSummary,
    })
  }

  /**
   * Avisa a toda conexion con alguna suscripcion de que debe releer lo que observa. Se usa cuando
   * el oyente de PostgreSQL se reconecta: las senales emitidas mientras estuvo caido no se
   * recuperan, y el cliente las suple con un refetch.
   */
  resyncAll(): void {
    const message = JSON.stringify({ type: 'resync' })
    for (const connection of this.byConnection.keys()) {
      this.safeSend(connection, message)
    }
  }

  subscriptionCount(connection: RealtimeSubscriber): number {
    return this.byConnection.get(connection)?.size ?? 0
  }

  private deliver(channel: string, body: unknown): void {
    const members = this.channels.get(channel)
    if (members === undefined) return
    const message = JSON.stringify(body)
    for (const member of members) {
      this.safeSend(member, message)
    }
  }

  private safeSend(connection: RealtimeSubscriber, message: string): void {
    try {
      connection.send(message)
    } catch {
      // Una conexion rota no debe impedir el reparto al resto; su cierre la dara de baja.
    }
  }

  private dropMember(channel: string, connection: RealtimeSubscriber): void {
    const members = this.channels.get(channel)
    members?.delete(connection)
    if (members?.size === 0) this.channels.delete(channel)
  }
}
