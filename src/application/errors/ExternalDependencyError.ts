export class ExternalDependencyUnavailableError extends Error {
  constructor(
    readonly dependency: string,
    message = `La dependencia ${dependency} no esta disponible.`,
  ) {
    super(message)
    this.name = 'ExternalDependencyUnavailableError'
  }
}

export class ExternalContractError extends Error {
  constructor(
    readonly dependency: string,
    message: string,
  ) {
    super(message)
    this.name = 'ExternalContractError'
  }
}

export class ExternalResourceNotFoundError extends Error {
  constructor(
    readonly dependency: string,
    readonly resourceId: string,
  ) {
    super(`${dependency} no encontro el recurso ${resourceId}.`)
    this.name = 'ExternalResourceNotFoundError'
  }
}
