import { EventEmitter } from 'node:events'

import {
  AUTH_TIMEOUT_MS,
  AuctionRealtimeGateway,
  CLOSE_BAD_MESSAGE,
  CLOSE_TOO_MANY_CONNECTIONS,
  CLOSE_UNAUTHENTICATED,
  HEARTBEAT_INTERVAL_MS,
  MAX_CONNECTIONS_PER_USER,
  type RealtimeSocket,
} from '../../src/adapters/inbound/ws/AuctionRealtimeGateway'
import { InMemoryRealtimeTicketStore } from '../../src/adapters/outbound/realtime/InMemoryRealtimeTicketStore'
import { CryptoRealtimeTicketCodec } from '../../src/adapters/outbound/system/CryptoRealtimeTicketCodec'
import {
  AUCTIONS_CHANNEL,
  AuctionRealtimeHub,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  isValidChannel,
} from '../../src/application/services/AuctionRealtimeHub'
import {
  ConsumeRealtimeTicket,
  IssueRealtimeTicket,
  TICKET_TTL_SECONDS,
} from '../../src/application/use-cases/RealtimeTickets'
import {
  AUCTION_REALTIME_SIGNAL_MAX_BYTES,
  parseAuctionRealtimeNotice,
  type AuctionRealtimeSignalV1,
} from '../../src/domain/events/AuctionRealtimeSignalV1'
import { isAuctionRealtimeEnabled, loadConfig } from '../../src/infrastructure/config/env'
import type { Logger } from '../../src/infrastructure/observability/logger'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const notice = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    auctionId: 'auction-1',
    revision: 3,
    reason: 'BID_ACCEPTED',
    occurredAt: '2026-10-07T12:00:00.000Z',
    summary: { status: 'ACTIVE', currentBidCredits: 25, bidCount: 2 },
    ...overrides,
  })

const signalFor = (auctionId: string, revision = 1): AuctionRealtimeSignalV1 => ({
  signalVersion: 1,
  signalId: `auction:${auctionId}:r${String(revision)}`,
  auctionId,
  revision,
  reason: 'BID_ACCEPTED',
  occurredAt: '2026-10-07T12:00:00.000Z',
  summary: { status: 'ACTIVE', currentBidCredits: 25, bidCount: 2 },
})

describe('AuctionRealtimeSignalV1 (parseAuctionRealtimeNotice)', () => {
  it('convierte una carga valida en una senal con signalId', () => {
    expect(parseAuctionRealtimeNotice(notice())).toEqual({
      signalVersion: 1,
      signalId: 'auction:auction-1:r3',
      auctionId: 'auction-1',
      revision: 3,
      reason: 'BID_ACCEPTED',
      occurredAt: '2026-10-07T12:00:00.000Z',
      summary: { status: 'ACTIVE', currentBidCredits: 25, bidCount: 2 },
    })
  })

  it('admite una subasta sin pujas (currentBidCredits nulo)', () => {
    const signal = parseAuctionRealtimeNotice(
      notice({ summary: { status: 'ACTIVE', currentBidCredits: null, bidCount: 0 } }),
    )
    expect(signal?.summary).toEqual({ status: 'ACTIVE', currentBidCredits: null, bidCount: 0 })
  })

  it('omite un resumen invalido pero conserva la senal', () => {
    const signal = parseAuctionRealtimeNotice(notice({ summary: { status: 'X' } }))
    expect(signal).not.toBeNull()
    expect(signal).not.toHaveProperty('summary')
  })

  it('ignora campos desconocidos para que la carga pueda crecer', () => {
    const signal = parseAuctionRealtimeNotice(notice({ bidderId: 'bidder-1', extra: 1 }))
    expect(JSON.stringify(signal)).not.toContain('bidder-1')
  })

  it.each([
    ['JSON invalido', '{no es json'],
    ['un arreglo', '[]'],
    ['un nulo', 'null'],
    ['sin auctionId', notice({ auctionId: '' })],
    ['revision negativa', notice({ revision: -1 })],
    ['revision fraccionaria', notice({ revision: 1.5 })],
    ['motivo desconocido', notice({ reason: 'NOPE' })],
    ['fecha invalida', notice({ occurredAt: 'ayer' })],
  ])('descarta una carga mal formada: %s', (_name, payload) => {
    expect(parseAuctionRealtimeNotice(payload)).toBeNull()
  })

  it('descarta una senal que supera el tamano maximo', () => {
    const signal = parseAuctionRealtimeNotice(
      notice({ auctionId: 'a'.repeat(AUCTION_REALTIME_SIGNAL_MAX_BYTES) }),
    )
    expect(signal).toBeNull()
  })
})

describe('AuctionRealtimeHub', () => {
  const connection = () => {
    const sent: string[] = []
    return { sent, send: (message: string): void => void sent.push(message) }
  }

  it.each([
    ['auctions', true],
    ['auctions/auction-1', true],
    ['auctions/a.b:c_d-1', true],
    ['auctions/', false],
    ['auctions/-x', false],
    ['auctions/a/b', false],
    ['auctions/' + 'a'.repeat(129), false],
    ['other', false],
    ['', false],
    [undefined, false],
    [42, false],
  ])('valida el nombre de canal %p -> %p', (channel, valid) => {
    expect(isValidChannel(channel)).toBe(valid)
  })

  it('reparte la senal completa al canal de la subasta y sin resumen al agregado', () => {
    const hub = new AuctionRealtimeHub()
    const detail = connection()
    const market = connection()
    hub.subscribe(detail, 'auctions/auction-1')
    hub.subscribe(market, AUCTIONS_CHANNEL)

    hub.publish(signalFor('auction-1', 4))

    const detailMessage = JSON.parse(detail.sent[0] ?? '{}') as {
      channel: string
      signal: AuctionRealtimeSignalV1
    }
    const marketMessage = JSON.parse(market.sent[0] ?? '{}') as {
      channel: string
      signal: AuctionRealtimeSignalV1
    }
    expect(detailMessage.channel).toBe('auctions/auction-1')
    expect(detailMessage.signal.summary).toEqual({
      status: 'ACTIVE',
      currentBidCredits: 25,
      bidCount: 2,
    })
    expect(marketMessage.channel).toBe('auctions')
    expect(marketMessage.signal).not.toHaveProperty('summary')
    expect(marketMessage.signal.revision).toBe(4)
  })

  it('aisla las subastas: una senal solo llega a quien observa esa subasta', () => {
    const hub = new AuctionRealtimeHub()
    const first = connection()
    const second = connection()
    hub.subscribe(first, 'auctions/auction-1')
    hub.subscribe(second, 'auctions/auction-2')

    hub.publish(signalFor('auction-2'))

    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(1)
  })

  it('suscribirse es idempotente y respeta el limite por conexion', () => {
    const hub = new AuctionRealtimeHub()
    const client = connection()

    expect(hub.subscribe(client, 'auctions/a1')).toBe('SUBSCRIBED')
    expect(hub.subscribe(client, 'auctions/a1')).toBe('ALREADY_SUBSCRIBED')
    expect(hub.subscribe(client, 'nope')).toBe('INVALID_CHANNEL')
    for (let index = 2; index <= MAX_SUBSCRIPTIONS_PER_CONNECTION; index += 1) {
      expect(hub.subscribe(client, `auctions/a${String(index)}`)).toBe('SUBSCRIBED')
    }
    expect(hub.subscribe(client, 'auctions/overflow')).toBe('LIMIT')
    expect(hub.subscriptionCount(client)).toBe(MAX_SUBSCRIPTIONS_PER_CONNECTION)
  })

  it('unsubscribe y disconnect dejan de entregar', () => {
    const hub = new AuctionRealtimeHub()
    const first = connection()
    const second = connection()
    hub.subscribe(first, 'auctions/auction-1')
    hub.subscribe(second, 'auctions/auction-1')

    expect(hub.unsubscribe(first, 'auctions/auction-1')).toBe(true)
    expect(hub.unsubscribe(first, 'auctions/auction-1')).toBe(false)
    expect(hub.unsubscribe(first, 'invalido')).toBe(false)
    hub.disconnect(second)
    hub.disconnect(second)
    hub.publish(signalFor('auction-1'))

    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(0)
  })

  it('un fallo al enviar a una conexion no impide el reparto al resto', () => {
    const hub = new AuctionRealtimeHub()
    const broken = {
      send: (): void => {
        throw new Error('socket cerrado')
      },
    }
    const healthy = connection()
    hub.subscribe(broken, 'auctions/auction-1')
    hub.subscribe(healthy, 'auctions/auction-1')

    expect(() => {
      hub.publish(signalFor('auction-1'))
    }).not.toThrow()
    expect(healthy.sent).toHaveLength(1)
  })

  it('resyncAll avisa a toda conexion con alguna suscripcion', () => {
    const hub = new AuctionRealtimeHub()
    const subscribed = connection()
    const idle = connection()
    hub.subscribe(subscribed, 'auctions/auction-1')

    hub.resyncAll()

    expect(subscribed.sent.map((message) => JSON.parse(message) as unknown)).toEqual([
      { type: 'resync' },
    ])
    expect(idle.sent).toHaveLength(0)
  })
})

describe('Tickets de un solo uso', () => {
  const build = (now: { value: Date }) => {
    const codec = new CryptoRealtimeTicketCodec()
    const store = new InMemoryRealtimeTicketStore()
    const clock = { now: (): Date => now.value }
    return {
      issue: new IssueRealtimeTicket(codec, store, clock),
      consume: new ConsumeRealtimeTicket(codec, store, clock),
    }
  }

  it('emite un ticket opaco que se consume una sola vez y devuelve el sub', () => {
    const clock = { value: new Date('2026-10-07T12:00:00Z') }
    const { issue, consume } = build(clock)

    const issued = issue.execute('player-1')

    expect(issued.expiresInSeconds).toBe(TICKET_TTL_SECONDS)
    expect(issued.ticket.length).toBeGreaterThan(30)
    expect(consume.execute(issued.ticket)).toBe('player-1')
    expect(consume.execute(issued.ticket)).toBeNull()
  })

  it('un ticket caducado se rechaza y tickets distintos son distintos', () => {
    const clock = { value: new Date('2026-10-07T12:00:00Z') }
    const { issue, consume } = build(clock)
    const first = issue.execute('player-1')
    const second = issue.execute('player-1')

    expect(first.ticket).not.toBe(second.ticket)
    clock.value = new Date(clock.value.getTime() + (TICKET_TTL_SECONDS + 1) * 1000)
    expect(consume.execute(first.ticket)).toBeNull()
  })

  it('purga los caducados al emitir uno nuevo', () => {
    const clock = { value: new Date('2026-10-07T12:00:00Z') }
    const { issue, consume } = build(clock)
    const stale = issue.execute('player-1')
    clock.value = new Date(clock.value.getTime() + 60_000)
    issue.execute('player-2')

    expect(consume.execute(stale.ticket)).toBeNull()
  })

  it.each([undefined, null, 42, '', 'x'.repeat(257), {}])(
    'rechaza un ticket que no es un texto razonable: %p',
    (value) => {
      const { consume } = build({ value: new Date() })
      expect(consume.execute(value)).toBeNull()
    },
  )

  it('solo se retiene el hash, nunca el ticket', () => {
    const codec = new CryptoRealtimeTicketCodec()
    const ticket = codec.generate()
    expect(codec.hash(ticket)).not.toContain(ticket)
    expect(codec.hash(ticket)).toMatch(/^[0-9a-f]{64}$/)
  })
})

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 1
  readonly sent: unknown[] = []
  closed: { code?: number; reason?: string } | null = null
  pings = 0
  terminated = false

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
    this.emit('close')
  }

  ping(): void {
    this.pings += 1
  }

  terminate(): void {
    this.terminated = true
    this.readyState = 3
    this.emit('close')
  }

  receive(message: unknown): void {
    this.emit('message', {
      toString: () => (typeof message === 'string' ? message : JSON.stringify(message)),
    })
  }
}

describe('AuctionRealtimeGateway', () => {
  let clock: { value: Date }
  let hub: AuctionRealtimeHub
  let issue: IssueRealtimeTicket
  let gateway: AuctionRealtimeGateway

  const connect = (): FakeSocket => {
    const socket = new FakeSocket()
    gateway.handleConnection(socket)
    return socket
  }

  const authenticated = (subject = 'player-1'): FakeSocket => {
    const socket = connect()
    // El ticket se emite para `subject` y se presenta como primer mensaje.
    const codecIssue = new IssueRealtimeTicket(codec, store, { now: () => clock.value })
    socket.receive({ type: 'auth', ticket: codecIssue.execute(subject).ticket })
    return socket
  }

  let codec: CryptoRealtimeTicketCodec
  let store: InMemoryRealtimeTicketStore

  beforeEach(() => {
    jest.useFakeTimers()
    clock = { value: new Date('2026-10-07T12:00:00Z') }
    codec = new CryptoRealtimeTicketCodec()
    store = new InMemoryRealtimeTicketStore()
    hub = new AuctionRealtimeHub()
    issue = new IssueRealtimeTicket(codec, store, { now: () => clock.value })
    gateway = new AuctionRealtimeGateway(
      new ConsumeRealtimeTicket(codec, store, { now: () => clock.value }),
      hub,
      silentLogger,
    )
  })

  afterEach(() => {
    gateway.closeAll()
    jest.useRealTimers()
  })

  it('autentica con un ticket valido y confirma', () => {
    const socket = connect()
    socket.receive({ type: 'auth', ticket: issue.execute('player-1').ticket })

    expect(socket.sent).toEqual([{ type: 'authenticated' }])
    expect(socket.closed).toBeNull()
  })

  it.each([
    ['sin ticket', { type: 'auth' }],
    ['ticket desconocido', { type: 'auth', ticket: 'desconocido' }],
    ['otro tipo de mensaje primero', { type: 'subscribe', channel: 'auctions' }],
  ])('cierra con 4401 si el primer mensaje es invalido: %s', (_name, message) => {
    const socket = connect()
    socket.receive(message)

    expect(socket.closed?.code).toBe(CLOSE_UNAUTHENTICATED)
  })

  it('un ticket ya usado cierra con 4401', () => {
    const { ticket } = issue.execute('player-1')
    const first = connect()
    first.receive({ type: 'auth', ticket })
    const second = connect()
    second.receive({ type: 'auth', ticket })

    expect(first.closed).toBeNull()
    expect(second.closed?.code).toBe(CLOSE_UNAUTHENTICATED)
  })

  it('cierra con 4401 si no se autentica en 5 s', () => {
    const socket = connect()
    jest.advanceTimersByTime(AUTH_TIMEOUT_MS + 1)

    expect(socket.closed?.code).toBe(CLOSE_UNAUTHENTICATED)
  })

  it('no cierra por tiempo a quien ya se autentico', () => {
    const socket = authenticated()
    jest.advanceTimersByTime(AUTH_TIMEOUT_MS * 2)

    expect(socket.closed).toBeNull()
  })

  it.each([
    ['JSON invalido', '{no'],
    ['un arreglo', '[]'],
    ['sin type', { channel: 'auctions' }],
  ])('cierra con 4400 ante un mensaje malformado: %s', (_name, message) => {
    const socket = authenticated()
    socket.receive(message)

    expect(socket.closed?.code).toBe(CLOSE_BAD_MESSAGE)
  })

  it('cierra con 4400 ante tipos no permitidos, incluido auth repetido y comandos de negocio', () => {
    for (const message of [
      { type: 'auth', ticket: 'x' },
      { type: 'bid', amount: 10 },
    ]) {
      const socket = authenticated()
      socket.receive(message)
      expect(socket.closed?.code).toBe(CLOSE_BAD_MESSAGE)
    }
  })

  it('suscribe, recibe senales y deja de recibir tras unsubscribe', () => {
    const socket = authenticated()
    socket.receive({ type: 'subscribe', channel: 'auctions/auction-1' })
    hub.publish(signalFor('auction-1', 7))
    socket.receive({ type: 'unsubscribe', channel: 'auctions/auction-1' })
    hub.publish(signalFor('auction-1', 8))

    expect(socket.sent[1]).toEqual({ type: 'subscribed', channel: 'auctions/auction-1' })
    expect(socket.sent[2]).toMatchObject({
      type: 'signal',
      channel: 'auctions/auction-1',
      signal: { revision: 7 },
    })
    expect(socket.sent[3]).toEqual({ type: 'unsubscribed', channel: 'auctions/auction-1' })
    expect(socket.sent).toHaveLength(4)
  })

  it('responde error ante un canal invalido o al superar las suscripciones, sin cerrar', () => {
    const socket = authenticated()
    socket.receive({ type: 'subscribe', channel: 'otro' })
    for (let index = 0; index <= MAX_SUBSCRIPTIONS_PER_CONNECTION; index += 1) {
      socket.receive({ type: 'subscribe', channel: `auctions/a${String(index)}` })
    }

    expect(socket.sent).toContainEqual({ type: 'error', code: 'INVALID_CHANNEL' })
    expect(socket.sent).toContainEqual({ type: 'error', code: 'SUBSCRIPTION_LIMIT' })
    expect(socket.closed).toBeNull()
  })

  it('limita las conexiones simultaneas por usuario con 4429', () => {
    const sockets = Array.from({ length: MAX_CONNECTIONS_PER_USER }, () => authenticated('p-1'))
    const extra = authenticated('p-1')
    const other = authenticated('p-2')

    expect(sockets.every((socket) => socket.closed === null)).toBe(true)
    expect(extra.closed?.code).toBe(CLOSE_TOO_MANY_CONNECTIONS)
    expect(other.closed).toBeNull()
  })

  it('liberar una conexion permite abrir otra', () => {
    const sockets = Array.from({ length: MAX_CONNECTIONS_PER_USER }, () => authenticated('p-1'))
    sockets[0]?.close()

    expect(authenticated('p-1').closed).toBeNull()
  })

  it('al cerrarse una conexion se da de baja del hub y de la cuenta', () => {
    const socket = authenticated()
    socket.receive({ type: 'subscribe', channel: 'auctions/auction-1' })
    expect(gateway.connectionCount()).toBe(1)

    socket.close()

    expect(gateway.connectionCount()).toBe(0)
    expect(() => {
      hub.publish(signalFor('auction-1'))
    }).not.toThrow()
  })

  it('handleDisconnect libera una conexion y es idempotente', () => {
    const socket = authenticated()
    gateway.handleDisconnect(socket)
    gateway.handleDisconnect(socket)

    expect(gateway.connectionCount()).toBe(0)
  })

  it('no envia a un socket que ya no esta abierto', () => {
    const socket = authenticated()
    socket.receive({ type: 'subscribe', channel: 'auctions/auction-1' })
    socket.readyState = 2
    const before = socket.sent.length

    hub.publish(signalFor('auction-1'))

    expect(socket.sent).toHaveLength(before)
  })

  it('latido: hace ping y termina la conexion que no responde con pong', () => {
    const responsive = authenticated('p-1')
    const silent = authenticated('p-2')

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(responsive.pings).toBe(1)
    responsive.emit('pong')
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)

    expect(responsive.terminated).toBe(false)
    expect(silent.terminated).toBe(true)
  })

  it('closeAll cierra todas las conexiones', () => {
    const sockets = [authenticated('p-1'), authenticated('p-2')]
    gateway.closeAll(1001, 'bye')

    expect(sockets.map((socket) => socket.closed?.code)).toEqual([1001, 1001])
  })
})

describe('Configuracion de AUCTION_REALTIME_ENABLED', () => {
  const base = { NODE_ENV: 'test', PERSISTENCE_DRIVER: 'memory', AUTH_MODE: 'disabled' }

  it('esta apagado por defecto', () => {
    expect(isAuctionRealtimeEnabled({})).toBe(false)
    expect(loadConfig(base).auctionRealtimeEnabled).toBe(false)
  })

  it('exige PostgreSQL cuando se activa', () => {
    expect(() => loadConfig({ ...base, AUCTION_REALTIME_ENABLED: 'true' })).toThrow(/postgres/)
  })

  it('se activa con PostgreSQL', () => {
    const config = loadConfig({
      ...base,
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://u:p@localhost:5432/auction',
      AUCTION_REALTIME_ENABLED: 'true',
    })
    expect(config.auctionRealtimeEnabled).toBe(true)
  })

  it('rechaza un valor que no es true o false', () => {
    expect(() => isAuctionRealtimeEnabled({ AUCTION_REALTIME_ENABLED: 'si' })).toThrow(/true/)
  })
})
