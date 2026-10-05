import { AuctionMetricsQueryError } from '../../src/application/errors/AuctionMetricsError'
import {
  bucketStartOf,
  bucketStartsFor,
  nextBucketStart,
  ratioOrNull,
  resolveGranularity,
  resolveMetricsPeriod,
  roundSeconds,
} from '../../src/application/services/auction-metrics-period'

const now = new Date('2026-10-04T12:00:00.000Z')
const iso = (value: Date): string => value.toISOString()

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action()
  } catch (error: unknown) {
    return error instanceof AuctionMetricsQueryError ? error.code : 'OTHER'
  }
  return undefined
}

describe('periodo de metricas HU-91 (contrato hu-91.v1 §4)', () => {
  it('por defecto usa to = ahora y from = to - 30 dias', () => {
    const period = resolveMetricsPeriod({}, now)

    expect(iso(period.to)).toBe('2026-10-04T12:00:00.000Z')
    expect(iso(period.from)).toBe('2026-09-04T12:00:00.000Z')
  })

  it('acepta ISO-8601 con zona y normaliza a UTC', () => {
    const period = resolveMetricsPeriod(
      { from: '2026-09-01T00:00:00-05:00', to: '2026-09-10T00:00:00Z' },
      now,
    )

    expect(iso(period.from)).toBe('2026-09-01T05:00:00.000Z')
    expect(iso(period.to)).toBe('2026-09-10T00:00:00.000Z')
  })

  it.each([
    ['sin zona horaria', { from: '2026-09-01T00:00:00', to: '2026-09-02T00:00:00Z' }],
    ['no ISO', { from: 'ayer', to: '2026-09-02T00:00:00Z' }],
    ['fecha imposible', { from: '2026-02-30T00:00:00Z', to: '2026-09-02T00:00:00Z' }],
    ['from igual a to', { from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }],
    ['from posterior a to', { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' }],
    ['to futuro', { to: '2026-10-04T12:05:00Z' }],
    ['mas de 366 dias', { from: '2025-09-01T00:00:00Z', to: '2026-09-04T00:00:00Z' }],
  ])('rechaza con INVALID_PERIOD un periodo %s', (_name, input) => {
    expect(codeOf(() => resolveMetricsPeriod(input, now))).toBe('INVALID_PERIOD')
  })

  it('tolera un minuto de reloj adelantado en to y admite exactamente 366 dias', () => {
    expect(codeOf(() => resolveMetricsPeriod({ to: '2026-10-04T12:01:00Z' }, now))).toBeUndefined()
    expect(
      codeOf(() =>
        resolveMetricsPeriod({ from: '2025-09-03T12:00:00Z', to: '2026-09-04T12:00:00Z' }, now),
      ),
    ).toBeUndefined()
  })

  it('granularity: defecto DAY, valores validos y rechazos con INVALID_PARAMETER', () => {
    const period = resolveMetricsPeriod({}, now)

    expect(resolveGranularity(undefined, period)).toBe('DAY')
    expect(resolveGranularity('WEEK', period)).toBe('WEEK')
    expect(resolveGranularity('MONTH', period)).toBe('MONTH')
    expect(codeOf(() => resolveGranularity('HOUR', period))).toBe('INVALID_PARAMETER')
    expect(codeOf(() => resolveGranularity('day', period))).toBe('INVALID_PARAMETER')
  })

  it('DAY no admite mas de 92 dias; WEEK y MONTH si', () => {
    const long = resolveMetricsPeriod(
      { from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      now,
    )
    const exact = resolveMetricsPeriod(
      { from: '2026-07-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      now,
    )

    expect(codeOf(() => resolveGranularity('DAY', long))).toBe('INVALID_PARAMETER')
    expect(codeOf(() => resolveGranularity('DAY', exact))).toBeUndefined()
    expect(resolveGranularity('WEEK', long)).toBe('WEEK')
    expect(resolveGranularity('MONTH', long)).toBe('MONTH')
  })
})

describe('buckets UTC de las tendencias', () => {
  it('DAY: medianoche UTC', () => {
    expect(iso(bucketStartOf(new Date('2026-10-03T23:59:59.999Z'), 'DAY'))).toBe(
      '2026-10-03T00:00:00.000Z',
    )
  })

  it('WEEK: arranca el lunes ISO, tambien para un domingo', () => {
    // 2026-10-04 es domingo; su semana ISO empieza el lunes 2026-09-28.
    expect(iso(bucketStartOf(new Date('2026-10-04T10:00:00Z'), 'WEEK'))).toBe(
      '2026-09-28T00:00:00.000Z',
    )
    expect(iso(bucketStartOf(new Date('2026-09-28T00:00:00Z'), 'WEEK'))).toBe(
      '2026-09-28T00:00:00.000Z',
    )
  })

  it('MONTH: primer dia del mes y cambio de ano', () => {
    expect(iso(bucketStartOf(new Date('2026-12-31T23:00:00Z'), 'MONTH'))).toBe(
      '2026-12-01T00:00:00.000Z',
    )
    expect(iso(nextBucketStart(new Date('2026-12-01T00:00:00Z'), 'MONTH'))).toBe(
      '2027-01-01T00:00:00.000Z',
    )
  })

  it('bucketStartsFor es contiguo, completo y cubre [from, to)', () => {
    const period = {
      from: new Date('2026-09-30T18:00:00Z'),
      to: new Date('2026-10-03T00:00:00Z'),
    }

    expect(bucketStartsFor(period, 'DAY').map(iso)).toEqual([
      '2026-09-30T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ])
    expect(bucketStartsFor(period, 'WEEK').map(iso)).toEqual(['2026-09-28T00:00:00.000Z'])
    expect(bucketStartsFor(period, 'MONTH').map(iso)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ])
  })
})

describe('auxiliares numericos', () => {
  it('ratioOrNull devuelve null y no 0 sin denominador', () => {
    expect(ratioOrNull(0, 0)).toBeNull()
    expect(ratioOrNull(0, 4)).toBe(0)
    expect(ratioOrNull(6, 10)).toBe(0.6)
  })

  it('roundSeconds redondea half-up y conserva null', () => {
    expect(roundSeconds(null)).toBeNull()
    expect(roundSeconds(41.5)).toBe(42)
    expect(roundSeconds(41.49)).toBe(41)
  })
})
