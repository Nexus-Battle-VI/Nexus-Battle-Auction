import type { WatchlistRepositoryPort } from '../../src/application/ports/WatchlistRepositoryPort'
import { WatchlistAlreadyExistsError } from '../../src/application/errors/WatchlistAlreadyExistsError'
import { PersistedAuctionNotFoundError } from '../../src/application/errors/AuctionPersistenceError'
import { WatchlistEntry } from '../../src/domain/entities/WatchlistEntry'

/** Misma semantica observable para memoria y PostgreSQL; no inspecciona implementacion. */
export const watchlistContract = (repository: () => WatchlistRepositoryPort): void => {
  const entry = (playerId = 'player-1', auctionId = 'auction-1') =>
    WatchlistEntry.create({ playerId, auctionId, followedAt: new Date('2026-09-21T12:00:00Z') })

  it('crea y recupera una relacion con fecha', async () => {
    await repository().create(entry())
    expect((await repository().find('player-1', 'auction-1'))?.snapshot()).toEqual(
      entry().snapshot(),
    )
  })
  it('devuelve null y lista vacia para jugador sin seguimientos', async () => {
    expect(await repository().find('nobody', 'auction-1')).toBeNull()
    expect(await repository().listByPlayer('nobody')).toEqual([])
  })
  it('rechaza duplicados y preserva fecha original', async () => {
    await repository().create(entry())
    await expect(
      repository().create(
        WatchlistEntry.create({
          ...entry().snapshot(),
          followedAt: new Date('2026-09-22T00:00:00Z'),
        }),
      ),
    ).rejects.toBeInstanceOf(WatchlistAlreadyExistsError)
    expect((await repository().find('player-1', 'auction-1'))?.snapshot()).toEqual(
      entry().snapshot(),
    )
  })
  it('solo una solicitud concurrente crea la relacion', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => repository().create(entry())),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(7)
    for (const result of rejected) expect(result.reason).toBeInstanceOf(WatchlistAlreadyExistsError)
    expect(await repository().listByPlayer('player-1')).toHaveLength(1)
  })
  it('aisla jugadores y ordena por fecha y auctionId para empates', async () => {
    await repository().create(entry('player-1', 'auction-2'))
    await repository().create(entry())
    await repository().create(entry('player-2'))
    expect(
      (await repository().listByPlayer('player-1')).map((item) => item.snapshot().auctionId),
    ).toEqual(['auction-1', 'auction-2'])
    expect(await repository().listByPlayer('player-2')).toHaveLength(1)
    expect(await repository().find('player-3', 'auction-1')).toBeNull()
  })
  it('ordena primero los seguimientos mas recientes', async () => {
    await repository().create(entry())
    await repository().create(
      WatchlistEntry.create({
        ...entry('player-1', 'auction-2').snapshot(),
        followedAt: new Date('2026-09-22T00:00:00Z'),
      }),
    )
    expect(
      (await repository().listByPlayer('player-1')).map((item) => item.snapshot().auctionId),
    ).toEqual(['auction-2', 'auction-1'])
  })
  it('conserva el desempate aunque la insercion ya venga ordenada', async () => {
    await repository().create(entry())
    await repository().create(entry('player-1', 'auction-2'))
    expect(
      (await repository().listByPlayer('player-1')).map((item) => item.snapshot().auctionId),
    ).toEqual(['auction-1', 'auction-2'])
  })
  it('elimina solo la pareja indicada, permite reseguir y reporta ausencias', async () => {
    await repository().create(entry())
    await repository().create(entry('player-2'))
    expect(await repository().delete('player-3', 'auction-1')).toBe(false)
    expect(await repository().delete('player-1', 'auction-1')).toBe(true)
    expect(await repository().delete('player-1', 'auction-1')).toBe(false)
    expect(await repository().find('player-1', 'auction-1')).toBeNull()
    expect(await repository().listByPlayer('player-2')).toHaveLength(1)
    await repository().create(entry())
    expect(await repository().listByPlayer('player-1')).toHaveLength(1)
  })
  it('no crea relaciones huerfanas', async () => {
    await expect(repository().create(entry('player-1', 'missing'))).rejects.toBeInstanceOf(
      PersistedAuctionNotFoundError,
    )
  })
  it('las instantaneas recuperadas no modifican el almacenamiento', async () => {
    await repository().create(entry())
    const read = (await repository().listByPlayer('player-1'))[0]!.snapshot()
    read.followedAt.setFullYear(2000)
    read.playerId = 'intruder'
    expect((await repository().find('player-1', 'auction-1'))?.snapshot()).toEqual(
      entry().snapshot(),
    )
  })
}
