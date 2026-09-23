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
import { HttpAuctionInventoryClient } from '../../adapters/outbound/http/HttpAuctionInventoryClient'
import { HttpOutbidNotificationClient } from '../../adapters/outbound/http/HttpOutbidNotificationClient'
import { HttpAuctionWalletClient } from '../../adapters/outbound/http/HttpAuctionWalletClient'
import { UnavailableAuctionWalletClient } from '../../adapters/outbound/http/UnavailableAuctionWalletClient'
import {
  UnavailableBidCredits,
  UnavailableCatalogProductPolicy,
  UnavailableProductInventory,
  UnavailablePublicationFee,
  UnavailableSellerSanctions,
} from '../../adapters/outbound/http/UnavailableAuctionDependencies'
import { UnavailableOutbidNotification } from '../../adapters/outbound/http/UnavailableOutbidNotification'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import { InMemoryWatchlistRepository } from '../../adapters/outbound/persistence/InMemoryWatchlistRepository'
import { PostgresWatchlistRepository } from '../../adapters/outbound/persistence/PostgresWatchlistRepository'
import {
  WATCHLIST_REPOSITORY,
  type WatchlistRepositoryPort,
} from '../../application/ports/WatchlistRepositoryPort'
import { InMemoryAuctionRepository } from '../../adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryAuctionPublicationIntentRepository } from '../../adapters/outbound/persistence/InMemoryAuctionPublicationIntentRepository'
import { InMemoryAuctionInventorySettlementIntentRepository } from '../../adapters/outbound/persistence/InMemoryAuctionInventorySettlementIntentRepository'
import { InMemoryAuctionPendingClaimRepository } from '../../adapters/outbound/persistence/InMemoryAuctionPendingClaimRepository'
import { InMemoryAuctionSettlementRepository } from '../../adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { InMemoryAuctionSettlementWorkRepository } from '../../adapters/outbound/persistence/InMemoryAuctionSettlementWorkRepository'
import { InMemoryBidCreditOperationReader } from '../../adapters/outbound/persistence/InMemoryBidCreditOperationReader'
import { PostgresAuctionRepository } from '../../adapters/outbound/persistence/PostgresAuctionRepository'
import { PostgresAuctionPublicationIntentRepository } from '../../adapters/outbound/persistence/PostgresAuctionPublicationIntentRepository'
import { PostgresAuctionInventorySettlementIntentRepository } from '../../adapters/outbound/persistence/PostgresAuctionInventorySettlementIntentRepository'
import { PostgresAuctionPendingClaimRepository } from '../../adapters/outbound/persistence/PostgresAuctionPendingClaimRepository'
import { PostgresAuctionSettlementRepository } from '../../adapters/outbound/persistence/PostgresAuctionSettlementRepository'
import { PostgresAuctionSettlementWorkRepository } from '../../adapters/outbound/persistence/PostgresAuctionSettlementWorkRepository'
import { PostgresBidCreditOperationReader } from '../../adapters/outbound/persistence/PostgresBidCreditOperationReader'
import type { Database } from '../../adapters/outbound/persistence/schema'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'
import {
  AUCTION_REPOSITORY,
  type AuctionRepositoryPort,
} from '../../application/ports/AuctionRepositoryPort'
import { BID_CREDITS, type BidCreditsPort } from '../../application/ports/BidCreditsPort'
import {
  BID_CREDIT_OPERATION_READER,
  type BidCreditOperationReaderPort,
} from '../../application/ports/BidCreditOperationReaderPort'
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
  OUTBID_NOTIFICATION,
  type OutbidNotificationPort,
} from '../../application/ports/OutbidNotificationPort'
import { AUCTION_WALLET, type AuctionWalletPort } from '../../application/ports/AuctionWalletPort'
import {
  AUCTION_PUBLICATION_INTENT_REPOSITORY,
  type AuctionPublicationIntentRepositoryPort,
} from '../../application/ports/AuctionPublicationIntentRepositoryPort'
import {
  AUCTION_INVENTORY_SETTLEMENT_INTENT_REPOSITORY,
  type AuctionInventorySettlementIntentRepositoryPort,
} from '../../application/ports/AuctionInventorySettlementIntentRepositoryPort'
import {
  AUCTION_PENDING_CLAIM_REPOSITORY,
  type AuctionPendingClaimRepositoryPort,
} from '../../application/ports/AuctionPendingClaimRepositoryPort'
import {
  AUCTION_SETTLEMENT_REPOSITORY,
  type AuctionSettlementRepositoryPort,
} from '../../application/ports/AuctionSettlementRepositoryPort'
import {
  AUCTION_SETTLEMENT_WORK_REPOSITORY,
  type AuctionSettlementCandidateReaderPort,
  type AuctionSettlementWorkRepositoryPort,
} from '../../application/ports/AuctionSettlementWorkRepositoryPort'
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
import { ClaimPendingProduct } from '../../application/use-cases/ClaimPendingProduct'
import { ClaimPendingProductsBatch } from '../../application/use-cases/ClaimPendingProductsBatch'
import { GetAuctionDetail } from '../../application/use-cases/GetAuctionDetail'
import { GetPendingClaims } from '../../application/use-cases/GetPendingClaims'
import { PersistAuctionPublication } from '../../application/use-cases/PersistAuctionPublication'
import { PersistBidWithCredits } from '../../application/use-cases/PersistBidWithCredits'
import { ConfigureAutoBid } from '../../application/use-cases/ConfigureAutoBid'
import { ClassifyAuctionLoserCredits } from '../../application/use-cases/ClassifyAuctionLoserCredits'
import { PrepareAuctionLoserReleaseTasks } from '../../application/use-cases/PrepareAuctionLoserReleaseTasks'
import { ProcessExpiredAuctions } from '../../application/use-cases/ProcessExpiredAuctions'
import { PublishAuction } from '../../application/use-cases/PublishAuction'
import { ReactToRivalBid } from '../../application/use-cases/ReactToRivalBid'
import { RegisterBid } from '../../application/use-cases/RegisterBid'
import { SettleAuction } from '../../application/use-cases/SettleAuction'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'
import { describeError } from '../observability/describe-error'
import { createLogger, type Logger } from '../observability/logger'
import { createDatabase, pingDatabase } from '../persistence/database'
import { AuctionSettlementScheduler } from '../scheduling/AuctionSettlementScheduler'
import {
  NodeSchedulerTimer,
  SCHEDULER_TIMER,
  type SchedulerTimerPort,
} from '../scheduling/SchedulerTimer'

export const APP_CONFIG = Symbol('AppConfig')

export const LOGGER = Symbol('Logger')

export const DATABASE = Symbol('Database')

export const DATABASE_LIFECYCLE = Symbol('DatabaseLifecycle')

export const INTERNAL_CALLERS: readonly string[] = []

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

        if (config.databaseUrl === null) {
          throw new Error('DATABASE_URL es obligatorio con PERSISTENCE_DRIVER=postgres.')
        }

        return createDatabase({
          connectionString: config.databaseUrl,

          onIdleError: (error) => {
            logger.warn('postgres_idle_connection_error', {
              detail: describeError(error),
            })
          },
        })
      },

      inject: [APP_CONFIG, LOGGER],
    },

    {
      provide: DATABASE_LIFECYCLE,

      useFactory: (
        db: Kysely<Database> | null,
      ): {
        onModuleDestroy: () => Promise<void>
      } => ({
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
      provide: AUCTION_PUBLICATION_INTENT_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): AuctionPublicationIntentRepositoryPort =>
        db === null
          ? new InMemoryAuctionPublicationIntentRepository()
          : new PostgresAuctionPublicationIntentRepository(db),
      inject: [DATABASE],
    },

    {
      provide: AUCTION_INVENTORY_SETTLEMENT_INTENT_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): AuctionInventorySettlementIntentRepositoryPort =>
        db === null
          ? new InMemoryAuctionInventorySettlementIntentRepository()
          : new PostgresAuctionInventorySettlementIntentRepository(db),
      inject: [DATABASE],
    },

    {
      provide: AUCTION_PENDING_CLAIM_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): AuctionPendingClaimRepositoryPort =>
        db === null
          ? new InMemoryAuctionPendingClaimRepository()
          : new PostgresAuctionPendingClaimRepository(db),
      inject: [DATABASE],
    },

    {
      provide: AUCTION_SETTLEMENT_REPOSITORY,
      useFactory: (db: Kysely<Database> | null): AuctionSettlementRepositoryPort =>
        db === null
          ? new InMemoryAuctionSettlementRepository()
          : new PostgresAuctionSettlementRepository(db),
      inject: [DATABASE],
    },

    {
      provide: AUCTION_SETTLEMENT_WORK_REPOSITORY,
      useFactory: (
        db: Kysely<Database> | null,
        auctions: AuctionRepositoryPort & AuctionSettlementCandidateReaderPort,
        settlements: AuctionSettlementRepositoryPort,
      ): AuctionSettlementWorkRepositoryPort =>
        db === null
          ? new InMemoryAuctionSettlementWorkRepository(auctions, settlements)
          : new PostgresAuctionSettlementWorkRepository(db),
      inject: [DATABASE, AUCTION_REPOSITORY, AUCTION_SETTLEMENT_REPOSITORY],
    },

    {
      provide: BID_CREDIT_OPERATION_READER,
      useFactory: (db: Kysely<Database> | null): BidCreditOperationReaderPort =>
        db === null
          ? new InMemoryBidCreditOperationReader()
          : new PostgresBidCreditOperationReader(db),
      inject: [DATABASE],
    },

    {
      provide: ClassifyAuctionLoserCredits,
      useFactory: (reader: BidCreditOperationReaderPort): ClassifyAuctionLoserCredits =>
        new ClassifyAuctionLoserCredits(reader),
      inject: [BID_CREDIT_OPERATION_READER],
    },

    {
      provide: PrepareAuctionLoserReleaseTasks,
      useFactory: (settlements: AuctionSettlementRepositoryPort): PrepareAuctionLoserReleaseTasks =>
        new PrepareAuctionLoserReleaseTasks(settlements),
      inject: [AUCTION_SETTLEMENT_REPOSITORY],
    },

    {
      // TASK 68.1: selecciona persistencia duradera con el mismo motor que las subastas.
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
      provide: PRODUCT_INVENTORY,
      useFactory: (config: AppConfig, clock: ClockPort): ProductInventoryPort => {
        if (config.inventoryBaseUrl === null || config.internalServiceAuthSecret === null) {
          return new UnavailableProductInventory()
        }
        return new HttpAuctionInventoryClient({
          baseUrl: config.inventoryBaseUrl,
          secret: config.internalServiceAuthSecret,
          timeoutMs: config.inventoryRequestTimeoutMs,
          now: () => clock.now(),
        })
      },
      inject: [APP_CONFIG, CLOCK],
    },

    {
      provide: PUBLICATION_FEE,

      useFactory: (): PublicationFeePort => new UnavailablePublicationFee(),
    },

    {
      provide: BID_CREDITS,

      useFactory: (): BidCreditsPort => new UnavailableBidCredits(),
    },

    /**
     * HU-63.5.
     *
     * Con URL + secreto configurados se utiliza la integracion
     * HTTP real con Notifications.
     *
     * Sin configuracion se conserva el adaptador no disponible
     * para desarrollo local.
     */
    {
      provide: OUTBID_NOTIFICATION,

      useFactory: (config: AppConfig, logger: Logger, clock: ClockPort): OutbidNotificationPort => {
        if (config.notificationsBaseUrl === null || config.internalServiceAuthSecret === null) {
          return new UnavailableOutbidNotification()
        }

        return new HttpOutbidNotificationClient({
          baseUrl: config.notificationsBaseUrl,

          secret: config.internalServiceAuthSecret,

          serviceName: 'auction',

          timeoutMs: config.notificationsTimeoutMs,

          logger,

          now: () => clock.now(),
        })
      },

      inject: [APP_CONFIG, LOGGER, CLOCK],
    },

    {
      provide: AUCTION_WALLET,
      useFactory: (config: AppConfig, clock: ClockPort): AuctionWalletPort => {
        if (config.walletBaseUrl === null || config.internalServiceAuthSecret === null) {
          return new UnavailableAuctionWalletClient()
        }
        return new HttpAuctionWalletClient({
          baseUrl: config.walletBaseUrl,
          secret: config.internalServiceAuthSecret,
          timeoutMs: config.walletRequestTimeoutMs,
          now: () => clock.now(),
        })
      },
      inject: [APP_CONFIG, CLOCK],
    },

    {
      provide: SettleAuction,
      useFactory: (
        auctions: AuctionRepositoryPort,
        settlements: AuctionSettlementRepositoryPort,
        clock: ClockPort,
        wallet: AuctionWalletPort,
        classifyLoserCredits: ClassifyAuctionLoserCredits,
        prepareLoserReleaseTasks: PrepareAuctionLoserReleaseTasks,
        inventory: ProductInventoryPort,
        inventoryIntents: AuctionInventorySettlementIntentRepositoryPort,
        pendingClaims: AuctionPendingClaimRepositoryPort,
      ): SettleAuction =>
        new SettleAuction(
          auctions,
          settlements,
          clock,
          wallet,
          classifyLoserCredits,
          prepareLoserReleaseTasks,
          inventory,
          inventoryIntents,
          pendingClaims,
        ),
      inject: [
        AUCTION_REPOSITORY,
        AUCTION_SETTLEMENT_REPOSITORY,
        CLOCK,
        AUCTION_WALLET,
        ClassifyAuctionLoserCredits,
        PrepareAuctionLoserReleaseTasks,
        PRODUCT_INVENTORY,
        AUCTION_INVENTORY_SETTLEMENT_INTENT_REPOSITORY,
        AUCTION_PENDING_CLAIM_REPOSITORY,
      ],
    },

    {
      provide: ProcessExpiredAuctions,
      useFactory: (
        work: AuctionSettlementWorkRepositoryPort,
        settleAuction: SettleAuction,
        inventoryIntents: AuctionInventorySettlementIntentRepositoryPort,
        clock: ClockPort,
        logger: Logger,
        identifiers: IdentifierGeneratorPort,
        config: AppConfig,
      ): ProcessExpiredAuctions =>
        new ProcessExpiredAuctions(work, settleAuction, inventoryIntents, clock, logger, {
          batchSize: config.auctionSettlementBatchSize,
          concurrency: config.auctionSettlementConcurrency,
          leaseMs: config.auctionSettlementLeaseMs,
          retryDelayMs: config.auctionSettlementRetryDelayMs,
          workerId: `auction-settlement-${identifiers.generate()}`,
        }),
      inject: [
        AUCTION_SETTLEMENT_WORK_REPOSITORY,
        SettleAuction,
        AUCTION_INVENTORY_SETTLEMENT_INTENT_REPOSITORY,
        CLOCK,
        LOGGER,
        IDENTIFIER_GENERATOR,
        APP_CONFIG,
      ],
    },

    {
      provide: SCHEDULER_TIMER,
      useFactory: (): SchedulerTimerPort => new NodeSchedulerTimer(),
    },

    {
      provide: AuctionSettlementScheduler,
      useFactory: (
        worker: ProcessExpiredAuctions,
        timer: SchedulerTimerPort,
        logger: Logger,
        config: AppConfig,
      ): AuctionSettlementScheduler =>
        new AuctionSettlementScheduler(worker, timer, logger, {
          enabled: config.auctionSettlementSchedulerEnabled,
          pollIntervalMs: config.auctionSettlementPollIntervalMs,
        }),
      inject: [ProcessExpiredAuctions, SCHEDULER_TIMER, LOGGER, APP_CONFIG],
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
        intents: AuctionPublicationIntentRepositoryPort,
      ): PersistAuctionPublication =>
        new PersistAuctionPublication(repository, inventory, fees, clock, intents),

      inject: [
        AUCTION_REPOSITORY,
        PRODUCT_INVENTORY,
        PUBLICATION_FEE,
        CLOCK,
        AUCTION_PUBLICATION_INTENT_REPOSITORY,
      ],
    },

    {
      provide: PersistBidWithCredits,

      useFactory: (
        repository: AuctionRepositoryPort,
        credits: BidCreditsPort,
        clock: ClockPort,
      ): PersistBidWithCredits => new PersistBidWithCredits(repository, credits, clock),

      inject: [AUCTION_REPOSITORY, BID_CREDITS, CLOCK],
    },

    {
      provide: GetAuctionDetail,

      useFactory: (repository: AuctionRepositoryPort): GetAuctionDetail =>
        new GetAuctionDetail(repository),

      inject: [AUCTION_REPOSITORY],
    },

    {
      provide: GetAuctionDetail,

      useFactory: (repository: AuctionRepositoryPort): GetAuctionDetail =>
        new GetAuctionDetail(repository),

      inject: [AUCTION_REPOSITORY],
    },

    {
      provide: GetPendingClaims,

      useFactory: (pendingClaims: AuctionPendingClaimRepositoryPort): GetPendingClaims =>
        new GetPendingClaims(pendingClaims),

      inject: [AUCTION_PENDING_CLAIM_REPOSITORY],
    },

    {
      provide: ClaimPendingProduct,

      useFactory: (
        pendingClaims: AuctionPendingClaimRepositoryPort,
        auctions: AuctionRepositoryPort,
        inventory: ProductInventoryPort,
        clock: ClockPort,
      ): ClaimPendingProduct => new ClaimPendingProduct(pendingClaims, auctions, inventory, clock),

      inject: [AUCTION_PENDING_CLAIM_REPOSITORY, AUCTION_REPOSITORY, PRODUCT_INVENTORY, CLOCK],
    },

    {
      provide: ClaimPendingProductsBatch,

      useFactory: (
        claimPendingProduct: ClaimPendingProduct,
        pendingClaims: AuctionPendingClaimRepositoryPort,
      ): ClaimPendingProductsBatch =>
        new ClaimPendingProductsBatch(claimPendingProduct, pendingClaims),

      inject: [ClaimPendingProduct, AUCTION_PENDING_CLAIM_REPOSITORY],
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
        intents: AuctionPublicationIntentRepositoryPort,
      ): PublishAuction =>
        new PublishAuction(
          repository,
          catalog,
          inventory,
          sanctions,
          persistence,
          clock,
          identifiers,
          intents,
        ),

      inject: [
        AUCTION_REPOSITORY,
        CATALOG_PRODUCT_POLICY,
        PRODUCT_INVENTORY,
        SELLER_SANCTIONS,
        PersistAuctionPublication,
        CLOCK,
        IDENTIFIER_GENERATOR,
        AUCTION_PUBLICATION_INTENT_REPOSITORY,
      ],
    },

    {
      provide: ReactToRivalBid,

      useFactory: (
        repository: AuctionRepositoryPort,
        persistence: PersistBidWithCredits,
        clock: ClockPort,
        identifiers: IdentifierGeneratorPort,
        notifications: OutbidNotificationPort,
      ): ReactToRivalBid =>
        new ReactToRivalBid(repository, persistence, clock, identifiers, notifications),

      inject: [
        AUCTION_REPOSITORY,
        PersistBidWithCredits,
        CLOCK,
        IDENTIFIER_GENERATOR,
        OUTBID_NOTIFICATION,
      ],
    },

    {
      provide: RegisterBid,

      useFactory: (
        repository: AuctionRepositoryPort,
        persistence: PersistBidWithCredits,
        clock: ClockPort,
        identifiers: IdentifierGeneratorPort,
        notifications: OutbidNotificationPort,
        autoBidReactor: ReactToRivalBid,
      ): RegisterBid =>
        new RegisterBid(repository, persistence, clock, identifiers, notifications, autoBidReactor),

      inject: [
        AUCTION_REPOSITORY,
        PersistBidWithCredits,
        CLOCK,
        IDENTIFIER_GENERATOR,
        OUTBID_NOTIFICATION,
        ReactToRivalBid,
      ],
    },

    {
      provide: ConfigureAutoBid,

      useFactory: (repository: AuctionRepositoryPort, clock: ClockPort): ConfigureAutoBid =>
        new ConfigureAutoBid(repository, clock),

      inject: [AUCTION_REPOSITORY, CLOCK],
    },

    {
      provide: TOKEN_VERIFIER,

      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
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
          : {
              canActivate: (): boolean => true,
            },

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
        db === null
          ? []
          : [
              {
                name: 'postgres',

                check: () => pingDatabase(db),
              },
            ],

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
