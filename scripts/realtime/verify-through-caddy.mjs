/**
 * EN-034, TASK 34.5. Verificacion manual contra la composicion real: Caddy (con el Caddyfile del
 * repo de Infrastructure) -> Auction (imagen construida desde este repositorio) -> PostgreSQL.
 *
 * Comprueba dos cosas que las pruebas automaticas no pueden:
 *  1. Una conexion WebSocket de mas de 60 s sobrevive a Caddy gracias al latido de 25 s y recibe
 *     una senal DESPUES de ese tiempo.
 *  2. La memoria del contenedor de Auction bajo el limite de 160 MiB (`mem_limit: 160m`), en
 *     reposo, con las conexiones abiertas y tras una rafaga de senales.
 *
 * Requisitos: Docker, y los contenedores `rt-pg`, `auction` y `caddy` ya levantados en la red
 * `rt-net` (ver README.md en este directorio). Uso:
 *
 *   node scripts/realtime/verify-through-caddy.mjs [--hold=75] [--burst=300]
 */
import { execFileSync } from 'node:child_process'

import WebSocket from 'ws'

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`))
  return found === undefined ? fallback : Number(found.split('=')[1])
}

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:18080'
const WS = BASE.replace('http', 'ws') + '/api/v1/auctions/realtime'
const HOLD_SECONDS = arg('hold', 75)
const BURST = arg('burst', 300)
const AUCTION = 'verify-long-1'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const psql = (statement) =>
  execFileSync(
    'docker',
    [
      'exec',
      'rt-pg',
      'psql',
      '-U',
      'postgres',
      '-d',
      'auction',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ],
    { encoding: 'utf8' },
  )

/** Memoria usada por el contenedor, en MiB, segun el cgroup (lo que el limite vigila). */
const memoryMiB = () => {
  const out = execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.MemUsage}}', 'auction'],
    { encoding: 'utf8' },
  ).trim()
  const used = out.split('/')[0].trim()
  const value = parseFloat(used)
  return used.includes('GiB') ? value * 1024 : used.includes('KiB') ? value / 1024 : value
}

const check = (ok, message) => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${message}`)
  if (!ok) process.exitCode = 1
}

const openSession = async () => {
  const ticketResponse = await fetch(`${BASE}/api/v1/auctions/realtime/tickets`, { method: 'POST' })
  if (ticketResponse.status !== 201) throw new Error(`ticket: HTTP ${ticketResponse.status}`)
  const { ticket } = await ticketResponse.json()

  const socket = new WebSocket(WS)
  const frames = []
  let pings = 0
  socket.on('message', (data) => frames.push({ at: Date.now(), ...JSON.parse(data.toString()) }))
  socket.on('ping', () => {
    pings += 1
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'auth', ticket }))
  return { socket, frames, pings: () => pings }
}

const waitFrame = async (frames, predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await sleep(50)
  }
  throw new Error(`Tiempo agotado esperando: ${what}`)
}

// --- preparacion: una subasta minima sembrada directamente -----------------------------------
psql(`delete from auction_bids where auction_id = '${AUCTION}'`)
psql(`delete from auctions where id = '${AUCTION}'`)
psql(`
  insert into auctions (id, seller_id, product_id, duration_hours, publisher_type, price_kind,
    publication_fee_credits, minimum_bid_credits, buy_now_credits, status, published_at, closes_at,
    inventory_commitment_id, fee_charge_id)
  values ('${AUCTION}', 'seller-verify', 'product-verify', 24, 'PLAYER', 'CREDITS',
    1, 1, null, 'ACTIVE', now(), now() + interval '24 hours', 'commitment-verify', 'charge-verify')
`)

const idleMiB = memoryMiB()
console.log(`Memoria en reposo (contenedor auction): ${idleMiB.toFixed(1)} MiB de 160`)

// --- 1. conexion larga a traves de Caddy -----------------------------------------------------
const sessions = []
for (let index = 0; index < 3; index += 1) sessions.push(await openSession())
for (const { socket, frames } of sessions) {
  await waitFrame(frames, (frame) => frame.type === 'authenticated', 5_000, 'authenticated')
  socket.send(JSON.stringify({ type: 'subscribe', channel: `auctions/${AUCTION}` }))
  socket.send(JSON.stringify({ type: 'subscribe', channel: 'auctions' }))
  await waitFrame(frames, (frame) => frame.type === 'subscribed', 5_000, 'subscribed')
}
const connectedMiB = memoryMiB()
console.log(`Memoria con 3 conexiones y 2 suscripciones cada una: ${connectedMiB.toFixed(1)} MiB`)

console.log(`Manteniendo las conexiones ${HOLD_SECONDS} s a traves de Caddy (sin trafico)...`)
const started = Date.now()
while ((Date.now() - started) / 1000 < HOLD_SECONDS) {
  await sleep(15_000)
  const open = sessions.filter(({ socket }) => socket.readyState === WebSocket.OPEN).length
  console.log(`  t=${Math.round((Date.now() - started) / 1000)}s: ${open}/3 conexiones abiertas`)
}

check(
  sessions.every(({ socket }) => socket.readyState === WebSocket.OPEN),
  `las 3 conexiones siguen abiertas tras ${HOLD_SECONDS} s sin trafico de aplicacion`,
)
check(
  sessions.every(({ pings }) => pings() >= 2),
  `el cliente recibio latidos del servidor (${sessions.map(({ pings }) => pings()).join(', ')} pings)`,
)

// --- una senal despues del tiempo de espera ---------------------------------------------------
const sentAt = Date.now()
psql(`
  insert into auction_bids (id, auction_id, bidder_id, amount_credits, placed_at, is_leader)
  values ('verify-bid-1', '${AUCTION}', 'bidder-verify', 10, now(), true)
`)
for (const { frames } of sessions) {
  const frame = await waitFrame(
    frames,
    (candidate) => candidate.type === 'signal' && candidate.channel === `auctions/${AUCTION}`,
    5_000,
    'senal de la puja tras la espera',
  )
  check(
    frame.signal.reason === 'BID_ACCEPTED' && frame.signal.revision === 1,
    `senal recibida ${frame.at - sentAt} ms despues de la puja (revision ${frame.signal.revision})`,
  )
}

// --- 2. memoria tras una rafaga de senales ----------------------------------------------------
console.log(`Rafaga de ${BURST} pujas...`)
psql(`
  insert into auction_bids (id, auction_id, bidder_id, amount_credits, placed_at, is_leader)
  select 'verify-burst-' || n, '${AUCTION}', 'bidder-verify', 10 + n, now(), false
  from generate_series(1, ${BURST}) as n
`)
await sleep(2_000)
const delivered = sessions[0].frames.filter(
  (frame) => frame.type === 'signal' && frame.channel === `auctions/${AUCTION}`,
).length
const afterBurstMiB = memoryMiB()
check(delivered === 1 + BURST, `la sesion recibio las ${1 + BURST} senales (recibio ${delivered})`)
console.log(`Memoria tras la rafaga: ${afterBurstMiB.toFixed(1)} MiB`)
check(afterBurstMiB < 160 * 0.8, `la memoria queda por debajo del 80 % del limite de 160 MiB`)

for (const { socket } of sessions) socket.close()
console.log(
  `\nResumen: reposo ${idleMiB.toFixed(1)} MiB | con conexiones ${connectedMiB.toFixed(1)} MiB | ` +
    `tras rafaga ${afterBurstMiB.toFixed(1)} MiB (limite 160 MiB)`,
)
