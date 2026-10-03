import {
  Auction,
  AuctionClosingOutcome,
  AuctionStatus,
  CANCELLATION_WINDOW_MS,
  type RehydrateAuctionInput,
} from '../../src/domain/entities/Auction'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'

const publishedAt = new Date('2026-09-21T12:00:00.000Z')
const closesAt = new Date('2026-09-22T12:00:00.000Z')

const validInput = () => ({
  auctionId: 'auction-90-1',
  sellerId: 'seller-1',
  productId: 'product-1',
  durationHours: 24,
  minimumBidCredits: 10,
  buyNowCredits: 20,
  publishedAt,
  eligibility: {
    productOwnedBySeller: true,
    productInUse: false,
    productTradable: true,
    sellerHasActiveSanctions: false,
    activeAuctionCount: 0,
  },
})

const activeAuction = (): Auction => Auction.publish(validInput())

const expectRule = (code: AuctionRuleCode, action: () => unknown): void => {
  try {
    action()
    throw new Error(`Se esperaba la regla ${code}.`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuctionRuleViolation)
    expect((error as AuctionRuleViolation).code).toBe(code)
  }
}

/** HU-90, `7.7.10`. Ver reporte final seccion 24 para la numeracion de casos. */
describe('Auction.cancel (HU-90)', () => {
  // 1. ACTIVE, 0 pujas, 6h + 1ms -> cancela.
  it('cancela con mas de 6 horas restantes exactas', () => {
    const auction = activeAuction()
    const now = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS - 1)

    const cancelledAt = auction.cancel({ now, bidCount: 0 })

    expect(auction.status).toBe(AuctionStatus.Cancelled)
    expect(cancelledAt).toEqual(now)
    expect(auction.cancelledAt).toEqual(now)
  })

  // 2. Exactamente 6h -> rechazo.
  it('rechaza cancelar exactamente a las 6 horas del cierre', () => {
    const auction = activeAuction()
    const now = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS)

    expectRule(AuctionRuleCode.AuctionCancellationWindowClosed, () =>
      auction.cancel({ now, bidCount: 0 }),
    )
    expect(auction.status).toBe(AuctionStatus.Active)
  })

  // 3. 6h - 1ms -> rechazo.
  it('rechaza cancelar con 6 horas menos 1ms restantes', () => {
    const auction = activeAuction()
    const now = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS + 1)

    expectRule(AuctionRuleCode.AuctionCancellationWindowClosed, () =>
      auction.cancel({ now, bidCount: 0 }),
    )
  })

  // 4. bidCount 1 -> rechazo.
  it('rechaza cancelar si bidCount es mayor a cero', () => {
    const auction = activeAuction()
    const now = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS - 1)

    expectRule(AuctionRuleCode.AuctionHasBids, () => auction.cancel({ now, bidCount: 1 }))
    expect(auction.status).toBe(AuctionStatus.Active)
  })

  // 6. FINISHED -> rechazo.
  it('rechaza cancelar una subasta ya finalizada', () => {
    const auction = activeAuction()
    auction.finish({ finishedAt: closesAt, leadingBid: null })

    expectRule(AuctionRuleCode.AuctionNotActive, () =>
      auction.cancel({ now: closesAt, bidCount: 0 }),
    )
  })

  // 7. SOLD -> rechazo. `Auction` no tiene un metodo `sell`; se reproduce el
  // estado terminal directamente via rehydrate, igual que otros tests de
  // este archivo construyen estados persistidos.
  it('rechaza cancelar una subasta vendida por compra inmediata', () => {
    const auction = Auction.rehydrate({
      ...activeAuction().snapshot(),
      status: AuctionStatus.SoldByBuyNow,
      finishedAt: null,
      closingResult: null,
      cancelledAt: null,
    })

    expectRule(AuctionRuleCode.AuctionNotActive, () =>
      auction.cancel({ now: closesAt, bidCount: 0 }),
    )
  })

  // 8. CANCELLED -> rechazo de una segunda cancelacion sobre el MISMO
  // agregado en memoria (replay/idempotencia real se prueba en el caso de
  // uso y en el repositorio; el dominio solo debe negarse a cancelar dos
  // veces el mismo objeto).
  it('rechaza cancelar una subasta que el propio agregado ya cancelo', () => {
    const auction = activeAuction()
    const now = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS - 1)
    auction.cancel({ now, bidCount: 0 })

    expectRule(AuctionRuleCode.AuctionNotActive, () => auction.cancel({ now, bidCount: 0 }))
  })

  // 9. CANCELLED rehydrate/snapshot.
  it('rehidrata CANCELLED y conserva cancelledAt en el snapshot', () => {
    const cancelledAt = new Date('2026-09-21T18:00:00.000Z')
    const rehydrated = Auction.rehydrate({
      ...activeAuction().snapshot(),
      status: AuctionStatus.Cancelled,
      finishedAt: null,
      closingResult: null,
      cancelledAt,
    })

    expect(rehydrated.status).toBe(AuctionStatus.Cancelled)
    expect(rehydrated.cancelledAt).toEqual(cancelledAt)
    expect(rehydrated.snapshot()).toMatchObject({
      status: AuctionStatus.Cancelled,
      cancelledAt,
    })
  })

  it.each([
    [AuctionStatus.Active, null],
    [AuctionStatus.Cancelled, undefined],
  ])('rechaza rehidratar un estado %s con cancelledAt incoherente (%s)', (status, cancelledAt) => {
    const input = {
      ...activeAuction().snapshot(),
      status,
      finishedAt: null,
      closingResult: null,
      cancelledAt: status === AuctionStatus.Active ? new Date() : cancelledAt,
    }
    expect(() => Auction.rehydrate(input as unknown as RehydrateAuctionInput)).toThrow(
      AuctionRuleViolation,
    )
  })

  it('rechaza rehidratar CANCELLED con un closingResult persistido', () => {
    const input = {
      ...activeAuction().snapshot(),
      status: AuctionStatus.Cancelled,
      finishedAt: new Date(),
      cancelledAt: new Date(),
      closingResult: {
        outcome: AuctionClosingOutcome.WithoutBids,
        finishedAt: new Date(),
        winnerId: null,
        winningBidId: null,
        finalAmountCredits: null,
      },
    }
    expect(() => Auction.rehydrate(input as unknown as RehydrateAuctionInput)).toThrow(
      AuctionRuleViolation,
    )
  })

  // 10. cancelledAt usa exactamente el `now` recibido (ClockPort), nunca el
  // reloj de sistema: lo prueba el propio valor de retorno/getter, sin
  // mockear timers globales.
  it('cancelledAt es exactamente el now recibido, no una copia por referencia', () => {
    const auction = activeAuction()
    const now = new Date(closesAt.getTime() - CANCELLATION_WINDOW_MS - 1)
    auction.cancel({ now, bidCount: 0 })

    now.setUTCFullYear(2099)

    expect(auction.cancelledAt).not.toEqual(now)
    expect(auction.cancelledAt?.getUTCFullYear()).toBe(2026)
  })
})
