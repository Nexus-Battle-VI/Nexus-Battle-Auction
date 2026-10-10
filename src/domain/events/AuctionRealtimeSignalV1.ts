/**
 * EN-034. Senal de invalidacion que Auction difunde a los navegadores
 * (docs/contracts/auction-realtime-v1.md de Nexus-Battle-Infrastructure).
 *
 * NO es un evento de dominio entre servicios: no lleva ningun dato personal (ni postor, ni
 * vendedor, ni ganador). El cliente la usa para invalidar su cache y volver a leer por HTTP;
 * el estado autoritativo sigue siendo el de las consultas.
 */
export const AUCTION_REALTIME_SIGNAL_VERSION = 1 as const

export const AuctionRealtimeReason = {
  Published: 'PUBLISHED',
  BidAccepted: 'BID_ACCEPTED',
  BoughtNow: 'BOUGHT_NOW',
  Settled: 'SETTLED',
  Cancelled: 'CANCELLED',
} as const

export type AuctionRealtimeReason =
  (typeof AuctionRealtimeReason)[keyof typeof AuctionRealtimeReason]

export interface AuctionRealtimeSummary {
  readonly status: 'ACTIVE' | 'FINISHED' | 'SOLD' | 'CANCELLED'
  readonly currentBidCredits: number | null
  readonly bidCount: number
}

export interface AuctionRealtimeSignalV1 {
  readonly signalVersion: typeof AUCTION_REALTIME_SIGNAL_VERSION
  readonly signalId: string
  readonly auctionId: string
  readonly revision: number
  readonly reason: AuctionRealtimeReason
  readonly occurredAt: string
  readonly summary?: AuctionRealtimeSummary
}

/** Tamano maximo de una senal serializada: 1 KiB (contrato, seccion 5). */
export const AUCTION_REALTIME_SIGNAL_MAX_BYTES = 1024

const REASONS: ReadonlySet<string> = new Set(Object.values(AuctionRealtimeReason))
const STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'FINISHED', 'SOLD', 'CANCELLED'])

export const auctionRealtimeSignalId = (auctionId: string, revision: number): string =>
  `auction:${auctionId}:r${String(revision)}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseSummary = (value: unknown): AuctionRealtimeSummary | null => {
  if (!isRecord(value)) return null
  const { status, currentBidCredits, bidCount } = value
  if (typeof status !== 'string' || !STATUSES.has(status)) return null
  if (currentBidCredits !== null && !Number.isInteger(currentBidCredits)) return null
  if (typeof bidCount !== 'number' || !Number.isInteger(bidCount) || bidCount < 0) return null
  return {
    status: status as AuctionRealtimeSummary['status'],
    currentBidCredits: currentBidCredits as number | null,
    bidCount,
  }
}

/**
 * Convierte la carga del `NOTIFY auction_realtime` (migracion 021) en una senal. Devuelve `null`
 * ante cualquier carga mal formada: un aviso invalido se descarta y nunca llega a un cliente.
 * Los campos desconocidos se ignoran, de modo que la carga puede crecer sin romper al oyente.
 */
export const parseAuctionRealtimeNotice = (payload: string): AuctionRealtimeSignalV1 | null => {
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null

  const { auctionId, revision, reason, occurredAt } = raw
  if (typeof auctionId !== 'string' || auctionId.length === 0) return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null
  if (typeof reason !== 'string' || !REASONS.has(reason)) return null
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) return null

  const summary = parseSummary(raw.summary)
  const signal: AuctionRealtimeSignalV1 = {
    signalVersion: AUCTION_REALTIME_SIGNAL_VERSION,
    signalId: auctionRealtimeSignalId(auctionId, revision),
    auctionId,
    revision,
    reason: reason as AuctionRealtimeReason,
    occurredAt,
    ...(summary === null ? {} : { summary }),
  }

  return Buffer.byteLength(JSON.stringify(signal), 'utf8') <= AUCTION_REALTIME_SIGNAL_MAX_BYTES
    ? signal
    : null
}
