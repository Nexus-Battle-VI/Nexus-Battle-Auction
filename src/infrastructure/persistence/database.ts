import {
  Kysely,
  Migrator,
  PostgresDialect,
  sql,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely'
import { Pool } from 'pg'

import type { Database } from '../../adapters/outbound/persistence/schema'

export interface DatabaseOptions {
  readonly connectionString: string
  /**
   * Conexiones simultaneas del pool.
   *
   * Deliberadamente bajo. Todos los servicios comparten el mismo motor en el
   * nodo de datos (ADR-011): si cada uno abriera un pool generoso, PostgreSQL
   * agotaria `max_connections` antes de que ningun servicio notara presion.
   */
  readonly maxConnections?: number
}

export const createDatabase = (options: DatabaseOptions): Kysely<Database> =>
  new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: options.connectionString,
        max: options.maxConnections ?? 5,
        // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
        idleTimeoutMillis: 30_000,
        // Sin este limite, un motor caido deja las peticiones colgadas hasta el
        // tiempo de espera de la peticion HTTP, que es mucho mas largo.
        connectionTimeoutMillis: 5_000,
      }),
    }),
  })

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 *
 * `FileMigrationProvider` leeria el directorio en tiempo de ejecucion, y en la
 * imagen de produccion ese directorio contiene JavaScript compilado con otra
 * ruta. Importarlas explicitamente hace que el compilador las verifique y que
 * el empaquetado no pueda dejarse ninguna fuera en silencio.
 *
 * Esta vacio a proposito: el andamiaje no inventa tablas. Cada Historia de
 * Usuario anade aqui su migracion, con prefijo numerico que fija el orden.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {}

export interface MigrationOutcome {
  readonly applied: readonly string[]
  readonly error: unknown
}

/**
 * Lleva el esquema al ultimo estado conocido.
 *
 * No se ejecuta al arrancar el servicio: migrar desde el arranque significa que
 * varias replicas migran a la vez, y que un despliegue con una migracion rota
 * deja el servicio en bucle de reinicio. Se invoca desde `npm run migrate`,
 * como paso explicito del despliegue.
 *
 * Las migraciones se reciben como parametro para que la prueba contra motor
 * real pueda ejercitar el camino de fallo sin anadir una migracion rota al
 * producto.
 */
export const migrateToLatest = async (
  db: Kysely<Database>,
  migrations: Readonly<Record<string, Migration>> = MIGRATIONS,
): Promise<MigrationOutcome> => {
  const provider: MigrationProvider = {
    getMigrations: () => Promise.resolve({ ...migrations }),
  }
  const migrator = new Migrator({ db, provider })
  const { error, results } = await migrator.migrateToLatest()

  return {
    applied: (results ?? [])
      .filter((result: MigrationResult) => result.status === 'Success')
      .map((result: MigrationResult) => result.migrationName),
    error,
  }
}

/**
 * Comprobacion de readiness contra el motor. Devuelve `false` en lugar de
 * lanzar: quien la consume es la sonda, y para ella un motor inalcanzable es un
 * resultado, no una excepcion.
 */
export const pingDatabase = async (db: Kysely<Database>): Promise<boolean> => {
  try {
    await sql`select 1`.execute(db)

    return true
  } catch {
    return false
  }
}
