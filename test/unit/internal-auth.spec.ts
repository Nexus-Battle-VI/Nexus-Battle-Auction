import 'reflect-metadata'

import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import { IS_INTERNAL } from '../../src/adapters/inbound/http/auth/decorators'
import { InternalServiceGuard } from '../../src/adapters/inbound/http/auth/internal-service.guard'
import { CognitoTokenVerifier } from '../../src/adapters/outbound/identity/CognitoTokenVerifier'
import {
  canonicalBody,
  canonicalString,
  signatureMatches,
  signInternalRequest,
  timestampWithinWindow,
} from '../../src/adapters/outbound/identity/internal-signature'
import { TokenVerificationError } from '../../src/application/ports/TokenVerifierPort'
import type { Logger } from '../../src/infrastructure/observability/logger'

const NOW = new Date('2026-09-16T12:00:00.000Z')
const SECRET = 'secreto-de-pruebas'
const PATH = '/api/internal/v1/auction/probe'

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

interface FakeRequest {
  method?: string
  originalUrl?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

const contextFor = (request: FakeRequest, internal: boolean | undefined) => {
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext
  const reflector = {
    getAllAndOverride: (key: string) => (key === IS_INTERNAL ? internal : undefined),
  } as unknown as Reflector

  return { context, reflector }
}

const guardFor = (reflector: Reflector, secret: string | null = SECRET) =>
  new InternalServiceGuard({
    reflector,
    secret,
    allowedServices: ['auction'],
    clock: { now: () => NOW },
    logger: silentLogger,
  })

const signedRequest = (overrides: Partial<Record<string, string>> = {}): FakeRequest => {
  const body = { operationId: 'op-1', amount: 5 }
  const service = overrides.service ?? 'auction'
  const timestamp = overrides.timestamp ?? String(NOW.getTime())
  const signature =
    overrides.signature ??
    signInternalRequest(SECRET, { service, method: 'POST', path: PATH, timestamp, body })

  return {
    method: 'POST',
    originalUrl: `${PATH}?ignorada=1`,
    headers: {
      'x-internal-service': service,
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body,
  }
}

describe('Firma interna entre servicios', () => {
  it('serializa el cuerpo con claves ordenadas y sin indefinidos', () => {
    expect(canonicalBody({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}')
    expect(canonicalBody(undefined)).toBe('null')
  })

  it('firma metodo, ruta, sello y resumen del cuerpo', () => {
    const lines = canonicalString({
      service: 'auction',
      method: 'post',
      path: PATH,
      timestamp: '1',
      body: {},
    }).split('\n')

    expect(lines.slice(0, 4)).toEqual(['auction', 'POST', PATH, '1'])
    expect(lines[4]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('compara firmas sin aceptar ausentes ni longitudes distintas', () => {
    expect(signatureMatches('abc', 'abc')).toBe(true)
    expect(signatureMatches('abc', 'abd')).toBe(false)
    expect(signatureMatches('abc', 'ab')).toBe(false)
    expect(signatureMatches('abc', undefined)).toBe(false)
  })

  it('acota la ventana del sello', () => {
    expect(timestampWithinWindow(String(NOW.getTime() - 30_000), NOW, 30_000)).toBe(true)
    expect(timestampWithinWindow(String(NOW.getTime() - 30_001), NOW, 30_000)).toBe(false)
    expect(timestampWithinWindow('no-es-numero', NOW, 30_000)).toBe(false)
  })
})

describe('InternalServiceGuard', () => {
  it('no actua sobre rutas que no son internas', () => {
    const { context, reflector } = contextFor({ headers: {} }, undefined)

    expect(guardFor(reflector).canActivate(context)).toBe(true)
  })

  it('acepta una peticion firmada por un servicio autorizado', () => {
    const { context, reflector } = contextFor(signedRequest(), true)

    expect(guardFor(reflector).canActivate(context)).toBe(true)
  })

  it('niega con 503 cuando no hay secreto configurado', () => {
    const { context, reflector } = contextFor(signedRequest(), true)

    expect(() => guardFor(reflector, null).canActivate(context)).toThrow(
      ServiceUnavailableException,
    )
  })

  /**
   * Cada caso rompe UNA sola condicion de la peticion aceptada arriba, que es
   * su control: si la peticion base no pasara, todos estos rechazos serian
   * ciertos por construccion y no demostrarian nada.
   */
  it.each([
    ['le faltan cabeceras', { headers: {}, body: {} }],
    ['la envia un servicio no autorizado', signedRequest({ service: 'catalog' })],
    [
      'el sello esta fuera de ventana',
      signedRequest({ timestamp: String(NOW.getTime() - 60_000) }),
    ],
    ['la firma no corresponde', signedRequest({ signature: 'f'.repeat(64) })],
  ])('rechaza con 401 cuando %s', (_caso, request) => {
    const { context, reflector } = contextFor(request, true)

    expect(() => guardFor(reflector).canActivate(context)).toThrow(UnauthorizedException)
  })

  it('toma la primera cabecera cuando llega repetida', () => {
    const request = signedRequest()
    request.headers['x-internal-service'] = ['auction', 'catalog']
    const { context, reflector } = contextFor(request, true)

    expect(guardFor(reflector).canActivate(context)).toBe(true)
  })
})

describe('CognitoTokenVerifier', () => {
  it('traduce un testimonio mal formado a fallo de verificacion sin detalle', async () => {
    const verifier = new CognitoTokenVerifier({
      userPoolId: 'us-east-1_pruebas',
      clientId: 'cliente-de-pruebas',
    })

    await expect(verifier.verify('no-es-un-jwt')).rejects.toBeInstanceOf(TokenVerificationError)
  })
})
