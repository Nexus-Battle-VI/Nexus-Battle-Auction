import { CognitoJwtVerifier } from 'aws-jwt-verify'

import {
  isRole,
  TokenVerificationError,
  type Role,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../../application/ports/TokenVerifierPort'

export interface CognitoTokenVerifierOptions {
  readonly userPoolId: string
  readonly clientId: string
}

/**
 * Verificador de testimonios emitidos por un user pool de Cognito.
 *
 * La comprobacion de firma la realiza `aws-jwt-verify`, que descarga y cachea
 * el JWKS del pool. No se implementa verificacion criptografica a mano: es la
 * clase de codigo donde un error sutil no falla, sino que acepta tokens
 * falsificados en silencio.
 *
 * Se verifica el token de ACCESO, no el de identidad. El de identidad describe
 * al usuario para la interfaz; el de acceso es el que autoriza una peticion, y
 * es el unico cuyo `client_id` puede comprobarse contra el cliente esperado.
 */
export class CognitoTokenVerifier implements TokenVerifierPort {
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>

  constructor(options: CognitoTokenVerifierOptions) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: options.userPoolId,
      clientId: options.clientId,
      tokenUse: 'access',
    })
  }

  /**
   * Descarga el JWKS por adelantado. Sin esto, la primera peticion protegida
   * paga la latencia de red y puede agotar su tiempo de espera.
   */
  async warmUp(): Promise<void> {
    await this.verifier.hydrate()
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: Awaited<ReturnType<typeof this.verifier.verify>>

    try {
      payload = await this.verifier.verify(token)
    } catch {
      // El motivo exacto no se propaga: distinguir "firma invalida" de
      // "caducado" ayuda a quien esta probando tokens falsificados.
      throw new TokenVerificationError()
    }

    return toVerifiedIdentity(payload)
  }
}

/**
 * Traduce el contenido del token a la identidad verificada.
 *
 * Es una funcion pura y exportada a proposito: es la parte del verificador que
 * decide QUE roles y QUE correo se aceptan, y debe poder probarse sin red y sin
 * un pool real. La comprobacion de firma, que es lo que no se debe
 * reimplementar, queda en la biblioteca.
 */
export const toVerifiedIdentity = (payload: Record<string, unknown>): VerifiedIdentity => {
  const subject = payload.sub

  // Un token sin `sub` no identifica a nadie, por muy valida que sea su firma.
  // Rellenar el hueco con cadena vacia lo dejaba pasar como identidad: dos
  // testimonios mal formados compartirian sujeto y, con el, lo que ese sujeto
  // posea. Falla como fallo de verificacion, y el guard responde 401.
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new TokenVerificationError()
  }

  return {
    subject,
    email: readVerifiedEmail(payload),
    roles: readRoles(payload),
  }
}

/**
 * El correo solo se acepta si el proveedor lo declara verificado. Un correo sin
 * verificar es una afirmacion del usuario, no un hecho comprobado, y usarlo para
 * decidir permisos permitiria suplantar a cualquiera con solo declararlo.
 */
const readVerifiedEmail = (payload: Record<string, unknown>): string | null => {
  const verified = payload.email_verified
  const email = payload.email

  if (verified !== true && verified !== 'true') {
    return null
  }

  return typeof email === 'string' && email.length > 0 ? email.toLowerCase() : null
}

/**
 * Los grupos que no corresponden a un rol conocido se descartan en silencio.
 * Aceptarlos convertiria el pool en una fuente de roles arbitrarios: bastaria
 * crear un grupo llamado como se quiera para inventar un permiso.
 */
const readRoles = (payload: Record<string, unknown>): ReadonlySet<Role> => {
  const groups = payload['cognito:groups']
  const roles = new Set<Role>()

  if (!Array.isArray(groups)) {
    return roles
  }

  for (const group of groups) {
    if (typeof group === 'string' && isRole(group)) {
      roles.add(group)
    }
  }

  return roles
}
