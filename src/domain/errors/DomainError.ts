/**
 * Error de regla de negocio. No transporta detalles de infraestructura ni
 * codigos HTTP: la traduccion al protocolo ocurre en el adaptador de entrada.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}
