export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Readonly<Record<string, string | number | boolean | null>>

export interface Logger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LoggerOptions {
  readonly level: LogLevel
  readonly service: string
  readonly version: string
  /** Sumidero inyectable: permite verificar la salida sin capturar la consola. */
  readonly sink?: (line: string) => void
  readonly clock?: () => Date
}

/**
 * Registro estructurado en JSON por linea, apto para agregacion posterior.
 * Es el unico punto del servicio autorizado para escribir en la salida
 * estandar; la regla se hace cumplir con `no-console` en ESLint.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const threshold = LEVEL_WEIGHT[options.level]
  const sink =
    options.sink ??
    ((line: string): void => {
      console.log(line)
    })
  const clock = options.clock ?? ((): Date => new Date())

  const emit = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_WEIGHT[level] < threshold) {
      return
    }

    sink(
      JSON.stringify({
        timestamp: clock().toISOString(),
        level,
        service: options.service,
        version: options.version,
        message,
        ...(context ?? {}),
      }),
    )
  }

  return {
    debug: (message, context): void => {
      emit('debug', message, context)
    },
    info: (message, context): void => {
      emit('info', message, context)
    },
    warn: (message, context): void => {
      emit('warn', message, context)
    },
    error: (message, context): void => {
      emit('error', message, context)
    },
  }
}
