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
  }
}
