import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import {
  INTERNAL_CLOCK_SKEW_MS,
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
  signatureMatches,
  timestampWithinWindow,
} from '../../../outbound/identity/internal-signature'
import type { ClockPort } from '../../../../application/ports/ClockPort'
import type { Logger } from '../../../../infrastructure/observability/logger'
import { IS_INTERNAL } from './decorators'

interface InternalRequest {
  readonly method?: string
  readonly originalUrl?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body?: unknown
}

export interface InternalServiceGuardOptions {
  readonly reflector: Reflector
  readonly secret: string | null
  readonly allowedServices: readonly string[]
  readonly clock: ClockPort
  readonly logger: Logger
  readonly skewMs?: number
}

/**
 * Guard del contrato interno entre servicios (`/api/internal/v1/...`).
 *
 * Aplica el mismo esquema HMAC-SHA256 que ya usan Account, Catalog, Commerce y
 * Player/Inventory: servicio, metodo, ruta, sello y resumen del JSON canonico.
 *
 * Se registra de forma GLOBAL y solo actua sobre rutas marcadas con
 * `@InternalOnly()`; el resto las deja pasar sin tocarlas.
 *
 * NO REVELA POR QUE FALLA. Distinguir «servicio no permitido» de «firma
 * incorrecta» o de «sello caducado» le diria a quien prueba exactamente que le
 * falta. El motivo se registra; la respuesta es siempre la misma.
 *
 * NO REGISTRA LA FIRMA NI EL SECRETO.
 *
 * SIN SECRETO CONFIGURADO, NIEGA con 503. Dejar pasar ante una configuracion
 * incompleta convertiria un despliegue a medias en un endpoint interno abierto.
 * Es 503 y no 401 porque el servicio no puede comprobar la peticion: culpar a
 * quien llama seria mentir sobre la causa.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly options: InternalServiceGuardOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const esInterna = this.options.reflector.getAllAndOverride<boolean | undefined>(IS_INTERNAL, [
      context.getHandler(),
      context.getClass(),
    ])

    if (esInterna !== true) {
      return true
    }

    const request = context.switchToHttp().getRequest<InternalRequest>()

    if (this.options.secret === null || this.options.secret.length === 0) {
      this.options.logger.error('internal_auth_sin_secreto', {
        detail: 'INTERNAL_SERVICE_AUTH_SECRET no esta configurado: el contrato interno niega.',
      })

      throw new ServiceUnavailableException('El contrato interno no esta disponible.')
    }

    const service = header(request, INTERNAL_SERVICE_HEADER)
    const timestamp = header(request, INTERNAL_TIMESTAMP_HEADER)
    const signature = header(request, INTERNAL_SIGNATURE_HEADER)

    if (service === undefined || timestamp === undefined || signature === undefined) {
      return this.reject('cabeceras_incompletas')
    }

    if (!this.options.allowedServices.includes(service)) {
      return this.reject('servicio_no_permitido')
    }

    if (
      !timestampWithinWindow(
        timestamp,
        this.options.clock.now(),
        this.options.skewMs ?? INTERNAL_CLOCK_SKEW_MS,
      )
    ) {
      return this.reject('sello_fuera_de_ventana')
    }

    // La ruta se toma sin la cadena de consulta: es la misma que firma quien
    // llama, y una diferencia aqui invalidaria toda firma sin que el motivo
    // fuera visible en ninguna parte.
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? ''

    const expected = signInternalRequest(this.options.secret, {
      service,
      method: request.method ?? 'POST',
      path,
      timestamp,
      body: request.body ?? {},
    })

    if (!signatureMatches(expected, signature)) {
      return this.reject('firma_invalida')
    }

    this.options.logger.info('internal_auth_aceptada', { service })

    return true
  }

  private reject(reason: string): never {
    this.options.logger.warn('internal_auth_rechazada', { reason })

    throw new UnauthorizedException('Peticion interna no autorizada.')
  }
}

const header = (request: InternalRequest, name: string): string | undefined => {
  const value = request.headers[name]

  return Array.isArray(value) ? value[0] : value
}
