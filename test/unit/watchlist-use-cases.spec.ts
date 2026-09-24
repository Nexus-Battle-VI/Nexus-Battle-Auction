import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryWatchlistRepository } from '../../src/adapters/outbound/persistence/InMemoryWatchlistRepository'
import { FollowAuction } from '../../src/application/use-cases/FollowAuction'
import { UnfollowAuction } from '../../src/application/use-cases/UnfollowAuction'
import { ListFollowedAuctions } from '../../src/application/use-cases/ListFollowedAuctions'
import { WatchlistAlreadyExistsError } from '../../src/application/errors/WatchlistAlreadyExistsError'
import { PersistedAuctionNotFoundError } from '../../src/application/errors/AuctionPersistenceError'
import { DomainError } from '../../src/domain/errors/DomainError'
import { assertAuctionFollowable } from '../../src/domain/services/watchlist-eligibility'
import { watchlistAuction } from '../support/watchlist-auction'

const NOW = new Date('2026-09-21T12:00:00Z')

/** Casos de uso reales y reloj controlado; no se simula la logica bajo prueba. */
describe('TASK 68.2 casos de uso', () => {
  let auctions: InMemoryAuctionRepository
  let watchlist: InMemoryWatchlistRepository
  let follow: FollowAuction
  let unfollow: UnfollowAuction
  let list: ListFollowedAuctions
  let clock: { now: jest.Mock<Date, []> }
  beforeEach(async () => {
    auctions = new InMemoryAuctionRepository()
    await auctions.publish(watchlistAuction('auction-1'))
    watchlist = new InMemoryWatchlistRepository(auctions)
    clock = { now: jest.fn(() => new Date(NOW)) }
    follow = new FollowAuction(watchlist, auctions, clock)
    unfollow = new UnfollowAuction(watchlist)
    list = new ListFollowedAuctions(watchlist, auctions)
  })

  it('sigue una subasta activa y usa la fecha del puerto de reloj', async () => {
    expect(await follow.execute('player-1', 'auction-1')).toEqual({
      auctionId: 'auction-1',
      followedAt: NOW,
    })
    expect((await watchlist.find('player-1', 'auction-1'))?.snapshot().followedAt).toEqual(NOW)
    expect(clock.now).toHaveBeenCalledTimes(1)
  })
  it('rechaza una subasta inexistente sin insertar seguimiento', async () => {
    await expect(follow.execute('player-1', 'missing')).rejects.toBeInstanceOf(
      PersistedAuctionNotFoundError,
    )
    expect(await watchlist.listByPlayer('player-1')).toEqual([])
  })
  it.each([-1, 0, 1])('aplica el limite temporal con desplazamiento %i ms', async (delta) => {
    const closesAt = (await auctions.findById('auction-1'))!.closesAt
    clock.now.mockReturnValue(new Date(closesAt.getTime() + delta))
    if (delta < 0)
      await expect(follow.execute('player-1', 'auction-1')).resolves.toHaveProperty(
        'auctionId',
        'auction-1',
      )
    else {
      await expect(follow.execute('player-1', 'auction-1')).rejects.toMatchObject({
        code: 'AUCTION_NOT_FOLLOWABLE',
      })
      expect(await watchlist.listByPlayer('player-1')).toEqual([])
    }
  })
  it.each(['CLOSED', 'CANCELLED', 'DRAFT'])(
    'la regla rechaza estado %s aunque quede tiempo',
    (status) => {
      expect(() => {
        assertAuctionFollowable({ status, closesAt: new Date('2026-09-22T12:00:00Z') }, NOW)
      }).toThrow(DomainError)
    },
  )
  it('rechaza fechas de cierre no validas en vez de permitir seguimiento', () => {
    expect(() => {
      assertAuctionFollowable({ status: 'ACTIVE', closesAt: new Date(NaN) }, NOW)
    }).toThrow()
  })
  it('rechaza reloj invalido', () => {
    expect(() => {
      assertAuctionFollowable({ status: 'ACTIVE', closesAt: NOW }, new Date(NaN))
    }).toThrow()
  })
  it('rechaza duplicado sin reemplazar fecha', async () => {
    await follow.execute('player-1', 'auction-1')
    clock.now.mockReturnValue(new Date(NOW.getTime() + 1000))
    await expect(follow.execute('player-1', 'auction-1')).rejects.toBeInstanceOf(
      WatchlistAlreadyExistsError,
    )
    expect((await watchlist.find('player-1', 'auction-1'))?.snapshot().followedAt).toEqual(NOW)
  })
  it('consulta el reloj despues de leer la subasta para no aceptar un cierre durante la lectura', async () => {
    const auction = (await auctions.findById('auction-1'))!
    jest.spyOn(auctions, 'findById').mockImplementation(() => {
      clock.now.mockReturnValue(auction.closesAt)
      return Promise.resolve(auction)
    })
    await expect(follow.execute('player-1', 'auction-1')).rejects.toMatchObject({
      code: 'AUCTION_NOT_FOLLOWABLE',
    })
    expect(await watchlist.listByPlayer('player-1')).toEqual([])
  })
  it('lista solo relaciones propias y enriquece con el estado actual', async () => {
    await follow.execute('player-1', 'auction-1')
    const auction = (await auctions.findById('auction-1'))!
    jest.spyOn(auctions, 'findById').mockResolvedValue({ ...auction, minimumBidCredits: 30 })
    expect(await list.execute('player-1')).toEqual({
      items: [
        { auctionId: 'auction-1', followedAt: NOW, auction: { ...auction, minimumBidCredits: 30 } },
      ],
    })
    expect(await list.execute('player-2')).toEqual({ items: [] })
  })
  it('permite listar y retirar tras vencer, sin consultar elegibilidad', async () => {
    await follow.execute('player-1', 'auction-1')
    clock.now.mockReturnValue(new Date('2026-10-01T00:00:00Z'))
    expect((await list.execute('player-1')).items).toHaveLength(1)
    await unfollow.execute('player-1', 'auction-1')
    await unfollow.execute('player-1', 'auction-1')
    expect(await list.execute('player-1')).toEqual({ items: [] })
  })
  it('retirar un seguimiento propio no elimina el del otro jugador', async () => {
    await follow.execute('player-1', 'auction-1')
    await unfollow.execute('player-2', 'auction-1')
    expect((await list.execute('player-1')).items).toHaveLength(1)
  })
  it.each(['', 'player/1', 'x'.repeat(129)])(
    'rechaza identidad invalida %p en los tres casos',
    async (player) => {
      await expect(follow.execute(player, 'auction-1')).rejects.toBeInstanceOf(DomainError)
      await expect(unfollow.execute(player, 'auction-1')).rejects.toBeInstanceOf(DomainError)
      await expect(list.execute(player)).rejects.toBeInstanceOf(DomainError)
    },
  )
  it('no retorna lista vacia al fallar la persistencia', async () => {
    jest.spyOn(watchlist, 'listByPlayer').mockRejectedValue(new Error('database offline'))
    await expect(list.execute('player-1')).rejects.toThrow('database offline')
  })
  it('no oculta una referencia huerfana al listar', async () => {
    await follow.execute('player-1', 'auction-1')
    jest.spyOn(auctions, 'findById').mockResolvedValue(null)
    await expect(list.execute('player-1')).rejects.toThrow()
  })
})
