import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely, type Migration } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  createDatabase,
  migrateToLatest,
  pingDatabase,
} from '../../src/infrastructure/persistence/database'

/**
 * Infraestructura de persistencia contra un PostgreSQL REAL.
 *
 * Lo que se comprueba no se puede comprobar con un doble: que el pool conecta,
 * que el migrador registra lo aplicado y que una migracion rota se informa en
 * lugar de darse por buena.
 */
describe('Persistencia PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('la sonda responde contra un motor disponible', async () => {
    await expect(pingDatabase(db)).resolves.toBe(true)
  })

  it('aplica las migraciones del producto sin error', async () => {
    const outcome = await migrateToLatest(db)

    expect(outcome.error).toBeUndefined()
  })

  it('registra las migraciones aplicadas y no las repite', async () => {
    const migrations: Record<string, Migration> = {
      '900-prueba': {
        up: async (conexion: Kysely<unknown>) => {
          await conexion.schema.createTable('prueba').addColumn('id', 'text').execute()
        },
      },
    }

    expect((await migrateToLatest(db, migrations)).applied).toEqual(['900-prueba'])
    expect((await migrateToLatest(db, migrations)).applied).toEqual([])

    const { rows } = await sql<{ existe: boolean }>`
      select to_regclass('public.prueba') is not null as existe
    `.execute(db)
    expect(rows[0]?.existe).toBe(true)
  })

  it('informa una migracion rota en lugar de darla por aplicada', async () => {
    const outcome = await migrateToLatest(db, {
      '900-prueba': { up: () => Promise.resolve() },
      '901-rota': { up: () => Promise.reject(new Error('sql invalido')) },
    })

    expect(outcome.applied).toEqual([])
    expect(outcome.error).toBeInstanceOf(Error)
  })

  /**
   * Reproduce lo que tumbaba el servicio: el motor corta una conexion que
   * espera ociosa en el pool. Sin oyente de `error`, Jest veria el proceso
   * terminar; con el, el error llega a `onIdleError` y la siguiente consulta
   * abre una conexion nueva.
   */
  it('sobrevive a que el motor corte una conexion ociosa del pool', async () => {
    const errores: Error[] = []
    const aplicacion = 'prueba-conexion-ociosa'
    const propia = createDatabase({
      connectionString: `${container.getConnectionUri()}?application_name=${aplicacion}`,
      onIdleError: (error) => errores.push(error),
    })

    try {
      await expect(pingDatabase(propia)).resolves.toBe(true)

      await sql`
        select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${aplicacion} and state = 'idle'
      `.execute(db)

      for (let intento = 0; intento < 50 && errores.length === 0; intento += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(errores.length).toBeGreaterThan(0)
      await expect(pingDatabase(propia)).resolves.toBe(true)
    } finally {
      await propia.destroy()
    }
  })

  /**
   * El control de la primera prueba: con el motor inalcanzable la sonda dice
   * `false`. Sin este caso, una sonda que devolviera siempre `true` pasaria.
   */
  it('la sonda falla contra un motor inalcanzable', async () => {
    const inalcanzable = createDatabase({
      connectionString: 'postgres://nadie:nada@127.0.0.1:1/ninguna',
    })

    try {
      await expect(pingDatabase(inalcanzable)).resolves.toBe(false)
    } finally {
      await inalcanzable.destroy()
    }
  })
})
