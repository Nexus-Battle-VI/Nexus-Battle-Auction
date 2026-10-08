/**
 * EN-034, TASK 34.5. Cliente de carga para `load-server.cjs`: abre N usuarios con 3 conexiones
 * cada uno y 20 suscripciones por conexion (los limites del contrato), publica una rafaga de
 * senales y mide la memoria del servidor antes, con las conexiones y despues.
 *
 *   node scripts/realtime/load-client.mjs [--users=30] [--conns=3] [--subs=20] [--burst=1000]
 */
import WebSocket from 'ws'

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.split('=')[1])
}
const USERS = arg('users', 30)
const CONNS = arg('conns', 3)
const SUBS = arg('subs', 20)
const BURST = arg('burst', 1000)
const BASE = process.env.LOAD_URL ?? 'http://127.0.0.1:19090'

const get = async (path, method = 'GET') => (await fetch(`${BASE}${path}`, { method })).json()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const before = await get('/mem')
console.log('Antes de conectar:', JSON.stringify(before))

let received = 0
const sockets = []
for (let user = 0; user < USERS; user += 1) {
  for (let conn = 0; conn < CONNS; conn += 1) {
    const { ticket } = await get(`/ticket?sub=user-${user}`, 'POST')
    const socket = new WebSocket(BASE.replace('http', 'ws') + '/ws')
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'signal') received += 1
    })
    socket.send(JSON.stringify({ type: 'auth', ticket }))
    // 1 canal agregado + (SUBS - 1) subastas, el maximo permitido por conexion.
    socket.send(JSON.stringify({ type: 'subscribe', channel: 'auctions' }))
    for (let index = 0; index < SUBS - 1; index += 1) {
      socket.send(JSON.stringify({ type: 'subscribe', channel: `auctions/load-${index}` }))
    }
    sockets.push(socket)
  }
}
await sleep(1_500)
const connected = await get('/mem')
console.log(
  `Con ${connected.connections} conexiones y ${SUBS} suscripciones cada una:`,
  JSON.stringify(connected),
)

received = 0
await get(`/publish?auctions=${SUBS - 1}&n=${BURST}`, 'POST')
await sleep(3_000)
const after = await get('/mem')
console.log(
  `Tras ${BURST} senales difundidas (${received} mensajes entregados):`,
  JSON.stringify(after),
)

const closed = sockets.filter((socket) => socket.readyState !== WebSocket.OPEN).length
console.log(`Conexiones caidas durante la prueba: ${closed}`)
for (const socket of sockets) socket.close()
await sleep(1_000)
console.log('Tras cerrar todas:', JSON.stringify(await get('/mem')))
