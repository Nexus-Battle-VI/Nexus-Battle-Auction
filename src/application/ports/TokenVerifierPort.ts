/**
 * Puerto de verificacion del testimonio de identidad.
 *
 * Este servicio no emite tokens ni custodia claves: solo comprueba que el
 * testimonio que acompana a la peticion lo firmo el proveedor de identidad y
 * que sigue siendo valido. Vease ADR-004.
 *
 * La verificacion es un puerto y no una llamada directa a una biblioteca para
 * que las pruebas puedan ejercitar la autorizacion sin depender de una red ni
 * de un proveedor real.
 */

/**
 * Vocabulario de roles que el proveedor de identidad puede afirmar.
 *
 * Vive aqui, junto al puerto, y NO en el dominio: el dominio de este servicio
 * no tiene ningun concepto de rol. La fuente de verdad de los roles es el
 * servicio de cuentas; esto es la forma en que llegan.
 *
 * Se duplica en cada servicio a proposito. Un paquete comun de identidad
 * acoplaria los cinco servicios: cualquier cambio obligaria a un despliegue
 * coordinado, y el limite entre contextos dejaria de existir en la practica.
 */
export const Role = {
  Player: 'PLAYER',
  Moderator: 'MODERATOR',
  Administrator: 'ADMINISTRATOR',
  /**
   * Rol raiz del sistema (HU-02, HU-39).
   *
   * Estaba ausente de esta union y el grupo SI existe en el pool, de modo que
   * `isRole` lo descartaba: una cuenta que solo lo tuviera llegaba aqui sin
   * ningun rol y recibia 403 en toda ruta administrativa, sin nada en la
   * respuesta que explicara por que. La fuente de verdad del rol es Account;
   * esto es solo la forma en que llega, y tiene que reconocer lo que llega.
   */
  SuperAdministrator: 'SUPER_ADMINISTRATOR',
} as const

export type Role = (typeof Role)[keyof typeof Role]

export const ALL_ROLES: readonly Role[] = [
  Role.Player,
  Role.Moderator,
  Role.Administrator,
  Role.SuperAdministrator,
]

export const isRole = (value: string): value is Role =>
  (ALL_ROLES as readonly string[]).includes(value)

export interface VerifiedIdentity {
  /** `sub` del proveedor. Es estable: un correo no lo es. */
  readonly subject: string

  /** Presente solo si el proveedor declara el correo como verificado. */
  readonly email: string | null

  /** Roles reconocidos. Los grupos desconocidos se descartan. */
  readonly roles: ReadonlySet<Role>
}

export interface TokenVerifierPort {
  verify(token: string): Promise<VerifiedIdentity>
}

/**
 * Fallo de verificacion. Deliberadamente sin detalle: el motivo exacto por el
 * que un token no es valido es informacion util para quien lo esta falsificando.
 */
export class TokenVerificationError extends Error {
  constructor(message = 'El testimonio de identidad no es valido.') {
    super(message)
    this.name = 'TokenVerificationError'
  }
}

export const TOKEN_VERIFIER = Symbol('TokenVerifierPort')
