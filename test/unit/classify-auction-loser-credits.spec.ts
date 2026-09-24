import { InMemoryBidCreditOperationReader } from '../../src/adapters/outbound/persistence/InMemoryBidCreditOperationReader'
import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { ClassifyAuctionLoserCredits } from '../../src/application/use-cases/ClassifyAuctionLoserCredits'
import { PrepareAuctionLoserReleaseTasks } from '../../src/application/use-cases/PrepareAuctionLoserReleaseTasks'

const now = new Date('2026-09-23T12:00:00.000Z')
const bid = (id: string, hold: string | null) => ({
  id,
  auctionId: 'auction-1',
  bidderId: 'player',
  amountCredits: 20,
  placedAt: now,
  ...(hold === null ? {} : { creditReservationId: hold }),
})
const operation = (
  status: 'COMPLETED' | 'COMPENSATED' | 'COMPENSATION_PENDING',
  previousReservationId: string | null,
) => ({
  operationId: 'hu63-operation:release-previous',
  bidId: 'new-bid',
  auctionId: 'auction-1',
  bidderId: 'player',
  amountCredits: 30,
  status,
  reservationId: 'new-hold',
  previousReservationId,
  createdAt: now,
  updatedAt: now,
})

describe('ClassifyAuctionLoserCredits', () => {
  it.each([
    ['COMPLETED', 'ALREADY_RELEASED'],
    ['COMPENSATED', 'COMPENSATED'],
  ] as const)('clasifica %s sin crear task', async (status, classification) => {
    const useCase = new ClassifyAuctionLoserCredits(
      new InMemoryBidCreditOperationReader([operation(status, 'hold-1')]),
    )
    await expect(
      useCase.execute('auction-1', [bid('loser', 'hold-1')], null),
    ).resolves.toMatchObject([{ classification, releaseOperationId: null }])
  })

  it('reutiliza exactamente el operationId de compensacion pendiente', async () => {
    const useCase = new ClassifyAuctionLoserCredits(
      new InMemoryBidCreditOperationReader([operation('COMPENSATION_PENDING', 'hold-1')]),
    )
    const actions = await useCase.execute('auction-1', [bid('loser', 'hold-1')], null)
    const settlements = new InMemoryAuctionSettlementRepository()
    await new PrepareAuctionLoserReleaseTasks(settlements).execute(actions, now)
    await expect(settlements.listReleaseTasks('auction-1')).resolves.toMatchObject([
      { operationId: 'hu63-operation:release-previous', holdId: 'hold-1' },
    ])
  })

  it('prepara una release HU-65 para hold activo', async () => {
    const actions = await new ClassifyAuctionLoserCredits(
      new InMemoryBidCreditOperationReader(),
    ).execute('auction-1', [bid('loser', 'hold-1')], null)
    expect(actions).toMatchObject([
      { classification: 'ACTIVE_HOLD', releaseOperationId: 'auction:auction-1:bid:loser:release' },
    ])
  })

  it('reporta inconsistencia sin task cuando falta hold', async () => {
    const actions = await new ClassifyAuctionLoserCredits(
      new InMemoryBidCreditOperationReader([operation('COMPENSATION_PENDING', null)]),
    ).execute('auction-1', [bid('loser', null)], null)
    const settlements = new InMemoryAuctionSettlementRepository()
    await new PrepareAuctionLoserReleaseTasks(settlements).execute(actions, now)
    expect(actions).toMatchObject([{ classification: 'INCONSISTENT' }])
    await expect(settlements.listReleaseTasks('auction-1')).resolves.toEqual([])
  })
})
