import { createHash, randomBytes } from 'node:crypto'

import type { RealtimeTicketCodecPort } from '../../../application/ports/RealtimeTicketPort'

/** Genera un secreto de autenticacion opaco e impredecible (256 bits) y su SHA-256. */
export class CryptoRealtimeTicketCodec implements RealtimeTicketCodecPort {
  generate(): string {
    return randomBytes(32).toString('base64url')
  }

  hash(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex')
  }
}
