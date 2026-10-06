import {
  InMemoryAuctionMetricsRepository,
  type MetricsAuctionFact,
} from '../../src/adapters/outbound/persistence/InMemoryAuctionMetricsRepository'
import { COUNT_BIDS_ON_CANCELLED_AUCTIONS } from '../../src/application/ports/AuctionMetricsRepositoryPort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { GetAuctionUsersAndCommissions } from '../../src/application/use-cases/GetAuctionUsersAndCommissions'

const asOf = new Date('2026-10-04T12:00:00.000Z')
const clock: ClockPort = { now: () => asOf }
const query = { from: '2026-09-28T00:00:00Z', to: '2026-10-04T00:00:00Z' }
const HOUR = 3_600_000
const at = (iso: string): Date => new Date(iso)
let sequence = 0

type Refund = NonNullable<MetricsAuctionFact['cancellation']>

interface Build {
  readonly seller?: string
  readonly hours?: 24 | 48
  readonly status?: MetricsAuctionFact['status']
  readonly bids?: readonly { readonly bidderId: string; readonly placedAt: string }[]
  readonly buyer?: string
  readonly buyNowAt?: string
  readonly cancelledAt?: string
  readonly cancellation?: Refund
}

const FEE: Record<24 | 48, number> = { 24: 1, 48: 3 }

/** Subasta de jugador publicada en `publishedAt`, con vendedor, pujas, comprador y cancelacion. */
const auction = (publishedAt: string, build: Build = {}): MetricsAuctionFact => {
  const hours = build.hours ?? 24
  return {
    id: `auction-${String(++sequence)}`,
    priceKind: 'CREDITS',
    status: build.status ?? 'ACTIVE',
    publishedAt: at(publishedAt),
    closesAt: new Date(at(publishedAt).getTime() + hours * HOUR),
    ...(build.seller === undefined ? {} : { sellerId: build.seller }),
    durationHours: hours,
    publicationFeeCredits: FEE[hours],
    ...(build.bids === undefined
      ? {}
      : {
          bids: build.bids.map((bid) => ({ bidderId: bid.bidderId, placedAt: at(bid.placedAt) })),
        }),
    ...(build.buyer === undefined ? {} : { buyerId: build.buyer }),
    ...(build.buyNowAt === undefined ? {} : { buyNowCompletedAt: at(build.buyNowAt) }),
    ...(build.cancelledAt === undefined ? {} : { cancelledAt: at(build.cancelledAt) }),
    ...(build.cancellation === undefined ? {} : { cancellation: build.cancellation }),
  }
}

const manualRefund = (
  amount: 0.5 | 1.5,
  status: Refund['walletRefundStatus'] = 'CONFIRMED',
): Refund => ({ refundAmountCredits: amount, walletRefundStatus: status })

const automatic: Refund = { refundAmountCredits: 0, walletRefundStatus: 'NOT_REQUIRED' }

const bidsBy = (bidderId: string, ...times: string[]) =>
  times.map((placedAt) => ({ bidderId, placedAt }))

/** El escenario completo de la prueba de cifras absolutas (ver comentarios por subasta). */
const scenario = (): MetricsAuctionFact[] => [
  // A1: S1 vende (24h); B1 puja 3 veces y B2 una.
  auction('2026-09-28T10:00:00Z', {
    seller: 'S1',
    status: 'FINISHED',
    bids: [
      ...bidsBy('B1', '2026-09-28T10:10:00Z', '2026-09-28T10:20:00Z', '2026-09-28T10:30:00Z'),
      ...bidsBy('B2', '2026-09-28T10:40:00Z'),
    ],
  }),
  // A2: S1 vende (48h); B1 puja y luego compra de inmediato (cuenta UNA subasta).
  auction('2026-09-29T10:00:00Z', {
    seller: 'S1',
    hours: 48,
    status: 'SOLD',
    bids: bidsBy('B1', '2026-09-29T11:00:00Z'),
    buyer: 'B1',
    buyNowAt: '2026-09-29T12:00:00Z',
  }),
  // A3: S2 (24h), cancelada manual, reembolso 0.5 CONFIRMADO.
  auction('2026-09-30T10:00:00Z', {
    seller: 'S2',
    status: 'CANCELLED',
    cancelledAt: '2026-09-30T11:00:00Z',
    cancellation: manualRefund(0.5),
  }),
  // A4: S2 (48h), cancelada manual, reembolso 1.5 PENDIENTE.
  auction('2026-10-01T10:00:00Z', {
    seller: 'S2',
    hours: 48,
    status: 'CANCELLED',
    cancelledAt: '2026-10-01T11:00:00Z',
    cancellation: manualRefund(1.5, 'PENDING'),
  }),
  // A5: S3 (24h), cancelada AUTOMATICA CON PUJAS (B3 x2, B2 x1); no reembolsa.
  auction('2026-10-02T10:00:00Z', {
    seller: 'S3',
    status: 'CANCELLED',
    cancelledAt: '2026-10-02T12:00:00Z',
    cancellation: automatic,
    bids: [
      ...bidsBy('B3', '2026-10-02T10:30:00Z', '2026-10-02T10:40:00Z'),
      ...bidsBy('B2', '2026-10-02T11:00:00Z'),
    ],
  }),
  // A6: S3 (24h), activa, B2 puja dos veces.
  auction('2026-10-03T10:00:00Z', {
    seller: 'S3',
    bids: bidsBy('B2', '2026-10-03T10:30:00Z', '2026-10-03T10:40:00Z'),
  }),
  // A7: S4 (48h), cancelada manual, reembolso 1.5 REINTENTABLE (pendiente).
  auction('2026-10-01T11:00:00Z', {
    seller: 'S4',
    hours: 48,
    status: 'CANCELLED',
    cancelledAt: '2026-10-01T12:00:00Z',
    cancellation: manualRefund(1.5, 'RETRYABLE'),
  }),
  // A8: S4 (24h), cancelada manual, reembolso fallido TERMINAL (ni reembolsado ni pendiente).
  auction('2026-10-02T11:00:00Z', {
    seller: 'S4',
    status: 'CANCELLED',
    cancelledAt: '2026-10-02T12:00:00Z',
    cancellation: manualRefund(0.5, 'TERMINAL_ERROR'),
  }),
  // A9: publicada ANTES del periodo; solo la puja de B4 cae dentro. S5 no cuenta.
  auction('2026-09-20T10:00:00Z', {
    seller: 'S5',
    status: 'FINISHED',
    bids: bidsBy('B4', '2026-09-28T09:00:00Z'),
  }),
  // A10: publicada justo ANTES del periodo (48h: la cancelacion manual exige > 6h para el cierre)
  // y cancelada DENTRO con reembolso 1.5 CONFIRMADO.
  auction('2026-09-27T12:00:00Z', {
    seller: 'S6',
    hours: 48,
    status: 'CANCELLED',
    cancelledAt: '2026-09-28T02:00:00Z',
    cancellation: manualRefund(1.5),
  }),
  // Oficial (dinero real): su publicador no es un usuario del mercado y no cobra comision.
  {
    id: 'official-1',
    priceKind: 'REAL_MONEY',
    status: 'ACTIVE',
    publishedAt: at('2026-09-29T09:00:00Z'),
    closesAt: at('2026-09-30T09:00:00Z'),
    sellerId: 'GM',
    durationHours: 24,
    publicationFeeCredits: 0,
    currency: 'COP',
    minimumBidAmountMinor: 90_000,
  },
]

describe('HU-91.5 usuarios activos y comisiones (contrato hu-91.v1 §3.2 / §3.4 / §4.4)', () => {
  let repository: InMemoryAuctionMetricsRepository
  let report: GetAuctionUsersAndCommissions

  beforeEach(() => {
    sequence = 0
    repository = new InMemoryAuctionMetricsRepository()
    report = new GetAuctionUsersAndCommissions(repository, clock)
  })

  describe('usuarios activos', () => {
    it('cifras absolutas: cuenta SUBASTAS distintas por usuario y ordena activeAuctions DESC, playerId ASC', async () => {
      repository.seed(...scenario())

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.definition).toBe('DISTINCT_AUCTIONS_WITH_SELLER_BIDDER_OR_BUYER_ACTION')
      expect(activeUsers.totalActiveUsers).toBe(8) // S1 S2 S3 S4 B1 B2 B3 B4
      expect(activeUsers.byRole).toEqual({ sellers: 4, bidders: 4, buyers: 1 })
      expect(activeUsers.top).toEqual([
        { rank: 1, playerId: 'B2', activeAuctions: 3, asSeller: 0, asBidder: 3, asBuyer: 0 },
        { rank: 2, playerId: 'B1', activeAuctions: 2, asSeller: 0, asBidder: 2, asBuyer: 1 },
        { rank: 3, playerId: 'S1', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
        { rank: 4, playerId: 'S2', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
        { rank: 5, playerId: 'S3', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
        { rank: 6, playerId: 'S4', activeAuctions: 2, asSeller: 2, asBidder: 0, asBuyer: 0 },
        { rank: 7, playerId: 'B3', activeAuctions: 1, asSeller: 0, asBidder: 1, asBuyer: 0 },
        { rank: 8, playerId: 'B4', activeAuctions: 1, asSeller: 0, asBidder: 1, asBuyer: 0 },
      ])
    })

    it('50 pujas del mismo usuario en UNA subasta cuentan una subasta, no 50 (auto-pujas no inflan)', async () => {
      const times = Array.from(
        { length: 50 },
        (_, index) => `2026-09-28T10:${String(index).padStart(2, '0')}:00Z`,
      )
      repository.seed(auction('2026-09-28T09:00:00Z', { seller: 'S', bids: bidsBy('B', ...times) }))

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.find((user) => user.playerId === 'B')).toMatchObject({
        activeAuctions: 1,
        asBidder: 1,
      })
    })

    it('un reintento idempotente (la misma puja repetida) no suma actividad', async () => {
      const bid = { bidderId: 'B', placedAt: at('2026-09-28T10:10:00Z') }
      repository.seed({
        ...auction('2026-09-28T09:00:00Z', { seller: 'S' }),
        bids: [bid, bid, bid],
      })

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.find((user) => user.playerId === 'B')?.activeAuctions).toBe(1)
    })

    it('el mismo usuario en TRES roles: una identidad, tres subastas, y cada rol por separado', async () => {
      repository.seed(
        auction('2026-09-28T10:00:00Z', { seller: 'U' }), // U vende
        auction('2026-09-29T10:00:00Z', {
          seller: 'V',
          bids: bidsBy('U', '2026-09-29T11:00:00Z'),
        }), // U puja
        auction('2026-09-30T10:00:00Z', {
          seller: 'V',
          status: 'SOLD',
          buyer: 'U',
          buyNowAt: '2026-09-30T12:00:00Z',
        }), // U compra
      )

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.find((user) => user.playerId === 'U')).toEqual({
        rank: expect.any(Number) as number,
        playerId: 'U',
        activeAuctions: 3,
        asSeller: 1,
        asBidder: 1,
        asBuyer: 1,
      })
      // Dos identidades en total (U y V) aunque U cumple los tres roles.
      expect(activeUsers.totalActiveUsers).toBe(2)
      expect(activeUsers.byRole).toEqual({ sellers: 2, bidders: 1, buyers: 1 })
    })

    it('pujar Y comprar la MISMA subasta cuenta una subasta pero ambos roles (asBidder + asBuyer > activeAuctions)', async () => {
      repository.seed(
        auction('2026-09-28T10:00:00Z', {
          seller: 'S',
          status: 'SOLD',
          bids: bidsBy('B', '2026-09-28T10:30:00Z'),
          buyer: 'B',
          buyNowAt: '2026-09-28T11:00:00Z',
        }),
      )

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.find((user) => user.playerId === 'B')).toMatchObject({
        activeAuctions: 1,
        asBidder: 1,
        asBuyer: 1,
      })
    })

    it('limit recorta el ranking pero NO el total ni byRole; defecto 10', async () => {
      repository.seed(
        ...Array.from({ length: 12 }, (_, index) =>
          auction(`2026-09-28T${String(index).padStart(2, '0')}:00:00Z`, {
            seller: `U${String(index).padStart(2, '0')}`,
          }),
        ),
      )

      const byDefault = await report.execute(query)
      const two = await report.execute({ ...query, limit: '2' })

      expect(byDefault.limit).toBe(10)
      expect(byDefault.activeUsers.top).toHaveLength(10)
      expect(byDefault.activeUsers.totalActiveUsers).toBe(12)
      expect(two.limit).toBe(2)
      expect(two.activeUsers.top.map((user) => user.playerId)).toEqual(['U00', 'U01'])
      expect(two.activeUsers.totalActiveUsers).toBe(12)
      expect(two.activeUsers.byRole.sellers).toBe(12)
    })

    it('EMPATE: desempata por playerId ASC en orden de bytes, estable sin importar el orden de insercion', async () => {
      const facts = ['zeta', 'alfa', 'Beta', 'mu'].map((seller, index) =>
        auction(`2026-09-28T1${String(index)}:00:00Z`, { seller }),
      )
      repository.seed(...facts)
      const first = await report.execute(query)
      const reversed = new InMemoryAuctionMetricsRepository()
      reversed.seed(...[...facts].reverse())

      const second = await new GetAuctionUsersAndCommissions(reversed, clock).execute(query)

      expect(first.activeUsers.top.map((user) => user.playerId)).toEqual([
        'Beta',
        'alfa',
        'mu',
        'zeta',
      ])
      expect(second.activeUsers.top).toEqual(first.activeUsers.top)
    })

    it('rechaza limit fuera de 1..50 o no entero con INVALID_PARAMETER', async () => {
      for (const limit of ['0', '51', '-1', '1.5', 'abc', '']) {
        await expect(report.execute({ ...query, limit })).rejects.toMatchObject({
          code: 'INVALID_PARAMETER',
        })
      }
    })

    it('las oficiales (dinero real) no generan usuarios activos: su publicador no cuenta', async () => {
      repository.seed(...scenario())

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.some((user) => user.playerId === 'GM')).toBe(false)
    })

    it('cada accion se ancla a SU timestamp: publicacion, puja y compra inmediata', async () => {
      repository.seed(
        // Publicada ANTES; su puja y su compra caen DENTRO -> el vendedor NO cuenta, los otros SI.
        auction('2026-09-20T10:00:00Z', {
          seller: 'S-fuera',
          status: 'SOLD',
          bids: bidsBy('B-dentro', '2026-09-28T09:00:00Z'),
          buyer: 'C-dentro',
          buyNowAt: '2026-09-29T10:00:00Z',
        }),
        // Publicada DENTRO; su puja cae DESPUES de `to` -> el vendedor SI, el postor NO.
        auction('2026-10-03T10:00:00Z', {
          seller: 'S-dentro',
          bids: bidsBy('B-fuera', '2026-10-04T00:00:00.000Z'),
        }),
      )

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.map((user) => user.playerId).sort()).toEqual([
        'B-dentro',
        'C-dentro',
        'S-dentro',
      ])
    })

    it('el periodo es semiabierto [from, to): from incluido y to excluido', async () => {
      repository.seed(
        auction('2026-09-28T00:00:00.000Z', { seller: 'en-from' }),
        auction('2026-10-04T00:00:00.000Z', { seller: 'en-to' }),
        auction('2026-09-27T23:59:59.999Z', { seller: 'antes' }),
      )

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.map((user) => user.playerId)).toEqual(['en-from'])
    })

    it('expone solo el sub opaco y los conteos: ningun nombre, correo ni saldo', async () => {
      repository.seed(...scenario())

      const { activeUsers } = await report.execute(query)

      for (const user of activeUsers.top) {
        expect(Object.keys(user).sort()).toEqual([
          'activeAuctions',
          'asBidder',
          'asBuyer',
          'asSeller',
          'playerId',
          'rank',
        ])
      }
    })
  })

  describe('REGLA ABIERTA: pujas en subastas canceladas (HU-90 CA-05)', () => {
    const cancelledWithBids = (): MetricsAuctionFact[] => [
      auction('2026-10-02T10:00:00Z', {
        seller: 'S',
        status: 'CANCELLED',
        cancelledAt: '2026-10-02T12:00:00Z',
        cancellation: automatic,
        bids: bidsBy('B', '2026-10-02T10:30:00Z', '2026-10-02T10:40:00Z'),
      }),
    ]

    it('la constante vigente es la definicion literal: las pujas en canceladas CUENTAN', () => {
      expect(COUNT_BIDS_ON_CANCELLED_AUCTIONS).toBe(true)
    })

    it('COMPORTAMIENTO ACTUAL: el postor de una subasta cancelada cuenta como activo', async () => {
      repository.seed(...cancelledWithBids())

      const { activeUsers } = await report.execute(query)

      expect(activeUsers.top.map((user) => [user.playerId, user.asBidder])).toEqual([
        ['B', 1],
        ['S', 0],
      ])
      expect(activeUsers.byRole.bidders).toBe(1)
    })

    it('con la regla en false las pujas en canceladas se excluyen, pero el VENDEDOR sigue contando', async () => {
      const strict = new InMemoryAuctionMetricsRepository({ countBidsOnCancelledAuctions: false })
      strict.seed(...cancelledWithBids())

      const { activeUsers } = await new GetAuctionUsersAndCommissions(strict, clock).execute(query)

      expect(activeUsers.byRole).toEqual({ sellers: 1, bidders: 0, buyers: 0 })
      expect(activeUsers.top.map((user) => user.playerId)).toEqual(['S'])
    })

    it('la regla solo afecta a las CANCELADAS: las pujas en subastas activas o cerradas cuentan igual', async () => {
      const strict = new InMemoryAuctionMetricsRepository({ countBidsOnCancelledAuctions: false })
      strict.seed(
        auction('2026-10-02T10:00:00Z', { seller: 'S', bids: bidsBy('B', '2026-10-02T10:30:00Z') }),
        auction('2026-10-03T10:00:00Z', {
          seller: 'S',
          status: 'FINISHED',
          bids: bidsBy('C', '2026-10-03T10:30:00Z'),
        }),
      )

      const { activeUsers } = await new GetAuctionUsersAndCommissions(strict, clock).execute(query)

      expect(activeUsers.byRole.bidders).toBe(2)
    })
  })

  describe('comisiones de publicacion', () => {
    it('cifras absolutas: bruto - reembolsado = neto, con pendientes, por duracion', async () => {
      repository.seed(...scenario())

      const { commissions } = await report.execute(query)

      expect(commissions).toEqual({
        scope: 'PUBLICATION_FEE_ONLY',
        unit: 'CREDITS',
        source: 'AUCTION_LOCAL',
        // 24h: A1 A3 A5 A6 A8 = 5 x 1;  48h: A2 A4 A7 = 3 x 3  -> 5 + 9
        gross: { unit: 'CREDITS', amount: 14 },
        // CONFIRMED con cancelled_at en el periodo: A3 (0.5) + A10 (1.5); A5 es NOT_REQUIRED
        refunded: { unit: 'CREDITS', amount: 2 },
        net: { unit: 'CREDITS', amount: 12 },
        // PENDING A4 (1.5) + RETRYABLE A7 (1.5); A8 TERMINAL_ERROR no es pendiente
        pendingRefunds: { count: 2, amount: { unit: 'CREDITS', amount: 3 } },
        byDuration: [
          {
            durationHours: 24,
            auctions: 5,
            feePerAuction: 1,
            gross: { unit: 'CREDITS', amount: 5 },
          },
          {
            durationHours: 48,
            auctions: 3,
            feePerAuction: 3,
            gross: { unit: 'CREDITS', amount: 9 },
          },
        ],
        salesCommission: { availability: 'UNAVAILABLE', reason: 'NO_SALE_COMMISSION_DEFINED' },
        realMoneyCommission: {
          availability: 'UNAVAILABLE',
          reason: 'OFFICIAL_AUCTION_HAS_NO_FEES',
        },
        walletReconciliation: {
          availability: 'UNAVAILABLE',
          reason: 'WALLET_READ_ENDPOINT_NOT_AVAILABLE',
        },
      })
    })

    it('la cancelacion AUTOMATICA no reembolsa: su comision sigue en el bruto y el neto, y no es pendiente', async () => {
      repository.seed(
        auction('2026-10-02T10:00:00Z', {
          seller: 'S',
          hours: 48,
          status: 'CANCELLED',
          cancelledAt: '2026-10-02T12:00:00Z',
          cancellation: automatic,
        }),
      )

      const { commissions } = await report.execute(query)

      expect(commissions.gross.amount).toBe(3)
      expect(commissions.refunded.amount).toBe(0)
      expect(commissions.net.amount).toBe(3)
      expect(commissions.pendingRefunds).toEqual({
        count: 0,
        amount: { unit: 'CREDITS', amount: 0 },
      })
    })

    it('un reembolso TERMINAL_ERROR nunca se acredito: la comision sigue cobrada y no hay pendiente', async () => {
      repository.seed(
        auction('2026-10-02T10:00:00Z', {
          seller: 'S',
          status: 'CANCELLED',
          cancelledAt: '2026-10-02T12:00:00Z',
          cancellation: manualRefund(0.5, 'TERMINAL_ERROR'),
        }),
      )

      const { commissions } = await report.execute(query)

      expect([
        commissions.gross.amount,
        commissions.refunded.amount,
        commissions.net.amount,
      ]).toEqual([1, 0, 1])
      expect(commissions.pendingRefunds.count).toBe(0)
    })

    it('el neto puede ser NEGATIVO: reembolso de una publicacion hecha justo antes del periodo', async () => {
      repository.seed(
        auction('2026-09-27T12:00:00Z', {
          seller: 'S',
          hours: 48,
          status: 'CANCELLED',
          cancelledAt: '2026-09-28T02:00:00Z',
          cancellation: manualRefund(1.5),
        }),
      )

      const { commissions } = await report.execute(query)

      expect(commissions.gross.amount).toBe(0)
      expect(commissions.refunded.amount).toBe(1.5)
      expect(commissions.net).toEqual({ unit: 'CREDITS', amount: -1.5 })
    })

    it('aritmetica exacta: 200 reembolsos de 0.5 y 1.5 suman 200 sin deriva de coma flotante', async () => {
      repository.seed(
        ...Array.from({ length: 200 }, (_, index) =>
          auction('2026-09-28T10:00:00Z', {
            seller: `S${String(index)}`,
            status: 'CANCELLED',
            cancelledAt: '2026-09-29T10:00:00Z',
            cancellation: manualRefund(index % 2 === 0 ? 0.5 : 1.5),
          }),
        ),
      )

      const { commissions } = await report.execute(query)

      expect(commissions.refunded.amount).toBe(200) // 100 x 0.5 + 100 x 1.5
      expect(commissions.gross.amount).toBe(200) // 200 x 1
      expect(commissions.net.amount).toBe(0)
    })

    it('los importes con decimales no acumulan error: 3 x 0.5 = 1.5 y 1 - 0.5 = 0.5 exactos', async () => {
      repository.seed(
        ...[1, 2, 3].map(() =>
          auction('2026-09-28T10:00:00Z', {
            seller: 'S',
            status: 'CANCELLED',
            cancelledAt: '2026-09-29T10:00:00Z',
            cancellation: manualRefund(0.5),
          }),
        ),
      )

      const { commissions } = await report.execute(query)

      expect(commissions.refunded.amount).toBe(1.5)
      expect(commissions.net.amount).toBe(1.5) // 3 - 1.5
    })

    it('SIN DATOS: las sumas valen 0 (no null), ambas duraciones se listan y la tarifa viene del dominio', async () => {
      const { commissions, activeUsers } = await report.execute(query)

      expect(activeUsers).toEqual({
        definition: 'DISTINCT_AUCTIONS_WITH_SELLER_BIDDER_OR_BUYER_ACTION',
        totalActiveUsers: 0,
        byRole: { sellers: 0, bidders: 0, buyers: 0 },
        top: [],
      })
      expect(commissions.gross).toEqual({ unit: 'CREDITS', amount: 0 })
      expect(commissions.refunded).toEqual({ unit: 'CREDITS', amount: 0 })
      expect(commissions.net).toEqual({ unit: 'CREDITS', amount: 0 })
      expect(commissions.pendingRefunds).toEqual({
        count: 0,
        amount: { unit: 'CREDITS', amount: 0 },
      })
      expect(commissions.byDuration).toEqual([
        { durationHours: 24, auctions: 0, feePerAuction: 1, gross: { unit: 'CREDITS', amount: 0 } },
        { durationHours: 48, auctions: 0, feePerAuction: 3, gross: { unit: 'CREDITS', amount: 0 } },
      ])
    })

    it('una sola duracion con datos: la otra aparece con 0 publicaciones', async () => {
      repository.seed(auction('2026-09-28T10:00:00Z', { seller: 'S', hours: 48 }))

      const { commissions } = await report.execute(query)

      expect(commissions.byDuration).toEqual([
        { durationHours: 24, auctions: 0, feePerAuction: 1, gross: { unit: 'CREDITS', amount: 0 } },
        { durationHours: 48, auctions: 1, feePerAuction: 3, gross: { unit: 'CREDITS', amount: 3 } },
      ])
    })

    it('las oficiales no cobran comision y no entran en el bruto ni en las duraciones', async () => {
      repository.seed(...scenario().filter((fact) => fact.priceKind === 'REAL_MONEY'))

      const { commissions } = await report.execute(query)

      expect(commissions.gross.amount).toBe(0)
      expect(commissions.byDuration.every((row) => row.auctions === 0)).toBe(true)
    })

    it('cada importe se ancla a su timestamp: bruto a la publicacion, reembolso a la cancelacion', async () => {
      repository.seed(
        // Publicada DENTRO y cancelada DESPUES de `to`: bruto si, reembolso no.
        auction('2026-10-03T10:00:00Z', {
          seller: 'S',
          status: 'CANCELLED',
          cancelledAt: '2026-10-05T00:00:00Z',
          cancellation: manualRefund(1.5),
        }),
        // Publicada ANTES y cancelada DENTRO: bruto no, reembolso si.
        auction('2026-09-27T12:00:00Z', {
          seller: 'T',
          hours: 48,
          status: 'CANCELLED',
          cancelledAt: '2026-09-28T10:00:00Z',
          cancellation: manualRefund(0.5),
        }),
      )

      const { commissions } = await report.execute(query)

      expect(commissions.gross.amount).toBe(1)
      expect(commissions.refunded.amount).toBe(0.5)
      expect(commissions.net.amount).toBe(0.5)
    })
  })

  it('idempotencia: sembrar dos veces las mismas subastas no cambia ninguna cifra', async () => {
    const facts = scenario()
    repository.seed(...facts)
    const once = await report.execute(query)

    repository.seed(...facts, ...facts)

    expect(await report.execute(query)).toEqual(once)
  })

  it('envoltorio del contrato: definitionsVersion, periodo UTC, asOf y limit', async () => {
    const result = await report.execute(query)

    expect(result).toMatchObject({
      definitionsVersion: 'hu-91.v1',
      period: {
        from: '2026-09-28T00:00:00.000Z',
        to: '2026-10-04T00:00:00.000Z',
        timezone: 'UTC',
        bounds: '[from,to)',
      },
      asOf: '2026-10-04T12:00:00.000Z',
      limit: 10,
    })
    expect(Object.keys(result).sort()).toEqual([
      'activeUsers',
      'asOf',
      'commissions',
      'definitionsVersion',
      'limit',
      'period',
    ])
  })

  it('un periodo invalido propaga INVALID_PERIOD', async () => {
    await expect(report.execute({ from: 'x' })).rejects.toMatchObject({ code: 'INVALID_PERIOD' })
  })
})
