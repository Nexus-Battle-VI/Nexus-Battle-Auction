import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import {
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../../../application/ports/TokenVerifierPort'
import { IS_INTERNAL, IS_PUBLIC, type RequestWithIdentity } from './decorators'

interface RequestWithAuthHeader extends RequestWithIdentity {
  headers: Record<string, string | string[] | undefined>
}

/**
 * Comprueba el testimonio de identidad de toda peticion que no este marcada
 * como publica.
 *
 * Se registra de forma GLOBAL. Un endpoint nuevo nace protegido y hay que
 * abrirlo a proposito; lo contrario haria que un olvido produjera una ruta
 * abierta sin que ninguna prueba lo advirtiera.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifierPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])

    const internal = this.reflector.getAllAndOverride<boolean>(IS_INTERNAL, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic === true || internal) {
      return true
    }

    const request = context.switchToHttp().getRequest<RequestWithAuthHeader>()
    const token = JwtAuthGuard.readBearerToken(request.headers.authorization)

    if (token === null) {
      throw new UnauthorizedException('Falta el testimonio de identidad.')
    }

    try {
      request.identity = await this.verifier.verify(token)
    } catch (error: unknown) {
      if (error instanceof TokenVerificationError) {
        throw new UnauthorizedException(error.message)
      }

      // Un fallo que no es de verificacion —red, JWKS inalcanzable— no debe
      // traducirse a 401: eso diria que el testimonio es invalido cuando lo que
      // ocurre es que no se ha podido comprobar. Se propaga como 500.
      throw error
    }

    return true
  }

  private static readBearerToken(header: string | string[] | undefined): string | null {
    if (typeof header !== 'string') {
      return null
    }

    // Exactamente dos campos. Con `split(' ')` a secas, `Bearer token sobra`
    // pasaria leyendo solo el segundo: se aceptaria una cabecera que ningun
    // cliente correcto envia, y que si envia quien esta tanteando el limite.
    const parts = header.split(' ')

    if (parts.length !== 2) {
      return null
    }

    const [scheme, value] = parts

    if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.length === 0) {
      return null
    }

    return value
  }
}
