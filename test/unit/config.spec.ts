import {
  ConfigurationError,
  loadConfig,
  PersistenceDriver,
} from '../../src/infrastructure/config/env'

describe('Configuracion del servicio', () => {
  it('arranca con valores por defecto de desarrollo', () => {
    const config = loadConfig({})

    expect(config).toMatchObject({
      nodeEnv: 'development',

      serviceName: 'nexus-battle-auction',

      port: 3008,

      globalPrefix: 'api',

      swaggerEnabled: true,

      persistenceDriver: PersistenceDriver.Memory,

      databaseUrl: null,

      internalServiceAuthSecret: null,

      notificationsBaseUrl: null,

      notificationsTimeoutMs: 3_000,

      notificationsWatchlistBaseUrl: null,

      auctionSettlementBatchSize: 25,

      auctionSettlementConcurrency: 4,

      auctionSettlementLeaseMs: 300_000,

      auctionSettlementRetryDelayMs: 30_000,

      auctionSettlementSchedulerEnabled: false,

      auctionSettlementPollIntervalMs: 5_000,

      auctionSettlementEventDispatchEnabled: false,

      auctionSettlementQueueUrl: null,

      auctionSettlementEventDispatchBatchSize: 25,

      auctionPendingClaimExpirationSchedulerEnabled: false,

      auctionPendingClaimExpirationPollIntervalMs: 60_000,

      auctionPendingClaimExpirationBatchSize: 100,

      auctionEarlyClosureRetrySchedulerEnabled: false,

      auctionEarlyClosureRetryPollIntervalMs: 30_000,

      auctionBuyNowPendingClaimRetrySchedulerEnabled: false,

      auctionBuyNowPendingClaimRetryPollIntervalMs: 30_000,

      auctionBuyNowPendingClaimRetryBatchSize: 50,
    })
  })

  it('lee los valores declarados en el entorno', () => {
    const config = loadConfig({
      NODE_ENV: 'test',

      SERVICE_NAME: 'otro-nombre',

      SERVICE_VERSION: '9.9.9',

      LOG_LEVEL: 'debug',

      PORT: '4000',

      GLOBAL_PREFIX: 'prefijo',

      SWAGGER_ENABLED: 'false',

      PERSISTENCE_DRIVER: 'postgres',

      DATABASE_URL: 'postgres://usuario@db/auction',

      INTERNAL_SERVICE_AUTH_SECRET: 'secreto',

      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',

      NOTIFICATIONS_TIMEOUT_MS: '5000',
    })

    expect(config).toMatchObject({
      nodeEnv: 'test',

      serviceName: 'otro-nombre',

      version: '9.9.9',

      logLevel: 'debug',

      port: 4000,

      globalPrefix: 'prefijo',

      swaggerEnabled: false,

      persistenceDriver: PersistenceDriver.Postgres,

      databaseUrl: 'postgres://usuario@db/auction',

      internalServiceAuthSecret: 'secreto',

      notificationsBaseUrl: 'http://notifications:3005',

      notificationsTimeoutMs: 5_000,
    })
  })

  it('deshabilita la documentacion interactiva en produccion por defecto', () => {
    const config = loadConfig({
      NODE_ENV: 'production',

      PERSISTENCE_DRIVER: 'postgres',

      DATABASE_URL: 'postgres://db/auction',

      AUTH_MODE: 'jwt',

      COGNITO_USER_POOL_ID: 'us-east-1_abc',

      COGNITO_CLIENT_ID: 'cliente',
    })

    expect(config.swaggerEnabled).toBe(false)
  })

  it('exige DATABASE_URL con el driver de PostgreSQL', () => {
    expect(() =>
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
      }),
    ).toThrow(/DATABASE_URL/)
  })

  it('impide arrancar en produccion con persistencia en memoria', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',

        AUTH_MODE: 'jwt',

        COGNITO_USER_POOL_ID: 'us-east-1_abc',

        COGNITO_CLIENT_ID: 'cliente',
      }),
    ).toThrow(/PERSISTENCE_DRIVER/)
  })

  it('permite dejar Notifications desactivado en desarrollo', () => {
    const config = loadConfig({
      INTERNAL_SERVICE_AUTH_SECRET: '',
      NOTIFICATIONS_BASE_URL: '',
      NOTIFICATIONS_WATCHLIST_BASE_URL: '',
    })

    expect(config.notificationsBaseUrl).toBeNull()

    expect(config.notificationsTimeoutMs).toBe(3_000)

    expect(config.notificationsWatchlistBaseUrl).toBeNull()
  })

  it('exige secreto interno cuando se configura Notifications', () => {
    expect(() =>
      loadConfig({
        NOTIFICATIONS_BASE_URL: 'http://notifications:3005',
      }),
    ).toThrow(/INTERNAL_SERVICE_AUTH_SECRET/)
  })

  it('acepta la integracion de Notifications con URL y secreto', () => {
    const config = loadConfig({
      INTERNAL_SERVICE_AUTH_SECRET: 'shared-secret',

      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',

      NOTIFICATIONS_TIMEOUT_MS: '2500',
    })

    expect(config.notificationsBaseUrl).toBe('http://notifications:3005')

    expect(config.notificationsTimeoutMs).toBe(2_500)
  })

  /**
   * HU-68: watchlist-events vive en un puerto DISTINTO de outbid/
   * closed-by-buy-now/auto-bid-limit-reached del lado de Notifications, asi
   * que tiene su propia variable -no cae de vuelta a NOTIFICATIONS_BASE_URL
   * si falta, para no reintroducir en silencio el puerto equivocado-.
   */
  it('exige secreto interno cuando se configura la URL de watchlist de Notifications', () => {
    expect(() =>
      loadConfig({
        NOTIFICATIONS_WATCHLIST_BASE_URL: 'http://notifications:3004',
      }),
    ).toThrow(/INTERNAL_SERVICE_AUTH_SECRET/)
  })

  it('acepta la URL de watchlist de Notifications de forma independiente de NOTIFICATIONS_BASE_URL', () => {
    const config = loadConfig({
      INTERNAL_SERVICE_AUTH_SECRET: 'shared-secret',

      NOTIFICATIONS_WATCHLIST_BASE_URL: 'http://notifications:3004',
    })

    expect(config.notificationsWatchlistBaseUrl).toBe('http://notifications:3004')

    // Sin NOTIFICATIONS_BASE_URL propia: no hereda ni comparte el valor de watchlist.
    expect(config.notificationsBaseUrl).toBeNull()
  })

  it('permite configurar las dos URLs de Notifications a la vez, cada una a su puerto', () => {
    const config = loadConfig({
      INTERNAL_SERVICE_AUTH_SECRET: 'shared-secret',

      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',

      NOTIFICATIONS_WATCHLIST_BASE_URL: 'http://notifications:3004',
    })

    expect(config.notificationsBaseUrl).toBe('http://notifications:3005')

    expect(config.notificationsWatchlistBaseUrl).toBe('http://notifications:3004')
  })

  it.each([
    [
      'un entorno desconocido',
      {
        NODE_ENV: 'staging',
      },
    ],

    [
      'un driver desconocido',
      {
        PERSISTENCE_DRIVER: 'mongo',
      },
    ],

    [
      'un puerto no entero',
      {
        PORT: 'tres mil',
      },
    ],

    [
      'un puerto fuera de rango',
      {
        PORT: '70000',
      },
    ],

    [
      'un booleano ambiguo',
      {
        SWAGGER_ENABLED: 'si',
      },
    ],

    [
      'un nivel de registro desconocido',
      {
        LOG_LEVEL: 'trace',
      },
    ],

    [
      'un timeout de Notifications no entero',
      {
        NOTIFICATIONS_TIMEOUT_MS: 'dos mil',
      },
    ],

    [
      'un timeout de Notifications fuera de rango',
      {
        NOTIFICATIONS_TIMEOUT_MS: '70000',
      },
    ],
  ])('rechaza %s', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError)
  })

  it.each(['1', '5000'])('acepta timeout Wallet valido %s', (timeout) => {
    expect(
      loadConfig({
        INTERNAL_SERVICE_AUTH_SECRET: 'secret',
        WALLET_BASE_URL: 'https://wallet.example.com/',
        WALLET_REQUEST_TIMEOUT_MS: timeout,
      }),
    ).toMatchObject({
      walletBaseUrl: 'https://wallet.example.com/',
      walletRequestTimeoutMs: Number(timeout),
    })
  })

  it.each(['0', '60001', 'abc', ''])('rechaza timeout Wallet invalido %s', (timeout) => {
    expect(() => loadConfig({ WALLET_REQUEST_TIMEOUT_MS: timeout })).toThrow(ConfigurationError)
  })

  it('valida URL y secreto Wallet opcional', () => {
    expect(loadConfig({}).walletBaseUrl).toBeNull()
    expect(() =>
      loadConfig({ WALLET_BASE_URL: 'not-url', INTERNAL_SERVICE_AUTH_SECRET: 'secret' }),
    ).toThrow(ConfigurationError)
    expect(() => loadConfig({ WALLET_BASE_URL: 'https://wallet.example.com' })).toThrow(
      /INTERNAL_SERVICE_AUTH_SECRET/,
    )
  })

  it.each(['1', '5000'])('acepta timeout Inventory valido %s', (timeout) => {
    expect(
      loadConfig({
        INTERNAL_SERVICE_AUTH_SECRET: 'secret',
        INVENTORY_BASE_URL: 'https://inventory.example.com/',
        INVENTORY_REQUEST_TIMEOUT_MS: timeout,
      }),
    ).toMatchObject({
      inventoryBaseUrl: 'https://inventory.example.com/',
      inventoryRequestTimeoutMs: Number(timeout),
    })
  })

  it.each(['0', '60001', 'abc', ''])('rechaza timeout Inventory invalido %s', (timeout) => {
    expect(() => loadConfig({ INVENTORY_REQUEST_TIMEOUT_MS: timeout })).toThrow(ConfigurationError)
  })

  it('valida URL y secreto Inventory opcional', () => {
    expect(loadConfig({}).inventoryBaseUrl).toBeNull()
    expect(() =>
      loadConfig({ INVENTORY_BASE_URL: 'not-url', INTERNAL_SERVICE_AUTH_SECRET: 'secret' }),
    ).toThrow(ConfigurationError)
    expect(() => loadConfig({ INVENTORY_BASE_URL: 'https://inventory.example.com' })).toThrow(
      /INTERNAL_SERVICE_AUTH_SECRET/,
    )
  })

  it('lee la configuracion del worker de settlement', () => {
    expect(
      loadConfig({
        AUCTION_SETTLEMENT_BATCH_SIZE: '40',
        AUCTION_SETTLEMENT_CONCURRENCY: '8',
        AUCTION_SETTLEMENT_LEASE_MS: '60000',
        AUCTION_SETTLEMENT_RETRY_DELAY_MS: '5000',
      }),
    ).toMatchObject({
      auctionSettlementBatchSize: 40,
      auctionSettlementConcurrency: 8,
      auctionSettlementLeaseMs: 60_000,
      auctionSettlementRetryDelayMs: 5_000,
    })
  })

  it.each([
    ['AUCTION_SETTLEMENT_BATCH_SIZE', '0'],
    ['AUCTION_SETTLEMENT_BATCH_SIZE', '101'],
    ['AUCTION_SETTLEMENT_CONCURRENCY', '17'],
    ['AUCTION_SETTLEMENT_LEASE_MS', '29999'],
    ['AUCTION_SETTLEMENT_RETRY_DELAY_MS', '999'],
  ])('rechaza %s fuera de rango', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigurationError)
  })

  it('rechaza concurrencia mayor al batch', () => {
    expect(() =>
      loadConfig({
        AUCTION_SETTLEMENT_BATCH_SIZE: '2',
        AUCTION_SETTLEMENT_CONCURRENCY: '3',
      }),
    ).toThrow(/CONCURRENCY/)
  })

  it('lee la configuracion del scheduler de vencimiento de pending-claims (HU-69.6)', () => {
    expect(
      loadConfig({
        AUCTION_PENDING_CLAIM_EXPIRATION_SCHEDULER_ENABLED: 'true',
        AUCTION_PENDING_CLAIM_EXPIRATION_POLL_INTERVAL_MS: '120000',
        AUCTION_PENDING_CLAIM_EXPIRATION_BATCH_SIZE: '50',
      }),
    ).toMatchObject({
      auctionPendingClaimExpirationSchedulerEnabled: true,
      auctionPendingClaimExpirationPollIntervalMs: 120_000,
      auctionPendingClaimExpirationBatchSize: 50,
    })
  })

  it('no exige postgres ni Wallet/Inventory para habilitar el scheduler de vencimiento', () => {
    expect(() =>
      loadConfig({ AUCTION_PENDING_CLAIM_EXPIRATION_SCHEDULER_ENABLED: 'true' }),
    ).not.toThrow()
  })

  it.each([
    ['AUCTION_PENDING_CLAIM_EXPIRATION_POLL_INTERVAL_MS', '999'],
    ['AUCTION_PENDING_CLAIM_EXPIRATION_POLL_INTERVAL_MS', '3600001'],
    ['AUCTION_PENDING_CLAIM_EXPIRATION_BATCH_SIZE', '0'],
    ['AUCTION_PENDING_CLAIM_EXPIRATION_BATCH_SIZE', '1001'],
  ])('rechaza %s fuera de rango', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigurationError)
  })

  it.each(['true', 'false'])('lee scheduler enabled estricto: %s', (enabled) => {
    const common =
      enabled === 'true'
        ? {
            PERSISTENCE_DRIVER: 'postgres',
            DATABASE_URL: 'postgres://db/auction',
            INTERNAL_SERVICE_AUTH_SECRET: 'secret',
            WALLET_BASE_URL: 'http://wallet:3004',
            INVENTORY_BASE_URL: 'http://inventory:3006',
          }
        : {}
    expect(
      loadConfig({ ...common, AUCTION_SETTLEMENT_SCHEDULER_ENABLED: enabled })
        .auctionSettlementSchedulerEnabled,
    ).toBe(enabled === 'true')
  })

  it('rechaza scheduler enabled ambiguo', () => {
    expect(() => loadConfig({ AUCTION_SETTLEMENT_SCHEDULER_ENABLED: 'yes' })).toThrow(
      ConfigurationError,
    )
  })

  it.each(['1000', '5000', '300000'])('acepta poll interval valido %s', (interval) => {
    expect(loadConfig({ AUCTION_SETTLEMENT_POLL_INTERVAL_MS: interval })).toMatchObject({
      auctionSettlementPollIntervalMs: Number(interval),
    })
  })

  it.each(['999', '300001'])('rechaza poll interval fuera de rango %s', (interval) => {
    expect(() => loadConfig({ AUCTION_SETTLEMENT_POLL_INTERVAL_MS: interval })).toThrow(
      ConfigurationError,
    )
  })

  it('falla cerrado si el scheduler no tiene persistencia o dependencias externas', () => {
    const enabled = { AUCTION_SETTLEMENT_SCHEDULER_ENABLED: 'true' }
    expect(() => loadConfig(enabled)).toThrow(/PERSISTENCE_DRIVER/)
    expect(() =>
      loadConfig({
        ...enabled,
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
      }),
    ).toThrow(/WALLET_BASE_URL/)
  })

  it('configura el scheduler de reintentos de cierre temprano y falla cerrado', () => {
    expect(
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
        WALLET_BASE_URL: 'http://wallet:3007',
        NOTIFICATIONS_BASE_URL: 'http://notifications:3005',
        INTERNAL_SERVICE_AUTH_SECRET: 'secret',
        AUCTION_EARLY_CLOSURE_RETRY_SCHEDULER_ENABLED: 'true',
        AUCTION_EARLY_CLOSURE_RETRY_POLL_INTERVAL_MS: '90000',
      }),
    ).toMatchObject({
      auctionEarlyClosureRetrySchedulerEnabled: true,
      auctionEarlyClosureRetryPollIntervalMs: 90_000,
    })

    expect(() => loadConfig({ AUCTION_EARLY_CLOSURE_RETRY_SCHEDULER_ENABLED: 'true' })).toThrow(
      /PERSISTENCE_DRIVER/,
    )
    expect(() =>
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
        AUCTION_EARLY_CLOSURE_RETRY_SCHEDULER_ENABLED: 'true',
      }),
    ).toThrow(/WALLET_BASE_URL/)
  })

  it('configura fail-closed el retry de pending claim de compra inmediata', () => {
    expect(
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
        INVENTORY_BASE_URL: 'http://inventory:3006',
        INTERNAL_SERVICE_AUTH_SECRET: 'secret',
        AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_SCHEDULER_ENABLED: 'true',
        AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_POLL_INTERVAL_MS: '90000',
        AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_BATCH_SIZE: '25',
      }),
    ).toMatchObject({
      auctionBuyNowPendingClaimRetrySchedulerEnabled: true,
      auctionBuyNowPendingClaimRetryPollIntervalMs: 90_000,
      auctionBuyNowPendingClaimRetryBatchSize: 25,
    })
    expect(() =>
      loadConfig({ AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_SCHEDULER_ENABLED: 'true' }),
    ).toThrow(/PERSISTENCE_DRIVER/)
    expect(() =>
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
        AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_SCHEDULER_ENABLED: 'true',
      }),
    ).toThrow(/INVENTORY_BASE_URL/)
    expect(() =>
      loadConfig({ AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_POLL_INTERVAL_MS: '999' }),
    ).toThrow(ConfigurationError)
    expect(() => loadConfig({ AUCTION_BUY_NOW_PENDING_CLAIM_RETRY_BATCH_SIZE: '501' })).toThrow(
      ConfigurationError,
    )
  })

  it.each(['999', '3600001', 'invalid'])(
    'rechaza poll interval de retry invalido: %s',
    (interval) => {
      expect(() => loadConfig({ AUCTION_EARLY_CLOSURE_RETRY_POLL_INTERVAL_MS: interval })).toThrow(
        ConfigurationError,
      )
    },
  )

  it('lee el despacho de eventos de settlement y exige su cola al habilitarlo', () => {
    expect(
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
        AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED: 'true',
        AUCTION_SETTLEMENT_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/auction',
        AUCTION_SETTLEMENT_EVENT_DISPATCH_BATCH_SIZE: '100',
      }),
    ).toMatchObject({
      auctionSettlementEventDispatchEnabled: true,
      auctionSettlementQueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/auction',
      auctionSettlementEventDispatchBatchSize: 100,
    })
    expect(() => loadConfig({ AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED: 'true' })).toThrow(
      /PERSISTENCE_DRIVER/,
    )
    expect(() =>
      loadConfig({
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/auction',
        AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED: 'true',
      }),
    ).toThrow(/AUCTION_SETTLEMENT_QUEUE_URL/)
  })

  it.each(['0', '101', 'invalid'])('rechaza batch de despacho invalido: %s', (batchSize) => {
    expect(() => loadConfig({ AUCTION_SETTLEMENT_EVENT_DISPATCH_BATCH_SIZE: batchSize })).toThrow(
      ConfigurationError,
    )
  })
})
