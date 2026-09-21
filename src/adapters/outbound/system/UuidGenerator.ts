import { randomUUID } from 'node:crypto'

import type { IdentifierGeneratorPort } from '../../../application/ports/IdentifierGeneratorPort'

export class UuidGenerator implements IdentifierGeneratorPort {
  generate(): string {
    return randomUUID()
  }
}
