import type { RealtimeTicketStorePort } from '../../../application/ports/RealtimeTicketPort'

interface StoredTicket {
  readonly subject: string
  readonly expiresAt: number
}

/**
 * Almacen de tickets del WebSocket EN MEMORIA (ADR-020, ADR-024). Un ticket vive 30 segundos y
 * Auction corre en una sola replica, asi que el ticket emitido por una peticion HTTP lo consume
 * el mismo proceso. Un reinicio invalida los tickets en vuelo y el cliente pide otro.
 *
 * Solo guarda el HASH. `consume` lo elimina SIEMPRE. Los caducados se purgan al emitir, para que
 * el mapa no crezca sin limite aunque nadie llegue a consumirlos.
 */
export class InMemoryRealtimeTicketStore implements RealtimeTicketStorePort {
  private readonly tickets = new Map<string, StoredTicket>()

  issue(ticketHash: string, subject: string, expiresAt: Date, now: Date): void {
    this.purge(now.getTime())
    this.tickets.set(ticketHash, { subject, expiresAt: expiresAt.getTime() })
  }

  consume(ticketHash: string, now: Date): string | null {
    const stored = this.tickets.get(ticketHash)

    this.tickets.delete(ticketHash)

    return stored !== undefined && stored.expiresAt > now.getTime() ? stored.subject : null
  }

  private purge(nowMs: number): void {
    for (const [hash, stored] of this.tickets) {
      if (stored.expiresAt <= nowMs) {
        this.tickets.delete(hash)
      }
    }
  }
}
