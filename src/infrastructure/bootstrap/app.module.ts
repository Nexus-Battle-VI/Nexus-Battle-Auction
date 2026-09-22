import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Kysely } from 'kysely'

import { AuctionController } from '../../adapters/inbound/http/auction.controller'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { InternalServiceGuard } from '../../adapters/inbound/http/auth/internal-service.guard'
import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'
import { CatalogProductPolicyClient } from '../../adapters/outbound/http/CatalogProductPolicyClient'
import {
  UnavailableCatalogProductPolicy,
  UnavailableProductInventory,
  UnavailablePublicationFee,
  UnavailableSellerSanctions,
} from '../../adapters/outbound/http/UnavailableAuctionDependencies'
import { InMemoryAuctionRepository } from '../../adapters/outbound/persistence/InMemoryAuctionRepository'
import { PostgresAuctionRepository } from '../../adapters/outbound/persistence/PostgresAuctionRepository'
import { InMemoryWatchlistRepository } from '../../adapters/outbound/persistence/InMemoryWatchlistRepository'
import { PostgresWatchlistRepository } from '../../adapters/outbound/persistence/PostgresWatchlistRepository'
import {
  WATCHLIST_REPOSITORY,
  type WatchlistRepositoryPort,
} from '../../application/ports/WatchlistRepositoryPort'
import type { Database } from '../../adapters/outbound/persistence/schema'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'
import {
  AUCTION_REPOSITORY,
  type AuctionRepositoryPort,
} from '../../application/ports/AuctionRepositoryPort'
import {
  CATALOG_PRODUCT_POLICY,
  type CatalogProductPolicyPort,
} from '../../application/ports/CatalogProductPolicyPort'
import { CLOCK, type ClockPort } from '../../application/ports/ClockPort'
import {
  IDENTIFIER_GENERATOR,
  type IdentifierGeneratorPort,
} from '../../application/ports/IdentifierGeneratorPort'
import {
  PRODUCT_INVENTORY,
  type ProductInventoryPort,
} from '../../application/ports/ProductInventoryPort'
import {
  PUBLICATION_FEE,
  type PublicationFeePort,
} from '../../application/ports/PublicationFeePort'
import {
  SELLER_SANCTIONS,
  type SellerSanctionPort,
} from '../../application/ports/SellerSanctionPort'
import { TOKEN_VERIFIER, type TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import { PersistAuctionPublication } from '../../application/use-cases/PersistAuctionPublication'
import { PublishAuction } from '../../application/use-cases/PublishAuction'
import { RegisterBid } from '../../application/use-cases/RegisterBid'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'
import { describeError } from '../observability/describe-error'
import { createLogger, type Logger } from '../observability/logger'
import { createDatabase, pingDatabase } from '../persistence/database'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
export const DATABASE = Symbol('Database')
export const DATABASE_LIFECYCLE = Symbol('DatabaseLifecycle')

/**
 * Servicios autorizados a llamar a las rutas `@InternalOnly()` de Auction.
 *
 * Es la lista de consumidores que ADR-019 declara. Anadir uno es una decision
 * de arquitectura, no un ajuste de configuracion: por eso vive en codigo, donde
 * cambiarla exige un Pull Request revisado.
 */
export const INTERNAL_CALLERS: readonly string[] = []

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran aqui con
 * fabricas explicitas, de modo que la capa de aplicacion permanece
 * independiente del framework.
 */
@Module({
  controllers: [HealthController, AuctionController],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.logLevel,
          service: config.serviceName,
          version: config.version,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: CLOCK,
      useFactory: (): ClockPort => new SystemClock(),
    },
    {
      provide: IDENTIFIER_GENERATOR,
      useFactory: (): IdentifierGeneratorPort => new UuidGenerator(),
    },
    {
      provide: DATABASE,
      useFactory: (config: AppConfig, logger: Logger): Kysely<Database> | null => {
        if (config.persistenceDriver !== PersistenceDriver.Postgres) {
          logger.warn('in_memory_persistence', {
            detail: 'PERSISTENCE_DRIVER=memory: el estado se pierde al reiniciar el servicio.',
          })

          return null
        }

        // `loadConfig` ya garantiza que DATABASE_URL existe con este driver.
        if (config.databaseUrl === null) {
          throw new Error('DATABASE_URL es obligatorio con PERSISTENCE_DRIVER=postgres.')
        }

        // El esquema NO se migra aqui: es un paso explicito, `npm run migrate`.
        return createDatabase({
          connectionString: config.databaseUrl,
          onIdleError: (error) => {
            logger.warn('postgres_idle_connection_error', { detail: describeError(error) })
          },
        })
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: DATABASE_LIFECYCLE,
      useFactory: (db: Kysely<Database> | null): { onModuleDestroy: () => Promise<void> } => ({
        onModuleDestroy: async (): Promise<void> => {
          await db?.destroy()
        },
      }),
      inject: [DATABASE],
    },
    {
      provide: AUCTION_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): AuctionRepositoryPort =>
        db === null ? new InMemoryAuctionRepository() : new PostgresAuctionRepository(db),
      inject: [DATABASE],
    },
    {
      provide: CATALOG_PRODUCT_POLICY,
      useFactory: (
        config: AppConfig,
        logger: Logger,
        clock: ClockPort,
      ): CatalogProductPolicyPort =>
        config.internalServiceAuthSecret === null
          ? new UnavailableCatalogProductPolicy()
          : new CatalogProductPolicyClient({
              baseUrl: config.catalogBaseUrl,
              secret: config.internalServiceAuthSecret,
              serviceName: 'auction',
              timeoutMs: 3_000,
              logger,
              now: () => clock.now(),
            }),
      inject: [APP_CONFIG, LOGGER, CLOCK],
    },
    {
      // TASK 68.1: ambos adaptadores mantienen unicidad e integridad local.
      provide: WATCHLIST_REPOSITORY,
      useFactory: (
        db: Kysely<Database> | null,
        auctions: AuctionRepositoryPort,
      ): WatchlistRepositoryPort =>
        db === null
          ? new InMemoryWatchlistRepository(auctions)
          : new PostgresWatchlistRepository(db),
      inject: [DATABASE, AUCTION_REPOSITORY],
    },
    {
      provide: PRODUCT_INVENTORY,
      useFactory: (): ProductInventoryPort => new UnavailableProductInventory(),
    },
    {
      provide: PUBLICATION_FEE,
      useFactory: (): PublicationFeePort => new UnavailablePublicationFee(),
    },
    {
      provide: SELLER_SANCTIONS,
      useFactory: (): SellerSanctionPort => new UnavailableSellerSanctions(),
    },
    {
      provide: PersistAuctionPublication,
      useFactory: (
        repository: AuctionRepositoryPort,
        inventory: ProductInventoryPort,
        fees: PublicationFeePort,
        clock: ClockPort,
      ): PersistAuctionPublication =>
        new PersistAuctionPublication(repository, inventory, fees, clock),
      inject: [AUCTION_REPOSITORY, PRODUCT_INVENTORY, PUBLICATION_FEE, CLOCK],
    },
    {
      provide: PublishAuction,
      useFactory: (
        repository: AuctionRepositoryPort,
        catalog: CatalogProductPolicyPort,
        inventory: ProductInventoryPort,
        sanctions: SellerSanctionPort,
        persistence: PersistAuctionPublication,
        clock: ClockPort,
        identifiers: IdentifierGeneratorPort,
      ): PublishAuction =>
        new PublishAuction(
          repository,
          catalog,
          inventory,
          sanctions,
          persistence,
          clock,
          identifiers,
        ),
      inject: [
        AUCTION_REPOSITORY,
        CATALOG_PRODUCT_POLICY,
        PRODUCT_INVENTORY,
        SELLER_SANCTIONS,
        PersistAuctionPublication,
        CLOCK,
        IDENTIFIER_GENERATOR,
      ],
    },
    {
      provide: RegisterBid,
      useFactory: (
        repository: AuctionRepositoryPort,
        persistence: PersistBidWithCredits,
        clock: ClockPort,
        identifiers: IdentifierGeneratorPort,
      ): RegisterBid => new RegisterBid(repository, persistence, clock, identifiers),
      inject: [AUCTION_REPOSITORY, PersistBidWithCredits, CLOCK, IDENTIFIER_GENERATOR],
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
          // No se devuelve un verificador que acepte cualquier cosa: con
          // AUTH_MODE=disabled el guard que lo usaria no se registra.
          logger.warn('authentication_disabled', {
            detail: 'AUTH_MODE=disabled: ninguna ruta verifica quien realiza la peticion.',
          })

          return {
            verify: (): Promise<never> =>
              Promise.reject(new Error('No hay verificador de testimonios configurado.')),
          }
        }

        return new CognitoTokenVerifier(config.cognito)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    // El orden importa: NestJS ejecuta los guards globales en el orden en que se
    // declaran. Primero la identidad, despues los roles, despues el contrato
    // interno, que solo actua sobre rutas `@InternalOnly()`.
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: TokenVerifierPort,
      ): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new JwtAuthGuard(reflector, verifier)
          : new AnonymousIdentityGuard(),
      inject: [APP_CONFIG, Reflector, TOKEN_VERIFIER],
    },
    {
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new RolesGuard(reflector)
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        clock: ClockPort,
        logger: Logger,
      ): CanActivate =>
        new InternalServiceGuard({
          reflector,
          secret: config.internalServiceAuthSecret,
          allowedServices: INTERNAL_CALLERS,
          clock,
          logger,
        }),
      inject: [APP_CONFIG, Reflector, CLOCK, LOGGER],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (db: Kysely<Database> | null): readonly ReadinessCheck[] =>
        // Con PostgreSQL la sonda va hasta el motor. En memoria no hay
        // dependencia externa que comprobar, y no se inventa una.
        db === null ? [] : [{ name: 'postgres', check: () => pingDatabase(db) }],
      inject: [DATABASE],
    },
    {
      provide: VERSION_REPORT,
      useFactory: (config: AppConfig): VersionReport => ({
        service: config.serviceName,
        version: config.version,
        nodeEnv: config.nodeEnv,
      }),
      inject: [APP_CONFIG],
    },
  ],
})
export class AppModule {}
