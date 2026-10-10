import { AuctionMetricsQueryError } from '../../src/application/errors/AuctionMetricsError'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { GetAuctionAveragePrices } from '../../src/application/use-cases/GetAuctionAveragePrices'
import type { GetAuctionClosingTimeAndTrends } from '../../src/application/use-cases/GetAuctionClosingTimeAndTrends'
import {
  AuctionMetricsUnavailableError,
  GetAuctionMetricsSummary,
  SECTION_FAILED_REASON,
  type SummarySectionName,
} from '../../src/application/use-cases/GetAuctionMetricsSummary'
import type { GetAuctionProductRankings } from '../../src/application/use-cases/GetAuctionProductRankings'
import type { GetAuctionUsersAndCommissions } from '../../src/application/use-cases/GetAuctionUsersAndCommissions'
import type { GetAuctionVolumeAndSuccess } from '../../src/application/use-cases/GetAuctionVolumeAndSuccess'

const asOf = new Date('2026-10-04T12:00:00.000Z')
const clock: ClockPort = { now: () => asOf }

type Execute = jest.Mock<Promise<unknown>, [Record<string, string | undefined>]>

const stub = (payload: unknown): Execute =>
  jest.fn<Promise<unknown>, [Record<string, string | undefined>]>().mockResolvedValue(payload)

interface Harness {
  readonly useCase: GetAuctionMetricsSummary
  readonly mocks: Record<SummarySectionName, Execute>
  readonly failures: SummarySectionName[]
}

const build = (overrides: Partial<Record<SummarySectionName, Execute>> = {}): Harness => {
  const mocks: Record<SummarySectionName, Execute> = {
    volumeAndSuccess: stub({ name: 'volume' }),
    closingTimeAndTrends: stub({ name: 'closing' }),
    productRankings: stub({ name: 'rankings', enrichment: { status: 'UNAVAILABLE' } }),
    averagePrices: stub({ name: 'prices' }),
    usersAndCommissions: stub({ name: 'users' }),
    ...overrides,
  }
  const failures: SummarySectionName[] = []
  const useCase = new GetAuctionMetricsSummary(
    { execute: mocks.volumeAndSuccess } as unknown as GetAuctionVolumeAndSuccess,
    { execute: mocks.closingTimeAndTrends } as unknown as GetAuctionClosingTimeAndTrends,
    { execute: mocks.productRankings } as unknown as GetAuctionProductRankings,
    { execute: mocks.averagePrices } as unknown as GetAuctionAveragePrices,
    { execute: mocks.usersAndCommissions } as unknown as GetAuctionUsersAndCommissions,
    clock,
    (section) => failures.push(section),
  )
  return { useCase, mocks, failures }
}

const rejecting = (message: string): Execute =>
  jest
    .fn<Promise<unknown>, [Record<string, string | undefined>]>()
    .mockRejectedValue(new Error(message))

describe('HU-91.6 consolidado de metricas (GetAuctionMetricsSummary)', () => {
  const query = { from: '2026-09-04T00:00:00Z', to: '2026-10-04T00:00:00Z' }

  it('todas las secciones disponibles: envuelve cada respuesta como AVAILABLE', async () => {
    const { useCase, failures } = build()

    const result = await useCase.execute({ ...query, granularity: 'WEEK', limit: '5' })

    expect(result).toMatchObject({
      definitionsVersion: 'hu-91.v1',
      period: { from: '2026-09-04T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', timezone: 'UTC' },
      asOf: '2026-10-04T12:00:00.000Z',
      limit: 5,
      granularity: 'WEEK',
    })
    expect(Object.values(result.sections).map((section) => section.status)).toEqual([
      'AVAILABLE',
      'AVAILABLE',
      'AVAILABLE',
      'AVAILABLE',
      'AVAILABLE',
    ])
    expect(result.sections.volumeAndSuccess).toEqual({
      status: 'AVAILABLE',
      data: { name: 'volume' },
    })
    expect(failures).toEqual([])
  })

  it('las cinco secciones reciben el MISMO periodo resuelto y los parametros que les tocan', async () => {
    const { useCase, mocks } = build()

    await useCase.execute({ ...query, granularity: 'WEEK', limit: '7' })

    const range = { from: '2026-09-04T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' }
    expect(mocks.volumeAndSuccess).toHaveBeenCalledWith(range)
    expect(mocks.averagePrices).toHaveBeenCalledWith(range)
    expect(mocks.closingTimeAndTrends).toHaveBeenCalledWith({ ...range, granularity: 'WEEK' })
    expect(mocks.productRankings).toHaveBeenCalledWith({ ...range, limit: '7' })
    expect(mocks.usersAndCommissions).toHaveBeenCalledWith({ ...range, limit: '7' })
  })

  it('sin parametros usa los defectos del contrato: ultimos 30 dias, limit 10, DAY', async () => {
    const { useCase, mocks } = build()

    const result = await useCase.execute({})

    expect(result.limit).toBe(10)
    expect(result.granularity).toBe('DAY')
    expect(result.period.to).toBe('2026-10-04T12:00:00.000Z')
    expect(result.period.from).toBe('2026-09-04T12:00:00.000Z')
    expect(mocks.closingTimeAndTrends).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'DAY' }),
    )
  })

  it('una seccion degradada: las otras cuatro siguen y el detalle del error no sale', async () => {
    const { useCase, failures } = build({
      averagePrices: rejecting('connection refused 10.0.0.5:5432 password=secret'),
    })

    const result = await useCase.execute(query)

    expect(result.sections.averagePrices).toEqual({
      status: 'DEGRADED',
      reason: SECTION_FAILED_REASON,
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.sections.volumeAndSuccess.status).toBe('AVAILABLE')
    expect(result.sections.closingTimeAndTrends.status).toBe('AVAILABLE')
    expect(result.sections.productRankings.status).toBe('AVAILABLE')
    expect(result.sections.usersAndCommissions.status).toBe('AVAILABLE')
    expect(failures).toEqual(['averagePrices'])
  })

  it('cuatro secciones degradadas y una disponible: sigue siendo 200 con la sana', async () => {
    const { useCase } = build({
      volumeAndSuccess: rejecting('x'),
      closingTimeAndTrends: rejecting('x'),
      productRankings: rejecting('x'),
      averagePrices: rejecting('x'),
    })

    const result = await useCase.execute(query)

    expect(result.sections.usersAndCommissions.status).toBe('AVAILABLE')
    expect(
      Object.values(result.sections).filter((section) => section.status === 'DEGRADED'),
    ).toHaveLength(4)
  })

  it('Catalog caido (enrichment UNAVAILABLE) NO degrada la seccion de rankings', async () => {
    const { useCase } = build()

    const result = await useCase.execute(query)

    expect(result.sections.productRankings).toEqual({
      status: 'AVAILABLE',
      data: { name: 'rankings', enrichment: { status: 'UNAVAILABLE' } },
    })
  })

  it('las cinco fallan: lanza AuctionMetricsUnavailableError (HTTP 503) y las registra todas', async () => {
    const { useCase, failures } = build({
      volumeAndSuccess: rejecting('a'),
      closingTimeAndTrends: rejecting('b'),
      productRankings: rejecting('c'),
      averagePrices: rejecting('d'),
      usersAndCommissions: rejecting('e'),
    })

    await expect(useCase.execute(query)).rejects.toBeInstanceOf(AuctionMetricsUnavailableError)
    expect(failures).toHaveLength(5)
  })

  describe('validacion de parametros: siempre error de consulta, nunca una seccion degradada', () => {
    it.each([
      ['from invalido', { from: 'ayer', to: '2026-10-04T00:00:00Z' }, 'INVALID_PERIOD'],
      ['to invalido', { from: '2026-09-04T00:00:00Z', to: 'manana' }, 'INVALID_PERIOD'],
      [
        'from sin zona',
        { from: '2026-09-04T00:00:00', to: '2026-10-04T00:00:00Z' },
        'INVALID_PERIOD',
      ],
      [
        'from >= to',
        { from: '2026-10-04T00:00:00Z', to: '2026-09-04T00:00:00Z' },
        'INVALID_PERIOD',
      ],
      [
        'periodo > 366 dias',
        { from: '2025-01-01T00:00:00Z', to: '2026-10-04T00:00:00Z' },
        'INVALID_PERIOD',
      ],
      ['to futuro', { to: '2026-12-01T00:00:00Z' }, 'INVALID_PERIOD'],
      ['limit 0', { ...query, limit: '0' }, 'INVALID_PARAMETER'],
      ['limit 51', { ...query, limit: '51' }, 'INVALID_PARAMETER'],
      ['limit no numerico', { ...query, limit: 'diez' }, 'INVALID_PARAMETER'],
      ['granularity desconocida', { ...query, granularity: 'YEAR' }, 'INVALID_PARAMETER'],
      [
        'DAY con mas de 92 dias',
        { from: '2026-06-01T00:00:00Z', to: '2026-10-04T00:00:00Z', granularity: 'DAY' },
        'INVALID_PARAMETER',
      ],
    ])('%s -> %s', async (_label, input, code) => {
      const { useCase, mocks } = build()

      const error: unknown = await useCase.execute(input).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AuctionMetricsQueryError)
      expect((error as AuctionMetricsQueryError).code).toBe(code)
      for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled()
    })

    it('DAY con periodo largo es valido si se pide WEEK', async () => {
      const { useCase } = build()

      const result = await useCase.execute({
        from: '2026-06-01T00:00:00Z',
        to: '2026-10-04T00:00:00Z',
        granularity: 'WEEK',
      })

      expect(result.granularity).toBe('WEEK')
    })
  })
})
