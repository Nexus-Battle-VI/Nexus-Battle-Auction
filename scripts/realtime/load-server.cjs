/**
 * EN-034, TASK 34.5. Servidor de carga para medir memoria con MUCHOS usuarios distintos.
 *
 * Con `AUTH_MODE=disabled` todas las conexiones tienen el mismo `sub` y el limite de 3 por usuario
 * impide abrir mas. Este servidor monta el gateway, el hub y los tickets REALES de la imagen
 * (`dist/`) sobre un `http.Server` propio y expone dos rutas de ayuda para el cliente de carga:
 *
 *   POST /ticket?sub=user-7     emite un ticket para ese usuario (en produccion lo hace el JWT)
 *   POST /publish?auctions=40&n=300   publica n senales repartidas entre las subastas
 *   GET  /mem                   memoria del proceso en MiB
 *
 * Se ejecuta DENTRO de la imagen, con el limite de memoria de produccion (160 MiB):
 *   docker run --rm --memory 160m -p 19090:9090 -v <dir>:/scripts auction-rt:test node /scripts/load-server.cjs
 */
require('reflect-metadata')
const http = require('node:http')
const { WebSocketServer } = require('ws')

const dist = '/app/dist'
const { AuctionRealtimeGateway } = require(`${dist}/adapters/inbound/ws/AuctionRealtimeGateway`)
const { AuctionRealtimeHub } = require(`${dist}/application/services/AuctionRealtimeHub`)
const { IssueRealtimeTicket, ConsumeRealtimeTicket } = require(
  `${dist}/application/use-cases/RealtimeTickets`,
)
const { InMemoryRealtimeTicketStore } = require(
  `${dist}/adapters/outbound/realtime/InMemoryRealtimeTicketStore`,
)
const { CryptoRealtimeTicketCodec } = require(
  `${dist}/adapters/outbound/system/CryptoRealtimeTicketCodec`,
)

const codec = new CryptoRealtimeTicketCodec()
const store = new InMemoryRealtimeTicketStore()
const clock = { now: () => new Date() }
const hub = new AuctionRealtimeHub()
const silent = { debug() {}, info() {}, warn() {}, error() {} }
const gateway = new AuctionRealtimeGateway(
  new ConsumeRealtimeTicket(codec, store, clock),
  hub,
  silent,
)
const issue = new IssueRealtimeTicket(codec, store, clock)

const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10
const memory = () => {
  const usage = process.memoryUsage()
  return {
    rssMiB: mib(usage.rss),
    heapUsedMiB: mib(usage.heapUsed),
    connections: gateway.connectionCount(),
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const json = (body) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  }
  if (url.pathname === '/mem') return json(memory())
  if (url.pathname === '/ticket')
    return json(issue.execute(url.searchParams.get('sub') ?? 'anonymous'))
  if (url.pathname === '/publish') {
    const auctions = Number(url.searchParams.get('auctions') ?? 40)
    const n = Number(url.searchParams.get('n') ?? 100)
    for (let index = 0; index < n; index += 1) {
      const auctionId = `load-${index % auctions}`
      const revision = Math.floor(index / auctions) + 1
      hub.publish({
        signalVersion: 1,
        signalId: `auction:${auctionId}:r${revision}`,
        auctionId,
        revision,
        reason: 'BID_ACCEPTED',
        occurredAt: new Date().toISOString(),
        summary: { status: 'ACTIVE', currentBidCredits: 10 + index, bidCount: revision },
      })
    }
    return json({ published: n })
  }
  response.statusCode = 404
  response.end()
})

const sockets = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 })
sockets.on('connection', (socket) => gateway.handleConnection(socket))

server.listen(9090, () => console.log('load-server listo', memory()))
