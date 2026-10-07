import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { averageHalfUp } from '../../src/application/services/auction-metrics-period'
import { GetAuctionAveragePrices } from '../../src/application/use-cases/GetAuctionAveragePrices'

const asOf = new Date('2026-10-04T12:00:00.000Z')
const clock: ClockPort = { now: () => asOf }
const query = { from: '2026-09-28T00:00:00Z', to: '2026-10-04T00:00:00Z' }
const HOUR = 3_600_000
const at = (iso: string): Date => new Date(iso)
let sequence = 0

const base = (iso: string): Pick<MetricsAuctionFact, 'id' | 'publishedAt' | 'closesAt'> => ({
  id: `auction-${String(++sequence)}`,
  publishedAt: at(iso),
  closesAt: new Date(at(iso).getTime() + 24 * HOUR),
})

/** Venta por cierre de subasta (`final_amount_credits`). */
const closedSale = (iso: string, price: number, minimumBid = 10): MetricsAuctionFact => {
  const b = base(iso)
  return {
    ...b,
    priceKind: 'CREDITS',
    status: 'FINISHED',
    closingResultType: 'WITH_WINNER',
    finishedAt: new Date(b.closesAt.getTime() + 30_000),
    finalAmountCredits: price,
    minimumBidCredits: minimumBid,
  }
}

/** Compra inmediata: `finalAmountCredits` queda sin valor, el precio vive en la operacion. */
const buyNowSale = (iso: string, price: number, minimumBid = 10): MetricsAuctionFact => ({
  ...base(iso),
  priceKind: 'CREDITS',
  status: 'SOLD',
  buyNowCompletedAt: new Date(at(iso).getTime() + 2 * HOUR),
  buyNowPriceCredits: price,
  minimumBidCredits: minimumBid,
})

const withoutBids = (iso: string, minimumBid = 10): MetricsAuctionFact => {
  const b = base(iso)
  return {
    ...b,
    priceKind: 'CREDITS',
    status: 'FINISHED',
    closingResultType: 'WITHOUT_BIDS',
    finishedAt: new Date(b.closesAt.getTime() + 30_000),
    minimumBidCredits: minimumBid,
  }
}

const cancelled = (iso: string, minimumBid = 10): MetricsAuctionFact => ({
  ...base(iso),
  priceKind: 'CREDITS',
  status: 'CANCELLED',
  cancelledAt: new Date(at(iso).getTime() + HOUR),
  minimumBidCredits: minimumBid,
})

const active = (iso: string, minimumBid = 10): MetricsAuctionFact => ({
  ...base(iso),
  priceKind: 'CREDITS',
  status: 'ACTIVE',
  minimumBidCredits: minimumBid,
})

const official = (
  iso: string,
  currency: string,
  minimumBidAmountMinor: number,
  buyNowAmountMinor?: number,
): MetricsAuctionFact => ({
  ...base(iso),
  priceKind: 'REAL_MONEY',
  status: 'ACTIVE',
  officialMark: 'OFFICIAL',
  currency,
  minimumBidAmountMinor,
  ...(buyNowAmountMinor === undefined ? {} : { buyNowAmountMinor }),
})

describe('averageHalfUp: redondeo half-up exacto', () => {
  it.each([
    // [suma, cantidad, decimales, esperado]
    [10, 3, 2, 3.33], // 3.3333
    [2, 3, 2, 0.67], // 0.6666
    [1, 8, 2, 0.13], // 0.125 -> half-up
    [201, 200, 2, 1.01], // 1.005: Math.round(1.005 * 100) / 100 daria 1
    [1, 200, 2, 0.01], // 0.005 -> half-up
    [5, 2, 0, 3], // 2.5 -> 3
    [7, 3, 0, 2], // 2.33 -> 2
    [3, 2, 0, 2], // 1.5 -> 2
    [440, 4, 2, 110], // exacto
    [145, 7, 2, 20.71], // 20.714
  ])('suma %d / cantidad %d a %d decimales = %d', (sum, count, decimals, expected) => {
    expect(averageHalfUp(sum, count, decimals)).toBe(expected)
  })

  it('devuelve null sin muestra: un promedio de nada no es 0', () => {
    expect(averageHalfUp(0, 0, 2)).toBeNull()
    expect(averageHalfUp(0, 0, 0)).toBeNull()
  })

  it('un promedio genuinamente 0 sigue siendo 0 (no se confunde con la ausencia de muestra)', () => {
    expect(averageHalfUp(0, 3, 2)).toBe(0)
  })

  it('no pierde exactitud con importes grandes de dinero real en unidad minima', () => {
    // 3 publicaciones de 2_000_000_000 y 2_000_000_001 y 2_000_000_001 -> 2_000_000_000.67
    expect(averageHalfUp(6_000_000_002, 3, 0)).toBe(2_000_000_001)
  })
})

describe('HU-91.4 precios promedio por moneda (contrato hu-91.v1 §3.4 / §4.3)', () => {
  let repository: InMemoryAuctionMetricsRepository
  let prices: GetAuctionAveragePrices

  beforeEach(() => {
    sequence = 0
    repository = new InMemoryAuctionMetricsRepository()
    prices = new GetAuctionAveragePrices(repository, clock)
  })

  it('cifras absolutas con datos mixtos: cierre por subasta + compra inmediata + lista + dinero real', async () => {
    repository.seed(
      closedSale('2026-09-28T10:00:00Z', 100, 20),
      closedSale('2026-09-28T11:00:00Z', 200, 30),
      buyNowSale('2026-09-29T10:00:00Z', 50, 10),
      buyNowSale('2026-09-30T10:00:00Z', 90, 40),
      cancelled('2026-09-29T09:00:00Z', 25),
      withoutBids('2026-09-30T09:00:00Z', 15),
      active('2026-10-03T08:00:00Z', 5),
      official('2026-09-29T10:00:00Z', 'COP', 1_000_000, 2_000_000),
      official('2026-09-30T10:00:00Z', 'COP', 3_000_000),
      official('2026-10-01T10:00:00Z', 'USD', 5_000, 9_000),
      official('2026-08-01T10:00:00Z', 'EUR', 700), // fuera del periodo
    )

    const result = await prices.execute(query)

    expect(result.credits).toEqual({
      basis: 'FINAL_SALE_PRICE',
      salesCount: 4,
      average: { unit: 'CREDITS', amount: 110 }, // (100 + 200 + 50 + 90) / 4
      median: { unit: 'CREDITS', amount: 95 }, // [50, 90, 100, 200] -> (90 + 100) / 2
      min: { unit: 'CREDITS', amount: 50 },
      max: { unit: 'CREDITS', amount: 200 },
      byChannel: {
        AUCTION_CLOSE: { salesCount: 2, average: { unit: 'CREDITS', amount: 150 } },
        BUY_NOW: { salesCount: 2, average: { unit: 'CREDITS', amount: 70 } },
      },
      // Toda publicacion de jugador del periodo (20+30+10+40+25+15+5) / 7 = 20.714...
      listedMinimumBid: { auctionsCount: 7, average: { unit: 'CREDITS', amount: 20.71 } },
    })
    expect(result.realMoney).toEqual({
      basis: 'LISTED_PRICE',
      note: 'Subasta oficial no tiene flujo de venta: se reporta precio de publicación, no de transacción.',
      finalSalePrice: {
        availability: 'UNAVAILABLE',
        reason: 'OFFICIAL_AUCTION_HAS_NO_SALE_FLOW',
      },
      byCurrency: [
        {
          currency: 'COP',
          publishedCount: 2,
          listedMinimumBid: {
            average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 2_000_000 },
            min: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 1_000_000 },
            max: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 3_000_000 },
          },
          listedBuyNow: {
            count: 1,
            average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 2_000_000 },
          },
        },
        {
          currency: 'USD',
          publishedCount: 1,
          listedMinimumBid: {
            average: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 5_000 },
            min: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 5_000 },
            max: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 5_000 },
          },
          listedBuyNow: {
            count: 1,
            average: { unit: 'REAL_MONEY', currency: 'USD', amountMinor: 9_000 },
          },
        },
      ],
    })
  })

  describe('sin ventas en el periodo', () => {
    it('periodo vacio: todo null (nunca 0), conteos en 0 y sin monedas', async () => {
      const result = await prices.execute(query)

      expect(result.credits).toEqual({
        basis: 'FINAL_SALE_PRICE',
        salesCount: 0,
        average: null,
        median: null,
        min: null,
        max: null,
        byChannel: {
          AUCTION_CLOSE: { salesCount: 0, average: null },
          BUY_NOW: { salesCount: 0, average: null },
        },
        listedMinimumBid: { auctionsCount: 0, average: null },
      })
      expect(result.realMoney.byCurrency).toEqual([])
      expect(result.realMoney.finalSalePrice).toEqual({
        availability: 'UNAVAILABLE',
        reason: 'OFFICIAL_AUCTION_HAS_NO_SALE_FLOW',
      })
    })

    it('hay publicaciones pero ninguna venta: el promedio de venta es null y el de lista no', async () => {
      repository.seed(
        withoutBids('2026-09-28T10:00:00Z', 10),
        withoutBids('2026-09-29T10:00:00Z', 20),
        cancelled('2026-09-30T10:00:00Z', 30),
        active('2026-10-03T10:00:00Z', 40),
      )

      const { credits } = await prices.execute(query)

      expect(credits.salesCount).toBe(0)
      expect(credits.average).toBeNull()
      expect(credits.median).toBeNull()
      expect(credits.min).toBeNull()
      expect(credits.max).toBeNull()
      expect(credits.listedMinimumBid).toEqual({
        auctionsCount: 4,
        average: { unit: 'CREDITS', amount: 25 },
      })
    })

    it('un canal sin ventas queda en null mientras el otro tiene promedio', async () => {
      repository.seed(
        buyNowSale('2026-09-29T10:00:00Z', 70),
        buyNowSale('2026-09-30T10:00:00Z', 30),
      )

      const { credits } = await prices.execute(query)

      expect(credits.byChannel.AUCTION_CLOSE).toEqual({ salesCount: 0, average: null })
      expect(credits.byChannel.BUY_NOW).toEqual({
        salesCount: 2,
        average: { unit: 'CREDITS', amount: 50 },
      })
      expect(credits.average).toEqual({ unit: 'CREDITS', amount: 50 })
    })
  })

  describe('compra inmediata frente a cierre por subasta (R-02)', () => {
    it('la compra inmediata SI entra en el promedio: AVG(final_amount_credits) a secas daria otro numero', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 100),
        // La compra inmediata no tiene `final_amount_credits`; su precio esta en la operacion.
        buyNowSale('2026-09-29T10:00:00Z', 20),
      )

      const { credits } = await prices.execute(query)

      // Solo `final_amount_credits` daria 100; con la compra inmediata es (100 + 20) / 2.
      expect(credits.average).toEqual({ unit: 'CREDITS', amount: 60 })
      expect(credits.salesCount).toBe(2)
    })

    it('cada canal usa SU precio: la compra inmediata no toma el de la subasta ni viceversa', async () => {
      repository.seed(
        { ...closedSale('2026-09-28T10:00:00Z', 100), buyNowPriceCredits: 999 },
        { ...buyNowSale('2026-09-29T10:00:00Z', 20), finalAmountCredits: 999 },
      )

      const { credits } = await prices.execute(query)

      expect(credits.byChannel.AUCTION_CLOSE.average?.amount).toBe(100)
      expect(credits.byChannel.BUY_NOW.average?.amount).toBe(20)
    })
  })

  describe('que entra y que no en el promedio de venta', () => {
    it('canceladas, sin pujas y activas NO entran en el promedio de venta', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 100),
        { ...cancelled('2026-09-28T11:00:00Z'), finalAmountCredits: 5_000 },
        { ...withoutBids('2026-09-28T12:00:00Z'), finalAmountCredits: 5_000 },
        { ...active('2026-10-03T10:00:00Z'), finalAmountCredits: 5_000 },
      )

      const { credits } = await prices.execute(query)

      expect(credits.salesCount).toBe(1)
      expect(credits.average?.amount).toBe(100)
      expect(credits.max?.amount).toBe(100)
    })

    it('las canceladas SI cuentan en el precio de LISTA (se publicaron), igual que en el volumen publicado', async () => {
      repository.seed(cancelled('2026-09-28T10:00:00Z', 50), active('2026-10-03T10:00:00Z', 10))

      const { credits } = await prices.execute(query)

      expect(credits.listedMinimumBid).toEqual({
        auctionsCount: 2,
        average: { unit: 'CREDITS', amount: 30 },
      })
    })

    it('una venta sin precio persistido no es promediable y se excluye en vez de contarse como 0', async () => {
      repository.seed(closedSale('2026-09-28T10:00:00Z', 100), {
        ...closedSale('2026-09-28T11:00:00Z', 0),
        finalAmountCredits: undefined,
      })

      const { credits } = await prices.execute(query)

      expect(credits.salesCount).toBe(1)
      expect(credits.average?.amount).toBe(100)
    })

    it('cada precio se ancla a su timestamp: la venta al cierre, la lista a la publicacion', async () => {
      repository.seed(
        // Publicada ANTES del periodo, vendida DENTRO: entra en ventas, no en lista.
        buyNowSale('2026-09-27T23:00:00Z', 80, 99),
        // Publicada DENTRO, cierra FUERA (despues de `to`): entra en lista, no en ventas.
        {
          ...closedSale('2026-10-03T23:00:00Z', 300, 7),
          finishedAt: at('2026-10-04T23:00:30Z'),
        },
      )

      const { credits } = await prices.execute(query)

      expect(credits.salesCount).toBe(1)
      expect(credits.average?.amount).toBe(80)
      expect(credits.listedMinimumBid).toEqual({
        auctionsCount: 1,
        average: { unit: 'CREDITS', amount: 7 },
      })
    })

    it('el periodo es semiabierto [from, to)', async () => {
      repository.seed(
        { ...closedSale('2026-09-27T00:00:00Z', 10), finishedAt: at('2026-09-28T00:00:00.000Z') },
        { ...closedSale('2026-09-27T00:00:00Z', 20), finishedAt: at('2026-10-04T00:00:00.000Z') },
        { ...closedSale('2026-09-27T00:00:00Z', 30), finishedAt: at('2026-09-27T23:59:59.999Z') },
      )

      const { credits } = await prices.execute(query)

      expect(credits.salesCount).toBe(1)
      expect(credits.average?.amount).toBe(10)
    })
  })

  describe('redondeo', () => {
    it('creditos a 2 decimales half-up: 31 / 3 = 10.33', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 10),
        closedSale('2026-09-28T11:00:00Z', 10),
        closedSale('2026-09-28T12:00:00Z', 11),
      )

      expect((await prices.execute(query)).credits.average).toEqual({
        unit: 'CREDITS',
        amount: 10.33,
      })
    })

    it('creditos: 1.005 se redondea a 1.01 (no 1.00 por el error binario de coma flotante)', async () => {
      // 200 ventas que suman 201 -> 1.005
      repository.seed(
        ...Array.from({ length: 200 }, (_, index) =>
          closedSale(
            `2026-09-28T${String(index % 24).padStart(2, '0')}:00:00Z`,
            index === 0 ? 2 : 1,
          ),
        ),
      )

      expect((await prices.execute(query)).credits.average?.amount).toBe(1.01)
    })

    it('mediana de cantidad par: promedio de los dos centrales (con .5)', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 1),
        closedSale('2026-09-28T11:00:00Z', 2),
        closedSale('2026-09-28T12:00:00Z', 3),
        closedSale('2026-09-28T13:00:00Z', 4),
      )

      const { credits } = await prices.execute(query)

      expect(credits.median).toEqual({ unit: 'CREDITS', amount: 2.5 })
      expect(credits.average).toEqual({ unit: 'CREDITS', amount: 2.5 })
    })

    it('mediana de cantidad impar: el valor central', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 5),
        closedSale('2026-09-28T11:00:00Z', 900),
        closedSale('2026-09-28T12:00:00Z', 7),
      )

      expect((await prices.execute(query)).credits.median?.amount).toBe(7)
    })

    it('dinero real: entero de unidad minima, half-up (2.5 -> 3, 2.33 -> 2)', async () => {
      repository.seed(
        official('2026-09-28T10:00:00Z', 'COP', 1),
        official('2026-09-28T11:00:00Z', 'COP', 4), // promedio 2.5 -> 3
        official('2026-09-28T12:00:00Z', 'USD', 1),
        official('2026-09-28T13:00:00Z', 'USD', 1),
        official('2026-09-28T14:00:00Z', 'USD', 5), // promedio 2.33 -> 2
      )

      const { byCurrency } = (await prices.execute(query)).realMoney

      expect(
        byCurrency.map((entry) => [entry.currency, entry.listedMinimumBid.average.amountMinor]),
      ).toEqual([
        ['COP', 3],
        ['USD', 2],
      ])
      expect(
        byCurrency.every((entry) => Number.isInteger(entry.listedMinimumBid.average.amountMinor)),
      ).toBe(true)
    })

    it('listedBuyNow promedia solo las publicaciones que lo definieron; sin ninguna, average es null', async () => {
      repository.seed(
        official('2026-09-28T10:00:00Z', 'COP', 100, 1),
        official('2026-09-28T11:00:00Z', 'COP', 100, 2), // promedio 1.5 -> 2
        official('2026-09-28T12:00:00Z', 'COP', 100), // sin compra inmediata
        official('2026-09-28T13:00:00Z', 'USD', 100), // ninguna con compra inmediata
      )

      const { byCurrency } = (await prices.execute(query)).realMoney

      expect(byCurrency[0]?.listedBuyNow).toEqual({
        count: 2,
        average: { unit: 'REAL_MONEY', currency: 'COP', amountMinor: 2 },
      })
      expect(byCurrency[1]?.listedBuyNow).toEqual({ count: 0, average: null })
      // El precio minimo promedia TODAS las publicaciones de la moneda, tengan o no compra inmediata.
      expect(byCurrency[0]?.publishedCount).toBe(3)
    })
  })

  describe('separacion creditos / dinero real (CA-03)', () => {
    it('las oficiales nunca entran en los creditos y las de jugador nunca en el dinero real', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 100, 20),
        official('2026-09-28T11:00:00Z', 'COP', 9_999_999, 9_999_999),
      )

      const result = await prices.execute(query)

      expect(result.credits.salesCount).toBe(1)
      expect(result.credits.average?.amount).toBe(100)
      expect(result.credits.listedMinimumBid.auctionsCount).toBe(1)
      expect(result.credits.listedMinimumBid.average?.amount).toBe(20)
      expect(result.realMoney.byCurrency).toHaveLength(1)
      expect(result.realMoney.byCurrency[0]?.publishedCount).toBe(1)
    })

    it('varias monedas: una entrada por moneda, ordenadas por currency ASC y sin sumar entre monedas', async () => {
      repository.seed(
        official('2026-09-28T10:00:00Z', 'USD', 1_000),
        official('2026-09-28T11:00:00Z', 'COP', 4_000_000),
        official('2026-09-28T12:00:00Z', 'EUR', 800),
        official('2026-09-28T13:00:00Z', 'COP', 6_000_000),
      )

      const { byCurrency } = (await prices.execute(query)).realMoney

      expect(byCurrency.map((entry) => entry.currency)).toEqual(['COP', 'EUR', 'USD'])
      expect(byCurrency.map((entry) => entry.listedMinimumBid.average.amountMinor)).toEqual([
        5_000_000, 800, 1_000,
      ])
      // Cada importe lleva la unidad y la moneda de SU entrada: nada mezclado.
      for (const entry of byCurrency) {
        for (const amount of [
          entry.listedMinimumBid.average,
          entry.listedMinimumBid.min,
          entry.listedMinimumBid.max,
        ]) {
          expect(amount).toMatchObject({ unit: 'REAL_MONEY', currency: entry.currency })
        }
      }
    })

    it('ningun campo mezcla ramas: creditos solo `CREDITS`, dinero real solo `REAL_MONEY`', async () => {
      repository.seed(
        closedSale('2026-09-28T10:00:00Z', 100),
        official('2026-09-28T11:00:00Z', 'COP', 5_000, 8_000),
      )

      const result = await prices.execute(query)
      const units = (branch: unknown): string[] =>
        [...JSON.stringify(branch).matchAll(/"unit":"([A-Z_]+)"/g)].map((match) => match[1] ?? '')

      expect(new Set(units(result.credits))).toEqual(new Set(['CREDITS']))
      expect(new Set(units(result.realMoney))).toEqual(new Set(['REAL_MONEY']))
    })
  })

  it('idempotencia: sembrar dos veces la misma subasta no duplica ni cambia ninguna cifra', async () => {
    const sale = closedSale('2026-09-28T10:00:00Z', 100)
    const bought = buyNowSale('2026-09-29T10:00:00Z', 40)
    const listing = official('2026-09-29T11:00:00Z', 'COP', 1_000, 2_000)
    repository.seed(sale, bought, listing)
    const once = await prices.execute(query)

    repository.seed(sale, sale, bought, listing, listing)

    expect(await prices.execute(query)).toEqual(once)
  })

  it('envoltorio del contrato: definitionsVersion, periodo UTC y asOf', async () => {
    const result = await prices.execute(query)

    expect(result).toMatchObject({
      definitionsVersion: 'hu-91.v1',
      period: {
        from: '2026-09-28T00:00:00.000Z',
        to: '2026-10-04T00:00:00.000Z',
        timezone: 'UTC',
        bounds: '[from,to)',
      },
      asOf: '2026-10-04T12:00:00.000Z',
    })
    expect(Object.keys(result).sort()).toEqual([
      'asOf',
      'credits',
      'definitionsVersion',
      'period',
      'realMoney',
    ])
  })

  it('un periodo invalido propaga INVALID_PERIOD', async () => {
    await expect(prices.execute({ from: 'x' })).rejects.toMatchObject({ code: 'INVALID_PERIOD' })
    await expect(
      prices.execute({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_PERIOD' })
  })
})
