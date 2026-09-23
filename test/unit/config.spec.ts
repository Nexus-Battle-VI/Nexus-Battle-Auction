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
    })

    expect(config.notificationsBaseUrl).toBeNull()

    expect(config.notificationsTimeoutMs).toBe(3_000)
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
})
