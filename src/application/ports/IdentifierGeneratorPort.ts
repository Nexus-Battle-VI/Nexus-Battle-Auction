export interface IdentifierGeneratorPort {
  generate(): string
}

export const IDENTIFIER_GENERATOR = Symbol('IdentifierGeneratorPort')
