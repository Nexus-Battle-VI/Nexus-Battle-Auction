import { loadConfig } from '../config/env'
import { createLogger } from '../observability/logger'
import { describeError } from '../observability/describe-error'
import { createDatabase, migrateToLatest } from './database'

/**
 * Punto de entrada de `npm run migrate`.
 *
 * Es un paso explicito del despliegue y no algo que ocurra al arrancar el
 * servicio: migrar desde el arranque hace que varias replicas migren a la vez, y
 * que un despliegue con una migracion rota deje el servicio en bucle de
 * reinicio en lugar de fallar una sola vez, de forma visible.
 */
const main = async (): Promise<void> => {
  const config = loadConfig(process.env)
  const logger = createLogger({
    level: config.logLevel,
    service: config.serviceName,
    version: config.version,
  })

  if (config.databaseUrl === null) {
    throw new Error('DATABASE_URL es obligatorio para ejecutar las migraciones.')
  }

  const db = createDatabase({ connectionString: config.databaseUrl })

  try {
    const { applied, error } = await migrateToLatest(db)

    for (const name of applied) {
      logger.info('migration_applied', { migration: name })
    }

    if (error !== undefined) {
      throw new Error(`La migracion fallo: ${describeError(error)}`)
    }

    logger.info('migrations_up_to_date', { applied: applied.length })
  } finally {
    // Sin esto el proceso no termina: el pool mantiene el bucle de eventos vivo.
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  // El registro ya no esta disponible si la configuracion fue lo que fallo, asi
  // que este es el unico sitio donde escribir directamente esta justificado.
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
