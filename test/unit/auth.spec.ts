import 'reflect-metadata'

import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import { toVerifiedIdentity } from '../../src/adapters/outbound/identity/CognitoTokenVerifier'
import { JwtAuthGuard } from '../../src/adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../src/adapters/inbound/http/auth/roles.guard'
import {
  ANONYMOUS_IDENTITY,
  AnonymousIdentityGuard,
} from '../../src/adapters/inbound/http/auth/anonymous.guard'
import {
  IS_PUBLIC,
  REQUIRED_ROLES,
  currentIdentityOf,
} from '../../src/adapters/inbound/http/auth/decorators'
import {
  Role,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AuthMode, ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'

interface FakeRequest {
  headers: Record<string, string | undefined>
  identity?: VerifiedIdentity
}

const contextFor = (request: FakeRequest, metadata: Record<string, unknown> = {}) => {
  const handler = (): void => undefined
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => contextFor,
  } as unknown as ExecutionContext

  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector

  return { context, reflector }
}

describe('Traduccion del token a identidad verificada', () => {
  it('acepta solo los grupos que corresponden a un rol conocido', () => {
    const identity = toVerifiedIdentity({
      sub: 'sujeto-1',
      'cognito:groups': ['ADMINISTRATOR', 'PLAYER', 'SUPER_ADMINISTRATOR', 'SUPERUSUARIO', 'admin'],
    })

    expect([...identity.roles].sort()).toEqual([
      Role.Administrator,
      Role.Player,
      Role.SuperAdministrator,
    ])
  })

  it('descarta el correo cuando el proveedor no lo declara verificado', () => {
    expect(toVerifiedIdentity({ sub: 's', email: 'a@b.test' }).email).toBeNull()
    expect(
      toVerifiedIdentity({ sub: 's', email: 'a@b.test', email_verified: false }).email,
    ).toBeNull()
  })

  it('acepta el correo verificado y lo normaliza', () => {
    expect(
      toVerifiedIdentity({ sub: 's', email: 'Ana@Nexus.TEST', email_verified: true }).email,
    ).toBe('ana@nexus.test')
  })

  /**
   * Antes se rellenaba con cadena vacia. Un token con firma valida pero sin
   * `sub` se convertia asi en una identidad utilizable, y todos los tokens mal
   * formados compartian sujeto: acabarian resolviendo al MISMO titular.
   */
  it.each([
    ['falta', {}],
    ['es vacio', { sub: '' }],
    ['no es una cadena', { sub: 42 }],
    ['es nulo', { sub: null }],
  ])('rechaza el token cuando el sujeto %s', (_caso, payload) => {
    expect(() => toVerifiedIdentity(payload)).toThrow(TokenVerificationError)
  })

  it('no otorga ningun rol cuando el token no trae grupos', () => {
    expect(toVerifiedIdentity({ sub: 's' }).roles.size).toBe(0)
    expect(toVerifiedIdentity({ sub: 's', 'cognito:groups': 'ADMINISTRATOR' }).roles.size).toBe(0)
  })
})

describe('JwtAuthGuard', () => {
  const identity: VerifiedIdentity = {
    subject: 'sujeto-1',
    email: null,
    roles: new Set([Role.Player]),
  }

  const verifier = (impl: TokenVerifierPort['verify']): TokenVerifierPort => ({ verify: impl })

  it('deja pasar una ruta publica sin mirar la cabecera', async () => {
    const { context, reflector } = contextFor({ headers: {} }, { [IS_PUBLIC]: true })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.reject(new Error('no deberia llamarse'))),
    )

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it.each([
    ['ausente', undefined],
    ['sin esquema', 'abc.def.ghi'],
    ['con esquema equivocado', 'Basic abc'],
    ['sin valor', 'Bearer '],
    // Con `split(' ')` a secas estas tres pasaban: se leia el segundo campo y
    // se ignoraba el resto de la cabecera en silencio.
    ['con un campo de mas', 'Bearer token sobra'],
    ['con espacio doble tras el esquema', 'Bearer  token'],
    ['con solo el esquema', 'Bearer'],
  ])('rechaza una cabecera %s', async (_caso, authorization) => {
    const { context, reflector } = contextFor({ headers: { authorization } })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.resolve(identity)),
    )

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('acepta el esquema en cualquier combinacion de mayusculas', async () => {
    const request: FakeRequest = { headers: { authorization: 'bEaReR token-valido' } }
    const { context, reflector } = contextFor(request)
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.resolve(identity)),
    )

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(request.identity).toEqual(identity)
  })

  it('traduce un fallo de verificacion a 401', async () => {
    const { context, reflector } = contextFor({ headers: { authorization: 'Bearer falso' } })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.reject(new TokenVerificationError())),
    )

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  /**
   * Si el JWKS no se puede alcanzar, el testimonio no es invalido: es que NO SE
   * HA PODIDO COMPROBAR. Responder 401 afirmaria algo que no se sabe, y ademas
   * ocultaria una caida de red detras de un error de credenciales.
   */
  it('no convierte un fallo de red en 401', async () => {
    const { context, reflector } = contextFor({ headers: { authorization: 'Bearer t' } })
    const guard = new JwtAuthGuard(
      reflector,
      verifier(() => Promise.reject(new Error('JWKS inalcanzable'))),
    )

    await expect(guard.canActivate(context)).rejects.not.toBeInstanceOf(UnauthorizedException)
  })
})

/**
 * El decorador se anuncia como `VerifiedIdentity`, sin `undefined`. Esa promesa
 * hay que sostenerla en tiempo de ejecucion: si algun dia un cambio en el orden
 * de los guards deja la peticion sin identidad, el controlador debe recibir un
 * 401 y no reventar con un `TypeError` que el cliente veria como un 500.
 */
describe('CurrentIdentity', () => {
  const resolve = (request: FakeRequest): VerifiedIdentity =>
    currentIdentityOf(contextFor(request).context)

  it('devuelve la identidad que dejo el guard', () => {
    const identity: VerifiedIdentity = {
      subject: 'sujeto-1',
      email: null,
      roles: new Set([Role.Player]),
    }

    expect(resolve({ headers: {}, identity })).toBe(identity)
  })

  it('responde 401 cuando la peticion no trae identidad', () => {
    expect(() => resolve({ headers: {} })).toThrow(UnauthorizedException)
  })
})

describe('RolesGuard', () => {
  const identityWith = (...roles: readonly Role[]): VerifiedIdentity => ({
    subject: 's',
    email: null,
    roles: new Set(roles),
  })

  it('deja pasar cuando la ruta no exige ningun rol', () => {
    const { context, reflector } = contextFor({ headers: {} })
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true)
  })

  it('deja pasar cuando la identidad tiene el rol exigido', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.Administrator) },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(new RolesGuard(reflector).canActivate(context)).toBe(true)
  })

  it('deniega cuando la identidad no tiene el rol exigido', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.Player, Role.Moderator) },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException)
  })

  /**
   * El grupo SUPER_ADMINISTRATOR existe en el pool desde que Account refleja el
   * rol, pero esta union no lo declaraba: `isRole` lo descartaba y la cuenta
   * llegaba sin ningun rol. El sintoma era un 403 que no decia nada.
   */
  it('deja pasar al super administrador donde se exige administrador', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.SuperAdministrator) },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(new RolesGuard(reflector).canActivate(context)).toBe(true)
  })

  /**
   * El control del caso anterior. La relacion es de un solo sentido: si tambien
   * pasara al reves, el rol raiz seria un sinonimo del administrador y la
   * prueba de arriba pasaria por construccion, sin comprobar nada.
   */
  it('NO deja pasar al administrador donde se exige super administrador', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.Administrator) },
      { [REQUIRED_ROLES]: [Role.SuperAdministrator] },
    )

    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException)
  })

  it('GAME_MASTER exige simultaneamente rol y subject configurado', () => {
    const required = { [REQUIRED_ROLES]: [Role.GameMaster] }
    const allowed = contextFor(
      { headers: {}, identity: { ...identityWith(Role.GameMaster), subject: 'upb-company' } },
      required,
    )
    expect(new RolesGuard(allowed.reflector, 'upb-company').canActivate(allowed.context)).toBe(true)

    for (const identity of [
      { ...identityWith(Role.GameMaster), subject: 'otro' },
      { ...identityWith(Role.SuperAdministrator), subject: 'upb-company' },
      { ...identityWith(Role.Administrator), subject: 'upb-company' },
    ]) {
      const denied = contextFor({ headers: {}, identity }, required)
      expect(() =>
        new RolesGuard(denied.reflector, 'upb-company').canActivate(denied.context),
      ).toThrow(ForbiddenException)
    }
  })

  it('GAME_MASTER falla cerrado cuando falta el subject configurado', () => {
    const { context, reflector } = contextFor(
      { headers: {}, identity: identityWith(Role.GameMaster) },
      { [REQUIRED_ROLES]: [Role.GameMaster] },
    )

    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException)
  })

  /**
   * Sin identidad no se puede autorizar. Devolver `true` aqui convertiria un
   * fallo en el orden de los guards en una ruta abierta.
   */
  it('deniega cuando no hay identidad verificada en la peticion', () => {
    const { context, reflector } = contextFor(
      { headers: {} },
      { [REQUIRED_ROLES]: [Role.Administrator] },
    )

    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(ForbiddenException)
  })
})

describe('AnonymousIdentityGuard', () => {
  it('atribuye el sujeto literal `anonymous`, que es lo que de verdad se sabe', () => {
    const request: FakeRequest = { headers: {} }
    const { context } = contextFor(request)

    expect(new AnonymousIdentityGuard().canActivate(context)).toBe(true)
    expect(request.identity).toBe(ANONYMOUS_IDENTITY)
    expect(request.identity?.subject).toBe('anonymous')
  })

  it('concede todos los roles: sin identidad no hay forma de distinguirlos', () => {
    expect(ANONYMOUS_IDENTITY.roles.has(Role.Administrator)).toBe(true)
    expect(ANONYMOUS_IDENTITY.roles.has(Role.Moderator)).toBe(true)
    expect(ANONYMOUS_IDENTITY.roles.has(Role.Player)).toBe(true)
    expect(ANONYMOUS_IDENTITY.roles.has(Role.SuperAdministrator)).toBe(true)
    expect(ANONYMOUS_IDENTITY.roles.has(Role.GameMaster)).toBe(true)
  })
})

describe('Configuracion de autenticacion', () => {
  it('desactiva la autenticacion por defecto, que es el estado del BLOCKER', () => {
    const config = loadConfig({})

    expect(config.authMode).toBe(AuthMode.Disabled)
    expect(config.cognito).toBeNull()
    expect(config.gameMasterSubject).toBeNull()
  })

  /**
   * La comprobacion mas importante del fichero: un binario de produccion sin
   * verificacion de identidad NO ARRANCA. Un aviso en el registro se pasa por
   * alto; un arranque que falla, no.
   */
  it('impide arrancar en produccion sin verificacion de identidad', () => {
    // La persistencia se declara completa a proposito: sin ella, la
    // configuracion fallaria por el driver en memoria y esta prueba pasaria
    // sin haber comprobado la regla de identidad.
    const persistence = { PERSISTENCE_DRIVER: 'postgres', DATABASE_URL: 'postgres://db/auction' }

    expect(() =>
      loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled', ...persistence }),
    ).toThrow(/AUTH_MODE/)
    expect(() => loadConfig({ NODE_ENV: 'production', ...persistence })).toThrow(/AUTH_MODE/)
  })

  it('exige el pool y el cliente cuando la autenticacion esta activa', () => {
    expect(() => loadConfig({ AUTH_MODE: 'jwt' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ AUTH_MODE: 'jwt', COGNITO_USER_POOL_ID: 'p' })).toThrow(
      ConfigurationError,
    )
  })

  it('acepta produccion cuando la autenticacion esta completa', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://db/auction',
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_abc',
      COGNITO_CLIENT_ID: 'cliente',
    })

    expect(config.cognito).toEqual({ userPoolId: 'us-east-1_abc', clientId: 'cliente' })
  })

  it('normaliza el subject del Maestro de Juego sin inventar un valor por defecto', () => {
    expect(loadConfig({ GAME_MASTER_SUBJECT: '  subject-upb-company  ' }).gameMasterSubject).toBe(
      'subject-upb-company',
    )
    expect(loadConfig({ GAME_MASTER_SUBJECT: '   ' }).gameMasterSubject).toBeNull()
  })
})
