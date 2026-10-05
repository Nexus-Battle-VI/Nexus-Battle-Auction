import {
  cancellationReservationReleaseOperationId,
  planCancellationReservationReleases,
  type PlannedBidCreditOperation,
} from '../../src/application/services/CancellationReservationReleasePlanner'

const auctionId = 'auction-1'

const operation = (
  status: PlannedBidCreditOperation['status'],
  reservationId: string | null,
  previousReservationId: string | null = null,
): PlannedBidCreditOperation => ({ status, reservationId, previousReservationId })

const reservationIds = (
  bids: readonly { creditReservationId?: string | null }[],
  operations: readonly PlannedBidCreditOperation[],
): readonly string[] =>
  planCancellationReservationReleases(auctionId, bids, operations).map(
    (release) => release.reservationId,
  )

describe('planCancellationReservationReleases (HU-90, CA-05)', () => {
  it('sin pujas no hay nada que liberar', () => {
    expect(planCancellationReservationReleases(auctionId, [], [])).toEqual([])
  })

  it('con una sola puja libera la reserva del lider', () => {
    expect(
      planCancellationReservationReleases(
        auctionId,
        [{ creditReservationId: 'hold-1' }],
        [operation('COMPLETED', 'hold-1')],
      ),
    ).toEqual([
      {
        reservationId: 'hold-1',
        operationId: 'auction:auction-1:cancellation:reservation:hold-1:release',
      },
    ])
  })

  it('usa un operationId determinista por subasta y reserva', () => {
    expect(cancellationReservationReleaseOperationId('a', 'h')).toBe(
      'auction:a:cancellation:reservation:h:release',
    )
    const first = planCancellationReservationReleases(
      auctionId,
      [{ creditReservationId: 'hold-1' }],
      [],
    )
    const second = planCancellationReservationReleases(
      auctionId,
      [{ creditReservationId: 'hold-1' }],
      [],
    )
    expect(second).toEqual(first)
  })

  it('con varias pujas ya superadas y liberadas solo queda la del lider', () => {
    expect(
      reservationIds(
        [
          { creditReservationId: 'hold-1' },
          { creditReservationId: 'hold-2' },
          { creditReservationId: 'hold-3' },
        ],
        [
          operation('COMPLETED', 'hold-1'),
          operation('COMPLETED', 'hold-2', 'hold-1'),
          operation('COMPLETED', 'hold-3', 'hold-2'),
        ],
      ),
    ).toEqual(['hold-3'])
  })

  it('NO asume que solo el lider sigue retenido: incluye al superado cuyo release no se confirmo', () => {
    // La puja 2 se persistio (BID_PERSISTED) pero el release de hold-1 fallo:
    // la operacion nunca llego a COMPLETED y hold-1 sigue activo en Wallet.
    expect(
      reservationIds(
        [{ creditReservationId: 'hold-1' }, { creditReservationId: 'hold-2' }],
        [operation('COMPLETED', 'hold-1'), operation('BID_PERSISTED', 'hold-2', 'hold-1')],
      ),
    ).toEqual(['hold-1', 'hold-2'])
  })

  it('incluye una reserva creada en Wallet cuya puja nunca se persistio', () => {
    expect(
      reservationIds(
        [{ creditReservationId: 'hold-1' }],
        [
          operation('COMPLETED', 'hold-1'),
          operation('RESERVED', 'hold-reserved'),
          operation('COMPENSATION_PENDING', 'hold-pending'),
        ],
      ),
    ).toEqual(['hold-1', 'hold-pending', 'hold-reserved'])
  })

  it('excluye una reserva ya compensada y una operacion que aun no reservo', () => {
    expect(
      reservationIds(
        [{ creditReservationId: 'hold-1' }],
        [
          operation('COMPLETED', 'hold-1'),
          operation('COMPENSATED', 'hold-compensated'),
          operation('PENDING_RESERVATION', null),
        ],
      ),
    ).toEqual(['hold-1'])
  })

  it('incluye la reserva de una puja sin operacion de creditos asociada', () => {
    expect(reservationIds([{ creditReservationId: 'hold-legacy' }], [])).toEqual(['hold-legacy'])
  })

  it('ignora pujas sin reserva y no duplica una reserva vista por puja y por operacion', () => {
    expect(
      reservationIds(
        [{ creditReservationId: null }, {}, { creditReservationId: 'hold-1' }],
        [operation('BID_PERSISTED', 'hold-1')],
      ),
    ).toEqual(['hold-1'])
  })
})
