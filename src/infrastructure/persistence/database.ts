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

import * as createAuctionPublication from '../../adapters/outbound/persistence/migrations/001-create-auction-publication'
import * as createAuctionBids from '../../adapters/outbound/persistence/migrations/002-create-auction-bids'
import * as addBidCreditReservation from '../../adapters/outbound/persistence/migrations/003-add-bid-credit-reservation'
import * as createBidCreditFailures from '../../adapters/outbound/persistence/migrations/004-create-bid-credit-failures'
import * as createBidCreditOperations from '../../adapters/outbound/persistence/migrations/005-create-bid-credit-operations'
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
   * TERMINA EL PROCESO.
   */
  readonly onIdleError?: (error: Error) => void
}

export const createDatabase = (options: DatabaseOptions): Kysely<Database> => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  pool.on('error', (error: Error) => {
    options.onIdleError?.(error)
  })

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  })
}

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '001-create-auction-publication': createAuctionPublication,

  '002-create-auction-bids': createAuctionBids,

  '003-add-bid-credit-reservation': addBidCreditReservation,

  '004-create-bid-credit-failures': createBidCreditFailures,

  '005-create-bid-credit-operations': createBidCreditOperations,
}

export interface MigrationOutcome {
  readonly applied: readonly string[]
  readonly error: unknown
}

/**
 * Lleva el esquema al ultimo estado conocido.
 */
export const migrateToLatest = async (
  db: Kysely<Database>,
  migrations: Readonly<Record<string, Migration>> = MIGRATIONS,
): Promise<MigrationOutcome> => {
  const provider: MigrationProvider = {
    getMigrations: () =>
      Promise.resolve({
        ...migrations,
      }),
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
 * Comprobacion de readiness contra el motor.
 */
export const pingDatabase = async (db: Kysely<Database>): Promise<boolean> => {
  try {
    await sql`
      select 1
    `.execute(db)

    return true
  } catch {
    return false
  }
}
