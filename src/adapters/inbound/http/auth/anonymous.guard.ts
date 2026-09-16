import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'

import { ALL_ROLES, type VerifiedIdentity } from '../../../../application/ports/TokenVerifierPort'
import type { RequestWithIdentity } from './decorators'

/**
 * Identidad que se atribuye a toda peticion cuando `AUTH_MODE=disabled`.
 *
 * El sujeto es la cadena literal `anonymous`, y eso es deliberado: sin
 * proveedor de identidad NO SE SABE quien realiza la peticion, y el dato que se
 * guarde debe decirlo en lugar de atribuirlo a una persona que nadie verifico.
 *
 * Se conceden TODOS los roles porque sin identidad no hay forma de distinguir
 * unos de otros, y denegar por defecto dejaria el servicio inutilizable en
 * desarrollo. No es una puerta trasera de produccion: un binario con
 * `NODE_ENV=production` y `AUTH_MODE=disabled` NO ARRANCA.
 */
export const ANONYMOUS_IDENTITY: VerifiedIdentity = {
  subject: 'anonymous',
  email: null,
  roles: new Set(ALL_ROLES),
}

/**
 * Guard que opera cuando no hay proveedor de identidad configurado.
 *
 * No verifica nada y no lo disimula: atribuye la identidad anonima y deja pasar.
 */
@Injectable()
export class AnonymousIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<RequestWithIdentity>().identity = ANONYMOUS_IDENTITY

    return true
  }
}
