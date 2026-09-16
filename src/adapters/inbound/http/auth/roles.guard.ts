import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { Role } from '../../../../application/ports/TokenVerifierPort'
import { REQUIRED_ROLES, type RequestWithIdentity } from './decorators'

/**
 * Comprueba que la identidad ya verificada posee alguno de los roles exigidos.
 *
 * Se ejecuta DESPUES de JwtAuthGuard y depende de que este haya dejado la
 * identidad en la peticion. Si no hay identidad, deniega: el orden de los
 * guards es una garantia, no una suposicion.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly Role[] | undefined>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ])

    if (required === undefined || required.length === 0) {
      return true
    }

    const identity = context.switchToHttp().getRequest<RequestWithIdentity>().identity

    if (identity === undefined) {
      throw new ForbiddenException('La peticion no lleva una identidad verificada.')
    }

    if (!required.some((exigido) => satisface(identity.roles, exigido))) {
      throw new ForbiddenException('La identidad no posee el rol necesario para esta operacion.')
    }

    return true
  }
}

/**
 * Decide si los roles de la identidad cubren el rol que la ruta exige.
 *
 * El super administrador satisface toda exigencia de administrador. Se resuelve
 * AQUI y no anadiendo `Role.SuperAdministrator` a cada `@Roles(...)`: olvidarlo
 * en una ruta nueva produce un 403 mudo, sin nada en la respuesta que lo
 * explique, y ese olvido no lo detecta ninguna prueba que no se haya escrito
 * pensando en el.
 *
 * La relacion es de UN SOLO SENTIDO: un administrador NO satisface lo que se
 * exige a un super administrador. Invertirla convertiria el rol raiz en un
 * sinonimo del otro y HU-39 dejaria de poder distinguirlos.
 */
const satisface = (poseidos: ReadonlySet<Role>, exigido: Role): boolean => {
  if (poseidos.has(exigido)) {
    return true
  }

  return exigido === Role.Administrator && poseidos.has(Role.SuperAdministrator)
}
