export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export const AuthMode = {
  /**
   * Sin verificacion de identidad. Solo existe para desarrollo y pruebas: un
   * binario con `NODE_ENV=production` y este modo NO ARRANCA (ADR-004).
   */
  Disabled: 'disabled',

  /** Se exige un testimonio firmado por el user pool de Cognito. */
  Jwt: 'jwt',
} as const

export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode]

export interface CognitoConfig {
  readonly userPoolId: string
  readonly clientId: string
}

export const PersistenceDriver = {
  Memory: 'memory',
  Postgres: 'postgres',
} as const

export type PersistenceDriver = (typeof PersistenceDriver)[keyof typeof PersistenceDriver]

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production'

  readonly serviceName: string
  readonly version: string

  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'

  readonly port: number
  readonly globalPrefix: string
  readonly swaggerEnabled: boolean

  readonly persistenceDriver: PersistenceDriver

  readonly databaseUrl: string | null

  readonly authMode: AuthMode

  readonly cognito: CognitoConfig | null

  readonly internalServiceAuthSecret: string | null

  readonly catalogBaseUrl: string

  /**
   * HU-63.5.
   *
   * URL interna del servidor de Notifications que recibe
   * las notificaciones de puja superada.
   *
   * null permite ejecutar Auction localmente sin levantar
   * Notifications.
   */
  readonly notificationsBaseUrl: string | null

  readonly notificationsTimeoutMs: number

  readonly walletBaseUrl: string | null

  readonly walletRequestTimeoutMs: number

  readonly inventoryBaseUrl: string | null

  readonly inventoryRequestTimeoutMs: number

  readonly auctionSettlementBatchSize: number

  readonly auctionSettlementConcurrency: number

  readonly auctionSettlementLeaseMs: number

  readonly auctionSettlementRetryDelayMs: number

  readonly auctionSettlementSchedulerEnabled: boolean

  readonly auctionSettlementPollIntervalMs: number

  readonly auctionSettlementEventDispatchEnabled: boolean

  readonly auctionSettlementQueueUrl: string | null

  readonly auctionSettlementEventDispatchBatchSize: number
}

type RawEnv = Readonly<Record<string, string | undefined>>

const readEnum = <T extends string>(
  env: RawEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigurationError(
      `${key} debe ser uno de: ${allowed.join(', ')}. Se recibio "${raw}".`,
    )
  }

  return raw as T
}

const readInteger = (
  env: RawEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed)) {
    throw new ConfigurationError(`${key} debe ser un numero entero. Se recibio "${raw}".`)
  }

  if (parsed < min || parsed > max) {
    throw new ConfigurationError(
      `${key} debe estar entre ${String(min)} y ${String(max)}. Se recibio ${String(parsed)}.`,
    )
  }

  return parsed
}

const readString = (env: RawEnv, key: string, fallback: string): string => {
  const raw = env[key]

  return raw === undefined || raw === '' ? fallback : raw
}

const readBoolean = (env: RawEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key]

  if (raw === undefined || raw === '') {
    return fallback
  }

  if (raw !== 'true' && raw !== 'false') {
    throw new ConfigurationError(`${key} debe ser "true" o "false". Se recibio "${raw}".`)
  }

  return raw === 'true'
}

/**
 * Construye la configuracion a partir del entorno.
 *
 * Falla de inmediato ante una configuracion invalida.
 */
export const loadConfig = (env: RawEnv): AppConfig => {
  const nodeEnv = readEnum(
    env,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  )

  const persistenceDriver = readEnum(
    env,
    'PERSISTENCE_DRIVER',
    [PersistenceDriver.Memory, PersistenceDriver.Postgres],
    PersistenceDriver.Memory,
  )

  const databaseUrl = readString(env, 'DATABASE_URL', '')

  if (persistenceDriver === PersistenceDriver.Postgres && databaseUrl === '') {
    throw new ConfigurationError(
      'DATABASE_URL es obligatorio cuando PERSISTENCE_DRIVER es "postgres".',
    )
  }

  const authMode = readEnum(env, 'AUTH_MODE', [AuthMode.Disabled, AuthMode.Jwt], AuthMode.Disabled)

  if (nodeEnv === 'production' && authMode === AuthMode.Disabled) {
    throw new ConfigurationError(
      'AUTH_MODE no puede ser "disabled" con NODE_ENV=production. Sin verificacion de ' +
        'identidad el servicio no debe exponerse. Vease ADR-004.',
    )
  }

  const cognitoUserPoolId = readString(env, 'COGNITO_USER_POOL_ID', '')

  const cognitoClientId = readString(env, 'COGNITO_CLIENT_ID', '')

  if (authMode === AuthMode.Jwt && (cognitoUserPoolId === '' || cognitoClientId === '')) {
    throw new ConfigurationError(
      'COGNITO_USER_POOL_ID y COGNITO_CLIENT_ID son obligatorios cuando AUTH_MODE es "jwt".',
    )
  }

  /*
   * Una puja que desaparece al reiniciar deja creditos
   * reservados sin dueno. Memory solo es valido fuera de
   * produccion.
   */
  if (nodeEnv === 'production' && persistenceDriver === PersistenceDriver.Memory) {
    throw new ConfigurationError(
      'PERSISTENCE_DRIVER no puede ser "memory" con NODE_ENV=production. Vease ADR-019.',
    )
  }

  const internalServiceAuthSecret = readString(env, 'INTERNAL_SERVICE_AUTH_SECRET', '')

  const notificationsBaseUrl = readString(env, 'NOTIFICATIONS_BASE_URL', '')

  const notificationsTimeoutMs = readInteger(env, 'NOTIFICATIONS_TIMEOUT_MS', 3_000, 1, 60_000)

  const walletBaseUrl = readString(env, 'WALLET_BASE_URL', '')

  if (env.WALLET_REQUEST_TIMEOUT_MS === '') {
    throw new ConfigurationError('WALLET_REQUEST_TIMEOUT_MS no puede estar vacio.')
  }

  const walletRequestTimeoutMs = readInteger(env, 'WALLET_REQUEST_TIMEOUT_MS', 3_000, 1, 60_000)

  const inventoryBaseUrl = readString(env, 'INVENTORY_BASE_URL', '')

  if (env.INVENTORY_REQUEST_TIMEOUT_MS === '') {
    throw new ConfigurationError('INVENTORY_REQUEST_TIMEOUT_MS no puede estar vacio.')
  }

  const inventoryRequestTimeoutMs = readInteger(
    env,
    'INVENTORY_REQUEST_TIMEOUT_MS',
    3_000,
    1,
    60_000,
  )

  const auctionSettlementBatchSize = readInteger(env, 'AUCTION_SETTLEMENT_BATCH_SIZE', 25, 1, 100)
  const auctionSettlementConcurrency = readInteger(env, 'AUCTION_SETTLEMENT_CONCURRENCY', 4, 1, 16)
  if (auctionSettlementConcurrency > auctionSettlementBatchSize) {
    throw new ConfigurationError(
      'AUCTION_SETTLEMENT_CONCURRENCY no puede superar AUCTION_SETTLEMENT_BATCH_SIZE.',
    )
  }
  const auctionSettlementLeaseMs = readInteger(
    env,
    'AUCTION_SETTLEMENT_LEASE_MS',
    300_000,
    30_000,
    900_000,
  )
  const auctionSettlementRetryDelayMs = readInteger(
    env,
    'AUCTION_SETTLEMENT_RETRY_DELAY_MS',
    30_000,
    1_000,
    3_600_000,
  )
  const auctionSettlementSchedulerEnabled = readBoolean(
    env,
    'AUCTION_SETTLEMENT_SCHEDULER_ENABLED',
    false,
  )
  const auctionSettlementPollIntervalMs = readInteger(
    env,
    'AUCTION_SETTLEMENT_POLL_INTERVAL_MS',
    5_000,
    1_000,
    300_000,
  )
  const auctionSettlementEventDispatchEnabled = readBoolean(
    env,
    'AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED',
    false,
  )
  const auctionSettlementQueueUrl = readString(env, 'AUCTION_SETTLEMENT_QUEUE_URL', '')
  const auctionSettlementEventDispatchBatchSize = readInteger(
    env,
    'AUCTION_SETTLEMENT_EVENT_DISPATCH_BATCH_SIZE',
    25,
    1,
    100,
  )
  if (auctionSettlementEventDispatchEnabled) {
    if (persistenceDriver !== PersistenceDriver.Postgres) {
      throw new ConfigurationError(
        'PERSISTENCE_DRIVER debe ser "postgres" cuando AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED=true.',
      )
    }
    if (auctionSettlementQueueUrl === '') {
      throw new ConfigurationError(
        'AUCTION_SETTLEMENT_QUEUE_URL es obligatorio cuando AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED=true.',
      )
    }
  }

  if (walletBaseUrl !== '') {
    try {
      new URL(walletBaseUrl)
    } catch {
      throw new ConfigurationError('WALLET_BASE_URL debe ser una URL valida.')
    }
  }

  if (inventoryBaseUrl !== '') {
    try {
      new URL(inventoryBaseUrl)
    } catch {
      throw new ConfigurationError('INVENTORY_BASE_URL debe ser una URL valida.')
    }
  }

  if (walletBaseUrl !== '' && internalServiceAuthSecret === '') {
    throw new ConfigurationError(
      'INTERNAL_SERVICE_AUTH_SECRET es obligatorio cuando WALLET_BASE_URL esta configurado.',
    )
  }

  if (inventoryBaseUrl !== '' && internalServiceAuthSecret === '') {
    throw new ConfigurationError(
      'INTERNAL_SERVICE_AUTH_SECRET es obligatorio cuando INVENTORY_BASE_URL esta configurado.',
    )
  }

  if (auctionSettlementSchedulerEnabled) {
    if (persistenceDriver !== PersistenceDriver.Postgres) {
      throw new ConfigurationError(
        'PERSISTENCE_DRIVER debe ser "postgres" cuando AUCTION_SETTLEMENT_SCHEDULER_ENABLED=true.',
      )
    }
    if (walletBaseUrl === '' || inventoryBaseUrl === '' || internalServiceAuthSecret === '') {
      throw new ConfigurationError(
        'WALLET_BASE_URL, INVENTORY_BASE_URL e INTERNAL_SERVICE_AUTH_SECRET son obligatorios cuando AUCTION_SETTLEMENT_SCHEDULER_ENABLED=true.',
      )
    }
  }

  /*
   * Si se configura Notifications, una llamada sin firma no
   * serviria: Notifications la rechazaria con 401.
   *
   * Se falla al arrancar en vez de fingir que la integracion
   * esta disponible.
   */
  if (notificationsBaseUrl !== '' && internalServiceAuthSecret === '') {
    throw new ConfigurationError(
      'INTERNAL_SERVICE_AUTH_SECRET es obligatorio cuando NOTIFICATIONS_BASE_URL esta configurado.',
    )
  }

  return {
    nodeEnv,

    serviceName: readString(env, 'SERVICE_NAME', 'nexus-battle-auction'),

    version: readString(env, 'SERVICE_VERSION', '0.1.0'),

    logLevel: readEnum(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),

    port: readInteger(env, 'PORT', 3008, 1, 65_535),

    globalPrefix: readString(env, 'GLOBAL_PREFIX', 'api'),

    swaggerEnabled: readBoolean(env, 'SWAGGER_ENABLED', nodeEnv !== 'production'),

    persistenceDriver,

    databaseUrl: databaseUrl === '' ? null : databaseUrl,

    authMode,

    cognito:
      authMode === AuthMode.Jwt
        ? {
            userPoolId: cognitoUserPoolId,

            clientId: cognitoClientId,
          }
        : null,

    internalServiceAuthSecret: internalServiceAuthSecret === '' ? null : internalServiceAuthSecret,

    catalogBaseUrl: readString(env, 'CATALOG_BASE_URL', 'http://catalog:3003'),

    notificationsBaseUrl: notificationsBaseUrl === '' ? null : notificationsBaseUrl,

    notificationsTimeoutMs,

    walletBaseUrl: walletBaseUrl === '' ? null : walletBaseUrl,

    walletRequestTimeoutMs,

    inventoryBaseUrl: inventoryBaseUrl === '' ? null : inventoryBaseUrl,

    inventoryRequestTimeoutMs,

    auctionSettlementBatchSize,

    auctionSettlementConcurrency,

    auctionSettlementLeaseMs,

    auctionSettlementRetryDelayMs,

    auctionSettlementSchedulerEnabled,

    auctionSettlementPollIntervalMs,

    auctionSettlementEventDispatchEnabled,

    auctionSettlementQueueUrl: auctionSettlementQueueUrl === '' ? null : auctionSettlementQueueUrl,

    auctionSettlementEventDispatchBatchSize,
  }
}
