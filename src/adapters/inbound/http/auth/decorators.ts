import {
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common'

import type { Role, VerifiedIdentity } from '../../../../application/ports/TokenVerifierPort'

export const IS_PUBLIC = 'auth:public'
export const IS_INTERNAL = 'auth:internal'
export const InternalOnly = (): MethodDecorator & ClassDecorator => SetMetadata(IS_INTERNAL, true)
export const REQUIRED_ROLES = 'auth:roles'

/**
 * Marca una ruta como accesible sin testimonio.
 *
 * La proteccion es el comportamiento por defecto: el guard se registra de forma
 * global y hay que EXCLUIR explicitamente lo que deba ser publico. Al reves
 * —proteger ruta por ruta— cualquier endpoint nuevo naceria desprotegido, y ese
 * olvido no falla ninguna prueba.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true)

/** Exige que el testimonio incluya al menos uno de los roles indicados. */
export const Roles = (...roles: readonly Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES, roles)

export interface RequestWithIdentity {
  identity?: VerifiedIdentity
}

/**
 * Inyecta la identidad ya verificada. Nunca lee nada del cuerpo ni de la
 * cabecera: solo lo que el guard dejo tras comprobar la firma.
 *
 * Es lo que permite que un identificador de persona deje de ser un dato que el
 * cliente declara y pase a ser un dato que el proveedor demuestra.
 */
export const currentIdentityOf = (context: ExecutionContext): VerifiedIdentity => {
  const { identity } = context.switchToHttp().getRequest<RequestWithIdentity>()

  // Hoy no puede ocurrir: un guard u otro deja siempre identidad. Pero el tipo
  // que veian los controladores decia `VerifiedIdentity` mientras el valor podia
  // ser `undefined`, y bastaria reordenar los guards para que la ausencia se
  // manifestara como un `TypeError` —un 500— en vez de como lo que seria: una
  // peticion sin identidad. Falla cerrado y con el codigo que corresponde.
  if (identity === undefined) {
    throw new UnauthorizedException('La peticion no llego con una identidad verificada.')
  }

  return identity
}

export const CurrentIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedIdentity => currentIdentityOf(context),
)
