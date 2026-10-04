import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { GetAuctionClosingTimeAndTrends } from '../../src/application/use-cases/GetAuctionClosingTimeAndTrends'
import { GetAuctionVolumeAndSuccess } from '../../src/application/use-cases/GetAuctionVolumeAndSuccess'

const asOf = new Date('2026-10-04T12:00:00.000Z')
const clock: ClockPort = { now: () => asOf }
// Semana ISO completa: lunes 2026-09-28 00:00Z .. lunes 2026-10-05 00:00Z (excl.).
const query = { from: '2026-09-28T00:00:00Z', to: '2026-10-04T00:00:00Z' }

const HOUR = 3_600_000
const at = (iso: string): Date => new Date(iso)
let sequence = 0
const nextId = (): string => `auction-${String(++sequence)}`

/** Subasta de jugador de 24 h publicada en `publishedAt`. */
const player = (
  publishedAt: string,
  overrides: Partial<MetricsAuctionFact> = {},
): MetricsAuctionFact => ({
  id: nextId(),
  priceKind: 'CREDITS',
  status: 'ACTIVE',
  publishedAt: at(publishedAt),
  closesAt: new Date(at(publishedAt).getTime() + 24 * HOUR),
  ...overrides,
})

const finishedWithWinner = (publishedAt: string, extra: Partial<MetricsAuctionFact> = {}) =>
  player(publishedAt, {
    status: 'FINISHED',
    closingResultType: 'WITH_WINNER',
    finishedAt: new Date(at(publishedAt).getTime() + 24 * HOUR + 30_000),
    ...extra,
  })

const finishedWithoutBids = (publishedAt: string, extra: Partial<MetricsAuctionFact> = {}) =>
  player(publishedAt, {
    status: 'FINISHED',
    closingResultType: 'WITHOUT_BIDS',
    finishedAt: new Date(at(publishedAt).getTime() + 24 * HOUR + 30_000),
    ...extra,
  })

const soldByBuyNow = (publishedAt: string, afterHours: number) =>
  player(publishedAt, {
    status: 'SOLD',
    buyNowCompletedAt: new Date(at(publishedAt).getTime() + afterHours * HOUR),
  })

const cancelled = (publishedAt: string, cancelledAt: string) =>
  player(publishedAt, { status: 'CANCELLED', cancelledAt: at(cancelledAt) })

const official = (publishedAt: string, mark: 'OFFICIAL' | 'PREMIUM') => ({
  id: nextId(),
  priceKind: 'REAL_MONEY' as const,
  status: 'ACTIVE' as const,
  publishedAt: at(publishedAt),
  closesAt: new Date(at(publishedAt).getTime() + 24 * HOUR),
  officialMark: mark,
})

describe('HU-91.2 casos de uso de metricas (adaptador en memoria)', () => {
  let repository: InMemoryAuctionMetricsRepository
  let volume: GetAuctionVolumeAndSuccess
  let trends: GetAuctionClosingTimeAndTrends

  beforeEach(() => {
    sequence = 0
    repository = new InMemoryAuctionMetricsRepository()
    volume = new GetAuctionVolumeAndSuccess(repository, clock)
    trends = new GetAuctionClosingTimeAndTrends(repository, clock)
  })

  describe('volumen y tasa de exito (contrato §3.1 / §4.1)', () => {
    it('CP-01: 10 cerradas, 6 con venta y 4 sin ella => 0.6', async () => {
      const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
      repository.seed(
        ...days.map((day) => finishedWithWinner(`${day}T10:00:00Z`)),
        soldByBuyNow('2026-09-29T08:00:00Z', 3),
        soldByBuyNow('2026-09-29T09:00:00Z', 5),
        ...days.map((day) => finishedWithoutBids(`${day}T11:00:00Z`)),
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.closed).toEqual({
        total: 10,
        withWinner: 4,
        soldByBuyNow: 2,
        withoutBids: 4,
        settlementFailedTerminal: 0,
      })
      expect(result.playerAuctions.successRate).toEqual({
        numerator: 6,
        denominator: 10,
        value: 0.6,
        formula: '(withWinner + soldByBuyNow) / closed.total',
        excludes: ['CANCELLED', 'ACTIVE'],
      })
    })

    it('cero subastas: la tasa es null (nunca 0) y todo es 0', async () => {
      const result = await volume.execute(query)

      expect(result.playerAuctions.successRate).toMatchObject({
        numerator: 0,
        denominator: 0,
        value: null,
      })
      expect(result.playerAuctions).toMatchObject({
        published: 0,
        cancelled: 0,
        active: 0,
        awaitingClosure: 0,
        closed: { total: 0 },
        claims: { createdInPeriod: 0, pending: 0, claimed: 0, expired: 0 },
      })
      expect(result.officialAuctions).toMatchObject({
        published: 0,
        byMark: { OFFICIAL: 0, PREMIUM: 0 },
      })
    })

    it('todas canceladas: denominador 0, tasa null y las canceladas se reportan aparte', async () => {
      repository.seed(
        cancelled('2026-09-28T10:00:00Z', '2026-09-28T12:00:00Z'),
        cancelled('2026-09-29T10:00:00Z', '2026-09-29T12:00:00Z'),
        cancelled('2026-09-30T10:00:00Z', '2026-09-30T12:00:00Z'),
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.published).toBe(3)
      expect(result.playerAuctions.cancelled).toBe(3)
      expect(result.playerAuctions.successRate).toMatchObject({ denominator: 0, value: null })
    })

    it('una cancelada no entra en el denominador (no castiga la tasa)', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z'),
        finishedWithoutBids('2026-09-28T11:00:00Z'),
        cancelled('2026-09-28T12:00:00Z', '2026-09-28T13:00:00Z'),
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.successRate).toMatchObject({
        numerator: 1,
        denominator: 2,
        value: 0.5,
      })
      expect(result.playerAuctions.cancelled).toBe(1)
    })

    it('mezcla FINISHED + SOLD en el mismo periodo: ambas cuentan y SOLD usa su propio instante', async () => {
      // Publicada ANTES del periodo, vendida DENTRO: el cierre manda, no la publicacion.
      repository.seed(
        soldByBuyNow('2026-09-27T20:00:00Z', 10),
        finishedWithWinner('2026-09-28T10:00:00Z'),
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.published).toBe(1)
      expect(result.playerAuctions.closed).toMatchObject({
        total: 2,
        withWinner: 1,
        soldByBuyNow: 1,
      })
      expect(result.playerAuctions.successRate.value).toBe(1)
    })

    it('un reclamo vencido o una liquidacion fallida siguen siendo exito y se reportan aparte', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z', {
          claim: { status: 'EXPIRED', settledAt: at('2026-09-29T10:00:30Z') },
        }),
        finishedWithWinner('2026-09-28T11:00:00Z', {
          settlementStatus: 'FAILED_TERMINAL',
          claim: { status: 'PENDING', settledAt: at('2026-09-29T11:00:30Z') },
        }),
        finishedWithWinner('2026-09-28T12:00:00Z', {
          claim: { status: 'CLAIMED', settledAt: at('2026-09-29T12:00:30Z') },
        }),
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.successRate).toMatchObject({ numerator: 3, denominator: 3 })
      expect(result.playerAuctions.closed.settlementFailedTerminal).toBe(1)
      expect(result.playerAuctions.claims).toEqual({
        createdInPeriod: 3,
        pending: 1,
        claimed: 1,
        expired: 1,
      })
    })

    it('active frente a awaitingClosure depende de closes_at vs asOf y no del periodo', async () => {
      repository.seed(
        player('2026-10-04T08:00:00Z'), // cierra 2026-10-05 08:00 -> activa
        player('2026-10-03T08:00:00Z'), // cerro 2026-10-04 08:00 -> pendiente del scheduler
        player('2026-08-01T08:00:00Z'), // muy anterior al periodo, sigue ACTIVE vencida
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.active).toBe(1)
      expect(result.playerAuctions.awaitingClosure).toBe(2)
    })

    it('las oficiales (dinero real) solo aportan volumen y su tasa es UNAVAILABLE; no alteran la de jugador', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z'),
        official('2026-09-28T10:00:00Z', 'OFFICIAL'),
        official('2026-09-29T10:00:00Z', 'OFFICIAL'),
        official('2026-09-30T10:00:00Z', 'PREMIUM'),
      )

      const result = await volume.execute(query)

      expect(result.officialAuctions).toEqual({
        currencyUnit: 'REAL_MONEY',
        published: 3,
        byMark: { OFFICIAL: 2, PREMIUM: 1 },
        successRate: {
          availability: 'UNAVAILABLE',
          reason: 'OFFICIAL_AUCTION_HAS_NO_CLOSING_FLOW',
        },
      })
      expect(result.playerAuctions.published).toBe(1)
      expect(result.playerAuctions.successRate).toMatchObject({ numerator: 1, denominator: 1 })
      expect(result.playerAuctions.currencyUnit).toBe('CREDITS')
    })

    it('el periodo es semiabierto [from, to): from incluido y to excluido', async () => {
      repository.seed(
        finishedWithoutBids('2026-09-27T00:00:00Z', {
          finishedAt: at('2026-09-28T00:00:00.000Z'), // == from -> dentro
        }),
        finishedWithoutBids('2026-09-27T00:00:00Z', {
          finishedAt: at('2026-10-04T00:00:00.000Z'), // == to -> fuera
        }),
        finishedWithoutBids('2026-09-27T00:00:00Z', {
          finishedAt: at('2026-09-27T23:59:59.999Z'), // justo antes de from -> fuera
        }),
      )

      const result = await volume.execute(query)

      expect(result.playerAuctions.closed.total).toBe(1)
    })

    it('envoltorio: definitionsVersion, periodo UTC y asOf', async () => {
      const result = await volume.execute(query)

      expect(result.definitionsVersion).toBe('hu-91.v1')
      expect(result.period).toEqual({
        from: '2026-09-28T00:00:00.000Z',
        to: '2026-10-04T00:00:00.000Z',
        timezone: 'UTC',
        bounds: '[from,to)',
      })
      expect(result.asOf).toBe('2026-10-04T12:00:00.000Z')
    })

    it('un periodo invalido propaga INVALID_PERIOD', async () => {
      await expect(volume.execute({ from: 'x' })).rejects.toMatchObject({ code: 'INVALID_PERIOD' })
    })
  })

  describe('idempotencia en memoria (contrato §5)', () => {
    it('sembrar dos veces la misma subasta no duplica ninguna cifra', async () => {
      const auction = finishedWithWinner('2026-09-28T10:00:00Z')
      repository.seed(auction)
      const once = await volume.execute(query)
      const onceTrends = await trends.execute({ ...query, granularity: 'DAY' })

      repository.seed(auction, auction)

      expect(await volume.execute(query)).toEqual(once)
      expect(await trends.execute({ ...query, granularity: 'DAY' })).toEqual(onceTrends)
    })
  })

  describe('tiempo de cierre y tendencias (contrato §3.3 / §4.5)', () => {
    it('cero subastas: muestra vacia con null y serie continua en ceros', async () => {
      const result = await trends.execute({ ...query, granularity: 'DAY' })

      expect(result.closingTime).toMatchObject({
        unit: 'SECONDS',
        sampleSize: 0,
        average: null,
        median: null,
        p90: null,
        byCloseReason: {
          EXPIRED_WITH_WINNER: { sampleSize: 0, average: null },
          EXPIRED_WITHOUT_BIDS: { sampleSize: 0, average: null },
          BUY_NOW: { sampleSize: 0, average: null },
        },
        settlementLagSeconds: { sampleSize: 0, average: null, p90: null },
      })
      expect(result.trends.buckets).toHaveLength(6)
      expect(result.trends.buckets.every((bucket) => bucket.playerAuctions.published === 0)).toBe(
        true,
      )
      expect(result.trends.buckets[0]?.playerAuctions).toMatchObject({
        successRate: null,
        averageClosingTimeSeconds: null,
      })
    })

    it('todas canceladas: sin muestra de cierre pero con cancelaciones en la serie', async () => {
      repository.seed(
        cancelled('2026-09-28T10:00:00Z', '2026-09-28T12:00:00Z'),
        cancelled('2026-09-28T11:00:00Z', '2026-09-29T12:00:00Z'),
      )

      const result = await trends.execute({ ...query, granularity: 'DAY' })

      expect(result.closingTime.sampleSize).toBe(0)
      expect(result.closingTime.average).toBeNull()
      const [first, second] = result.trends.buckets
      expect(first?.playerAuctions.cancelled).toBe(1)
      expect(second?.playerAuctions.cancelled).toBe(1)
      expect(first?.playerAuctions.successRate).toBeNull()
    })

    it('mezcla FINISHED + SOLD: la compra inmediata baja el promedio y se ve por motivo', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z'), // 24 h + 30 s = 86 430 s
        finishedWithoutBids('2026-09-29T10:00:00Z'), // 86 430 s
        soldByBuyNow('2026-09-30T10:00:00Z', 2), // 7 200 s
      )

      const { closingTime } = await trends.execute({ ...query, granularity: 'WEEK' })

      expect(closingTime.sampleSize).toBe(3)
      expect(closingTime.byCloseReason).toEqual({
        EXPIRED_WITH_WINNER: { sampleSize: 1, average: 86430 },
        EXPIRED_WITHOUT_BIDS: { sampleSize: 1, average: 86430 },
        BUY_NOW: { sampleSize: 1, average: 7200 },
      })
      expect(closingTime.average).toBe(Math.round((86430 + 86430 + 7200) / 3))
      // percentile_cont: mediana = valor central; p90 interpola entre los dos mayores.
      expect(closingTime.median).toBe(86430)
      expect(closingTime.p90).toBe(86430)
    })

    it('percentile_cont interpola linealmente (p90 de 4 valores)', async () => {
      // Cierres a 1 h, 2 h, 3 h y 11 h: rango p90 = 0.9 * 3 = 2.7 -> 3 h + 0.7 * (11 h - 3 h).
      repository.seed(
        soldByBuyNow('2026-09-28T00:00:00Z', 1),
        soldByBuyNow('2026-09-28T00:00:00Z', 2),
        soldByBuyNow('2026-09-28T00:00:00Z', 3),
        soldByBuyNow('2026-09-28T00:00:00Z', 11),
      )

      const { closingTime } = await trends.execute({ ...query, granularity: 'DAY' })

      expect(closingTime.median).toBe(2.5 * 3600)
      expect(closingTime.p90).toBe(Math.round((3 + 0.7 * 8) * 3600))
    })

    it('settlementLag solo mide FINISHED (finished_at - closes_at) y no incluye compras inmediatas', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z'), // lag 30 s
        finishedWithoutBids('2026-09-29T10:00:00Z', {
          finishedAt: new Date(at('2026-09-29T10:00:00Z').getTime() + 24 * HOUR + 90_000), // 90 s
        }),
        soldByBuyNow('2026-09-30T10:00:00Z', 2),
      )

      const { closingTime } = await trends.execute({ ...query, granularity: 'DAY' })

      expect(closingTime.settlementLagSeconds.sampleSize).toBe(2)
      expect(closingTime.settlementLagSeconds.average).toBe(60)
    })

    it('las oficiales no entran en el tiempo de cierre y se marcan UNAVAILABLE', async () => {
      repository.seed(official('2026-09-28T10:00:00Z', 'OFFICIAL'))

      const result = await trends.execute({ ...query, granularity: 'DAY' })

      expect(result.closingTime.sampleSize).toBe(0)
      expect(result.closingTime.officialAuctions).toEqual({
        availability: 'UNAVAILABLE',
        reason: 'OFFICIAL_AUCTION_HAS_NO_CLOSING_FLOW',
      })
      expect(result.trends.buckets[0]?.officialAuctions.published).toBe(1)
    })

    it('buckets WEEK con anclas propias y bucketAnchors del contrato', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z', {
          finishedAt: at('2026-09-29T10:00:30Z'),
        }),
        soldByBuyNow('2026-09-28T10:00:00Z', 2),
      )

      const result = await trends.execute({ ...query, granularity: 'WEEK' })

      expect(result.granularity).toBe('WEEK')
      expect(result.trends.bucketAnchors).toEqual({
        published: 'published_at',
        closedWithWinner: 'finished_at',
        soldByBuyNow: 'auction_buy_now_operations.completed_at',
        closedWithoutBids: 'finished_at',
        cancelled: 'cancelled_at',
      })
      expect(result.trends.buckets).toHaveLength(1)
      expect(result.trends.buckets[0]).toMatchObject({
        bucketStart: '2026-09-28T00:00:00.000Z',
        bucketEnd: '2026-10-05T00:00:00.000Z',
        playerAuctions: { published: 2, closedWithWinner: 1, soldByBuyNow: 1, successRate: 1 },
      })
    })

    it('invariante: la suma de los buckets coincide con los totales de volumen', async () => {
      repository.seed(
        finishedWithWinner('2026-09-28T10:00:00Z'),
        finishedWithWinner('2026-09-30T10:00:00Z'),
        finishedWithoutBids('2026-09-29T10:00:00Z'),
        soldByBuyNow('2026-09-30T10:00:00Z', 5),
        cancelled('2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'),
        official('2026-10-02T10:00:00Z', 'PREMIUM'),
        player('2026-10-03T09:00:00Z'),
      )

      const totals = await volume.execute(query)
      for (const granularity of ['DAY', 'WEEK', 'MONTH']) {
        const series = await trends.execute({ ...query, granularity })
        const sum = (pick: (bucket: (typeof series.trends.buckets)[number]) => number): number =>
          series.trends.buckets.reduce((total, bucket) => total + pick(bucket), 0)

        expect(sum((b) => b.playerAuctions.published)).toBe(totals.playerAuctions.published)
        expect(sum((b) => b.playerAuctions.closedWithWinner)).toBe(
          totals.playerAuctions.closed.withWinner,
        )
        expect(sum((b) => b.playerAuctions.soldByBuyNow)).toBe(
          totals.playerAuctions.closed.soldByBuyNow,
        )
        expect(sum((b) => b.playerAuctions.closedWithoutBids)).toBe(
          totals.playerAuctions.closed.withoutBids,
        )
        expect(sum((b) => b.playerAuctions.cancelled)).toBe(totals.playerAuctions.cancelled)
        expect(sum((b) => b.officialAuctions.published)).toBe(totals.officialAuctions.published)
      }
    })

    it('rechaza granularity invalida y DAY sobre mas de 92 dias', async () => {
      await expect(trends.execute({ ...query, granularity: 'HOUR' })).rejects.toMatchObject({
        code: 'INVALID_PARAMETER',
      })
      await expect(
        trends.execute({ from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    })
  })
})
