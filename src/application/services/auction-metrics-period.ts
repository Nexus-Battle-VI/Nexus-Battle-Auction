import { AuctionMetricsQueryError } from '../errors/AuctionMetricsError'
import type { MetricsPeriod, TrendGranularity } from '../ports/AuctionMetricsRepositoryPort'

/** Version de las definiciones del contrato `hu-91-auction-metrics-v1` (campo `definitionsVersion`). */
export const METRICS_DEFINITIONS_VERSION = 'hu-91.v1'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_SPAN_DAYS = 30
const MAX_SPAN_DAYS = 366
const MAX_DAILY_SPAN_DAYS = 92
/** Tolerancia hacia el futuro de `to`: reloj del cliente ligeramente adelantado. */
const FUTURE_TOLERANCE_MS = 60 * 1000

/** ISO-8601 con zona explicita (`Z` o `+hh:mm`): sin zona, el instante seria ambiguo. */
const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * `new Date('2026-02-30T00:00:00Z')` NO falla en V8: desplaza la fecha al 2 de
 * marzo. Por eso se comprueba que los componentes del calendario existan.
 */
const hasValidCalendarParts = (match: RegExpExecArray): boolean => {
  const part = (index: number): number => Number(match[index] ?? 0)
  const month = part(2)
  const day = part(3)
  const calendar = new Date(Date.UTC(part(1), month - 1, day))
  return (
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    part(4) <= 23 &&
    part(5) <= 59 &&
    part(6) <= 59
  )
}

const parseInstant = (name: 'from' | 'to', raw: string): Date => {
  const match = ISO_WITH_ZONE.exec(raw)
  const parsed =
    match !== null && hasValidCalendarParts(match) ? new Date(raw) : new Date(Number.NaN)
  if (Number.isNaN(parsed.getTime())) {
    throw new AuctionMetricsQueryError(
      'INVALID_PERIOD',
      `El parametro ${name} debe ser una fecha ISO-8601 con zona horaria.`,
    )
  }
  return parsed
}

/**
 * Periodo del contrato: `[from, to)` en UTC. Defecto `to = now`, `from = to - 30 dias`;
 * maximo 366 dias; `to` no puede estar mas de un minuto en el futuro.
 */
export const resolveMetricsPeriod = (
  input: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: Date,
): MetricsPeriod => {
  const to = input.to === undefined ? new Date(now) : parseInstant('to', input.to)
  const from =
    input.from === undefined
      ? new Date(to.getTime() - DEFAULT_SPAN_DAYS * DAY_MS)
      : parseInstant('from', input.from)

  if (to.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new AuctionMetricsQueryError('INVALID_PERIOD', 'El parametro to no puede ser futuro.')
  }
  if (from.getTime() >= to.getTime()) {
    throw new AuctionMetricsQueryError('INVALID_PERIOD', 'El periodo debe cumplir from < to.')
  }
  if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * DAY_MS) {
    throw new AuctionMetricsQueryError(
      'INVALID_PERIOD',
      `El periodo no puede superar ${String(MAX_SPAN_DAYS)} dias.`,
    )
  }
  return { from, to }
}

export const resolveGranularity = (
  raw: string | undefined,
  period: MetricsPeriod,
): TrendGranularity => {
  const granularity = raw ?? 'DAY'
  if (granularity !== 'DAY' && granularity !== 'WEEK' && granularity !== 'MONTH') {
    throw new AuctionMetricsQueryError(
      'INVALID_PARAMETER',
      'granularity debe ser DAY, WEEK o MONTH.',
    )
  }
  if (
    granularity === 'DAY' &&
    period.to.getTime() - period.from.getTime() > MAX_DAILY_SPAN_DAYS * DAY_MS
  ) {
    throw new AuctionMetricsQueryError(
      'INVALID_PARAMETER',
      `Con granularity=DAY el periodo no puede superar ${String(MAX_DAILY_SPAN_DAYS)} dias.`,
    )
  }
  return granularity
}

/** Inicio (UTC) del bucket que contiene `instant`: dia, semana ISO (lunes) o mes. */
export const bucketStartOf = (instant: Date, granularity: TrendGranularity): Date => {
  const year = instant.getUTCFullYear()
  const month = instant.getUTCMonth()
  const day = instant.getUTCDate()
  if (granularity === 'MONTH') return new Date(Date.UTC(year, month, 1))
  const midnight = Date.UTC(year, month, day)
  if (granularity === 'DAY') return new Date(midnight)
  const sinceMonday = (instant.getUTCDay() + 6) % 7
  return new Date(midnight - sinceMonday * DAY_MS)
}

export const nextBucketStart = (start: Date, granularity: TrendGranularity): Date => {
  if (granularity === 'MONTH') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  }
  return new Date(start.getTime() + (granularity === 'WEEK' ? 7 : 1) * DAY_MS)
}

/** Todos los buckets que intersectan `[from, to)`, contiguos y sin huecos. */
export const bucketStartsFor = (period: MetricsPeriod, granularity: TrendGranularity): Date[] => {
  const starts: Date[] = []
  let cursor = bucketStartOf(period.from, granularity)
  while (cursor.getTime() < period.to.getTime()) {
    starts.push(cursor)
    cursor = nextBucketStart(cursor, granularity)
  }
  return starts
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/** `limit` del contrato: entero 1..50, defecto 10. Cualquier otra cosa es `INVALID_PARAMETER`. */
export const resolveLimit = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_LIMIT
  const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AuctionMetricsQueryError(
      'INVALID_PARAMETER',
      `limit debe ser un entero entre 1 y ${String(MAX_LIMIT)}.`,
    )
  }
  return limit
}

export const periodEnvelope = (
  period: MetricsPeriod,
  asOf: Date,
): {
  readonly definitionsVersion: string
  readonly period: {
    readonly from: string
    readonly to: string
    readonly timezone: 'UTC'
    readonly bounds: '[from,to)'
  }
  readonly asOf: string
} => ({
  definitionsVersion: METRICS_DEFINITIONS_VERSION,
  period: {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    timezone: 'UTC',
    bounds: '[from,to)',
  },
  asOf: asOf.toISOString(),
})

/** Segundos enteros (half-up); `null` se conserva. */
export const roundSeconds = (value: number | null): number | null =>
  value === null ? null : Math.round(value)

/** Razon `numerador / denominador`, o `null` si no hay denominador (nunca 0). */
export const ratioOrNull = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator
