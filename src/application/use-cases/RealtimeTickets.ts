import type { ClockPort } from '../ports/ClockPort'
import type { RealtimeTicketCodecPort, RealtimeTicketStorePort } from '../ports/RealtimeTicketPort'

/** Caducidad del ticket (ADR-020): 30 segundos. */
export const TICKET_TTL_SECONDS = 30

export interface IssuedRealtimeTicket {
  readonly ticket: string
  readonly expiresInSeconds: number
}

/**
 * Emite un ticket de un solo uso para abrir el WebSocket. El `sub` es el del testimonio YA
 * verificado por el guard HTTP: nadie puede pedir un ticket para otro jugador. Solo se retiene
 * el hash.
 */
export class IssueRealtimeTicket {
  constructor(
    private readonly codec: RealtimeTicketCodecPort,
    private readonly store: RealtimeTicketStorePort,
    private readonly clock: ClockPort,
  ) {}

  execute(subject: string): IssuedRealtimeTicket {
    const ticket = this.codec.generate()
    const now = this.clock.now()
    const expiresAt = new Date(now.getTime() + TICKET_TTL_SECONDS * 1000)

    this.store.issue(this.codec.hash(ticket), subject, expiresAt, now)

    return { ticket, expiresInSeconds: TICKET_TTL_SECONDS }
  }
}

/**
 * Consume el ticket presentado en el primer mensaje del socket. Devuelve el `sub` al que estaba
 * ligado, o `null` si es desconocido, ya usado o caducado (el gateway cierra con 4401 sin
 * distinguir el motivo).
 */
export class ConsumeRealtimeTicket {
  constructor(
    private readonly codec: RealtimeTicketCodecPort,
    private readonly store: RealtimeTicketStorePort,
    private readonly clock: ClockPort,
  ) {}

  execute(ticket: unknown): string | null {
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 256) {
      return null
    }

    return this.store.consume(this.codec.hash(ticket), this.clock.now())
  }
}
