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

import * as createAuctionBids from '../../adapters/outbound/persistence/migrations/002-create-auction-bids'
import * as createAuctionWatchlist from '../../adapters/outbound/persistence/migrations/003-create-auction-watchlist'
import * as createAuctionPublication from '../../adapters/outbound/persistence/migrations/001-create-auction-publication'
import * as addBidCreditReservation from '../../adapters/outbound/persistence/migrations/003-add-bid-credit-reservation'
import * as createBidCreditFailures from '../../adapters/outbound/persistence/migrations/004-create-bid-credit-failures'
import * as createBidCreditOperations from '../../adapters/outbound/persistence/migrations/005-create-bid-credit-operations'
import * as createAuctionAutoBids from '../../adapters/outbound/persistence/migrations/006-create-auction-auto-bids'
import * as createAuctionSettlements from '../../adapters/outbound/persistence/migrations/007-create-auction-settlements'
import * as createAuctionPendingClaims from '../../adapters/outbound/persistence/migrations/008-create-auction-pending-claims'
import * as createAuctionPublicationIntents from '../../adapters/outbound/persistence/migrations/009-create-auction-publication-intents'
import * as createAuctionInventorySettlementIntents from '../../adapters/outbound/persistence/migrations/010-create-auction-inventory-settlement-intents'
import * as createAuctionSettlementWork from '../../adapters/outbound/persistence/migrations/011-create-auction-settlement-work'
import * as allowExpiredAuctionPendingClaims from '../../adapters/outbound/persistence/migrations/012-allow-expired-auction-pending-claims'
import * as createAuctionBuyNow from '../../adapters/outbound/persistence/migrations/013-create-auction-buy-now'
import * as addBuyNowRemainingCredits from '../../adapters/outbound/persistence/migrations/014-add-buy-now-remaining-credits'
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
  /**
   * Recibe los errores de las conexiones OCIOSAS del pool.
   *
   * Una conexion que espera en el pool sigue unida a un proceso del motor. Si
   * el motor se reinicia o la red se corta, esa conexion emite `error` en el
   * pool, y sin ningun oyente Node trata el evento como no controlado y
   * TERMINA EL PROCESO. El servicio entero caeria por un reinicio de la base,
   * en lugar de responder 503 en la readiness y recuperarse solo.
   *
   * Se descubrio con la prueba de control de la CI: al parar PostgreSQL, el
   * contenedor dejaba de responder en vez de devolver 503.
   */
  readonly onIdleError?: (error: Error) => void
}

export const createDatabase = (options: DatabaseOptions): Kysely<Database> => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
    idleTimeoutMillis: 30_000,
    // Sin este limite, un motor caido deja las peticiones colgadas hasta el
    // tiempo de espera de la peticion HTTP, que es mucho mas largo.
    connectionTimeoutMillis: 5_000,
  })

  // El oyente se registra SIEMPRE, aunque nadie pase `onIdleError`: su mera
  // presencia es lo que impide que el proceso termine. El pool ya descarta la
  // conexion rota y abre otra en la siguiente consulta.
  pool.on('error', (error: Error) => {
    options.onIdleError?.(error)
  })

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 *
 * `FileMigrationProvider` leeria el directorio en tiempo de ejecucion, y en la
 * imagen de produccion ese directorio contiene JavaScript compilado con otra
 * ruta. Importarlas explicitamente hace que el compilador las verifique y que
 * el empaquetado no pueda dejarse ninguna fuera en silencio.
 *
 * Cada Historia de Usuario anade aqui su migracion, con prefijo numerico que
 * fija el orden.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '001-create-auction-publication': createAuctionPublication,
  '002-create-auction-bids': createAuctionBids,
  // TASK 68.1: se aplica despues de la tabla auctions referenciada por la watchlist.
  '003-create-auction-watchlist': createAuctionWatchlist,
  // Conserva las migraciones de pujas al integrar la persistencia de watchlist.
  '003-add-bid-credit-reservation': addBidCreditReservation,
  '004-create-bid-credit-failures': createBidCreditFailures,
  '005-create-bid-credit-operations': createBidCreditOperations,
  '006-create-auction-auto-bids': createAuctionAutoBids,
  '007-create-auction-settlements': createAuctionSettlements,
  '008-create-auction-pending-claims': createAuctionPendingClaims,
  '009-create-auction-publication-intents': createAuctionPublicationIntents,
  '010-create-auction-inventory-settlement-intents': createAuctionInventorySettlementIntents,
  '011-create-auction-settlement-work': createAuctionSettlementWork,
  '012-allow-expired-auction-pending-claims': allowExpiredAuctionPendingClaims,
  '013-create-auction-buy-now': createAuctionBuyNow,
  '014-add-buy-now-remaining-credits': addBuyNowRemainingCredits,
}

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

  const migrator = new Migrator({
    db,
    provider,
  })

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
