import { WatchlistEntry } from '../../src/domain/entities/WatchlistEntry'
import { DomainError } from '../../src/domain/errors/DomainError'

/** Invariantes de identidad y tiempo sin reloj global ni infraestructura. */
describe('WatchlistEntry', () => {
  const input = () => ({
    playerId: 'player-1',
    auctionId: 'auction-1',
    followedAt: new Date('2026-09-21T12:00:00Z'),
  })

  it('normaliza identidad y conserva la fecha proporcionada', () => {
    expect(
      WatchlistEntry.create({
        ...input(),
        playerId: ' player-1 ',
        auctionId: ' auction-1 ',
      }).snapshot(),
    ).toEqual(input())
  })

  it.each(['', ' ', 'a/b', '-player', 'player-', 'a'.repeat(129)])(
    'rechaza playerId invalido: %p',
    (playerId) => {
      expect(() => WatchlistEntry.create({ ...input(), playerId })).toThrow(DomainError)
    },
  )

  it('reutiliza la validacion de AuctionId', () => {
    expect(() => WatchlistEntry.create({ ...input(), auctionId: '' })).toThrow(DomainError)
  })

  it('acepta identificadores de uno y 128 caracteres', () => {
    for (const playerId of ['a', 'a'.repeat(128), 'player:one.two_three-1']) {
      expect(WatchlistEntry.create({ ...input(), playerId }).snapshot().playerId).toBe(playerId)
    }
  })

  it('rechaza fechas invalidas', () => {
    expect(() => WatchlistEntry.create({ ...input(), followedAt: new Date(NaN) })).toThrow(
      DomainError,
    )
  })

  it('no permite mutar la fecha mediante la entrada ni la instantanea', () => {
    const data = input()
    const entry = WatchlistEntry.create(data)
    data.followedAt.setFullYear(2000)
    const snapshot = entry.snapshot()
    snapshot.followedAt.setFullYear(2001)
    snapshot.playerId = 'intruder'
    expect(entry.snapshot()).toEqual(input())
  })
})
