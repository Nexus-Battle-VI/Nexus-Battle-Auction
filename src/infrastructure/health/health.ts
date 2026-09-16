export type CheckOutcome = 'ok' | 'error'

export interface HealthReport {
  readonly status: CheckOutcome
  readonly checks: Readonly<Record<string, CheckOutcome>>
}

export interface ReadinessCheck {
  readonly name: string
  /**
   * Puede ser asincrona: comprobar una base de datos exige ir hasta ella. Una
   * sonda que solo mira si existe el objeto que la representa no dice nada
   * sobre si el motor responde.
   */
  check: () => boolean | Promise<boolean>
}

export interface VersionReport {
  readonly service: string
  readonly version: string
  readonly nodeEnv: string
}

/**
 * Liveness: el proceso responde. No consulta dependencias, porque reiniciar el
 * servicio no repara una dependencia caida.
 */
export const buildLiveness = (): HealthReport => ({ status: 'ok', checks: {} })

/**
 * Readiness: evalua las dependencias reales. Una comprobacion que lanza o
 * rechaza cuenta como fallo, nunca como exito: una readiness falsa es peor que
 * no tenerla.
 */
export const buildReadiness = async (checks: readonly ReadinessCheck[]): Promise<HealthReport> => {
  const results: Record<string, CheckOutcome> = {}

  await Promise.all(
    checks.map(async (item) => {
      let outcome: CheckOutcome

      try {
        outcome = (await item.check()) ? 'ok' : 'error'
      } catch {
        outcome = 'error'
      }

      results[item.name] = outcome
    }),
  )

  const healthy = Object.values(results).every((outcome) => outcome === 'ok')

  return { status: healthy ? 'ok' : 'error', checks: results }
}

export const buildVersion = (params: VersionReport): VersionReport => ({
  service: params.service,
  version: params.version,
  nodeEnv: params.nodeEnv,
})
