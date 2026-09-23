import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { InMemoryAuctionSettlementWorkRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementWorkRepository'
import {
  AuctionSettlementWorkStatus,
  type AuctionSettlementCandidate,
  type AuctionSettlementCandidateReaderPort,
} from '../../src/application/ports/AuctionSettlementWorkRepositoryPort'
import { AuctionStatus } from '../../src/domain/entities/Auction'

const now = new Date('2026-09-23T12:00:00.000Z')

class Candidates implements AuctionSettlementCandidateReaderPort {
  constructor(private readonly values: readonly AuctionSettlementCandidate[]) {}

  findSettlementCandidates(now: Date): Promise<readonly AuctionSettlementCandidate[]> {
    return Promise.resolve(
      this.values.filter((candidate) => candidate.closesAt.getTime() <= now.getTime()),
    )
  }
}

const candidate = (auctionId: string, closesAt: string): AuctionSettlementCandidate => ({
  auctionId,
  status: AuctionStatus.Active,
  closesAt: new Date(closesAt),
})

const claim = (repository: InMemoryAuctionSettlementWorkRepository, owner = 'worker-1', at = now) =>
  repository.claimDue({
    now: at,
    workerId: owner,
    leaseUntil: new Date(at.getTime() + 300_000),
    limit: 25,
  })

describe('InMemoryAuctionSettlementWorkRepository', () => {
  it('descubre vencidas y reclama en orden closesAt, auctionId', async () => {
    const repository = new InMemoryAuctionSettlementWorkRepository(
      new Candidates([
        candidate('auction-c', '2026-09-23T11:00:00.000Z'),
        candidate('auction-b', '2026-09-23T10:00:00.000Z'),
        candidate('auction-a', '2026-09-23T10:00:00.000Z'),
      ]),
      new InMemoryAuctionSettlementRepository(),
    )

    const result = await claim(repository)
    expect(result.map((item) => item.auctionId)).toEqual(['auction-a', 'auction-b', 'auction-c'])
    expect(result.every((item) => item.status === AuctionSettlementWorkStatus.Leased)).toBe(true)
  })

  it('no entrega un lease vigente a otro worker', async () => {
    const repository = new InMemoryAuctionSettlementWorkRepository(
      new Candidates([candidate('auction-1', '2026-09-23T10:00:00.000Z')]),
      new InMemoryAuctionSettlementRepository(),
    )
    await claim(repository)
    await expect(claim(repository, 'worker-2')).resolves.toEqual([])
  })

  it('recupera un lease vencido e incrementa attempts', async () => {
    const repository = new InMemoryAuctionSettlementWorkRepository(
      new Candidates([candidate('auction-1', '2026-09-23T10:00:00.000Z')]),
      new InMemoryAuctionSettlementRepository(),
    )
    await claim(repository)
    const reclaimed = await claim(repository, 'worker-2', new Date('2026-09-23T12:05:00.000Z'))
    expect(reclaimed[0]).toMatchObject({ leaseOwner: 'worker-2', attempts: 2 })
  })

  it('rechaza una finalizacion por un owner distinto', async () => {
    const repository = new InMemoryAuctionSettlementWorkRepository(
      new Candidates([candidate('auction-1', '2026-09-23T10:00:00.000Z')]),
      new InMemoryAuctionSettlementRepository(),
    )
    await claim(repository)
    await expect(
      repository.markCompleted({
        auctionId: 'auction-1',
        workerId: 'worker-2',
        now,
      }),
    ).rejects.toThrow(/no esta arrendado/)
  })

  it('mantiene estable COMPLETED ante replay', async () => {
    const repository = new InMemoryAuctionSettlementWorkRepository(
      new Candidates([candidate('auction-1', '2026-09-23T10:00:00.000Z')]),
      new InMemoryAuctionSettlementRepository(),
    )
    await claim(repository)
    const first = await repository.markCompleted({
      auctionId: 'auction-1',
      workerId: 'worker-1',
      now,
    })
    const replay = await repository.markCompleted({
      auctionId: 'auction-1',
      workerId: 'another-worker',
      now: new Date('2026-09-24T12:00:00.000Z'),
    })
    expect(replay).toEqual(first)
    await expect(
      claim(repository, 'worker-3', new Date('2026-09-30T12:00:00.000Z')),
    ).resolves.toEqual([])
  })

  it('no vuelve a reclamar trabajo TERMINAL', async () => {
    const repository = new InMemoryAuctionSettlementWorkRepository(
      new Candidates([candidate('auction-1', '2026-09-23T10:00:00.000Z')]),
      new InMemoryAuctionSettlementRepository(),
    )
    await claim(repository)
    await repository.markTerminal({
      auctionId: 'auction-1',
      workerId: 'worker-1',
      now,
      error: 'permanent',
    })

    await expect(
      claim(repository, 'worker-2', new Date('2026-09-30T12:00:00.000Z')),
    ).resolves.toEqual([])
  })
})
