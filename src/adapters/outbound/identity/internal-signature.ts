import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const INTERNAL_SERVICE_HEADER = 'x-internal-service'
export const INTERNAL_TIMESTAMP_HEADER = 'x-internal-timestamp'
export const INTERNAL_SIGNATURE_HEADER = 'x-internal-signature'

export interface CanonicalRequest {
  readonly service: string
  readonly method: string
  readonly path: string
  readonly timestamp: string
  readonly body: unknown
}

/**
 * Serializacion determinista del cuerpo, con las claves ordenadas.
 *
 * Debe producir EXACTAMENTE el mismo texto que la funcion equivalente de
 * Account: es lo unico que hace que las dos partes lleguen a la misma firma.
 * Las claves se ordenan porque `JSON.stringify` respeta el orden de insercion,
 * y dos objetos equivalentes con las claves en distinto orden produzcan firmas
 * distintas seria un rechazo sin explicacion visible.
 *
 * SE DUPLICA A PROPOSITO, igual que el verificador de testimonios de este
 * servicio. Un paquete comun de identidad acoplaria los servicios: cualquier
 * cambio obligaria a un despliegue coordinado, y el limite entre contextos
 * dejaria de existir en la practica. El precio es esta copia; el contrato que
 * ambas partes deben respetar esta descrito en los dos ficheros.
 */
export const canonicalBody = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalBody).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalBody(v)}`)

  return `{${entries.join(',')}}`
}

/**
 * Cadena canonica que se firma: servicio, metodo, ruta, sello y resumen del
 * cuerpo, uno por linea.
 *
 * Firmar mas que el cuerpo es el punto. Un secreto compartido enviado tal cual
 * demuestra que quien llama lo conoce, pero no ata la peticion: interceptada
 * una, serviria para cualquier otra ruta o metodo.
 */
export const canonicalString = (request: CanonicalRequest): string =>
  [
    request.service,
    request.method.toUpperCase(),
    request.path,
    request.timestamp,
    createHash('sha256').update(canonicalBody(request.body), 'utf8').digest('hex'),
  ].join('\n')

export const signInternalRequest = (secret: string, request: CanonicalRequest): string =>
  createHmac('sha256', secret).update(canonicalString(request), 'utf8').digest('hex')

/**
 * Ventana admitida entre el sello de la peticion y el reloj de quien verifica.
 *
 * Acota la reutilizacion de una firma interceptada. Treinta segundos absorben la
 * deriva normal entre dos nodos sin dejar una ventana comoda.
 */
export const INTERNAL_CLOCK_SKEW_MS = 30_000

/**
 * Comparacion en tiempo constante.
 *
 * Un `===` sobre firmas tarda mas cuanto mas prefijo coincide, y esa diferencia
 * es medible: permite reconstruir la firma byte a byte sin conocer el secreto.
 */
export const signatureMatches = (expected: string, received: string | undefined): boolean => {
  if (received === undefined) {
    return false
  }

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')

  return a.length === b.length && timingSafeEqual(a, b)
}

/** Cierto si el sello de la peticion cae dentro de la ventana admitida. */
export const timestampWithinWindow = (timestamp: string, now: Date, skewMs: number): boolean => {
  const sent = Number(timestamp)

  if (!Number.isFinite(sent)) {
    return false
  }

  return Math.abs(now.getTime() - sent) <= skewMs
}
