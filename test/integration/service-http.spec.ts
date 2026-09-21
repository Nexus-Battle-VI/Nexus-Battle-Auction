import 'reflect-metadata'

import { Body, Controller, Get, Post, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import request from 'supertest'

import {
  CurrentIdentity,
  InternalOnly,
  Public,
  Roles,
} from '../../src/adapters/inbound/http/auth/decorators'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { ActiveAuctionLimitExceededError } from '../../src/application/errors/AuctionPersistenceError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule, INTERNAL_CALLERS } from '../../src/infrastructure/bootstrap/app.module'
import { PublishAuction } from '../../src/application/use-cases/PublishAuction'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'

/**
 * Controlador SOLO de prueba. El andamiaje no tiene todavia rutas de negocio, y
 * lo que hay que demostrar es que la proteccion global aplica a cualquier ruta
 * nueva que una Historia de Usuario anada: nace protegida, y abrirla o
 * restringirla es una decision explicita.
 */
@Controller('probe')
class ProbeController {
  @Get('protegida')
  protegida(@CurrentIdentity() identity: VerifiedIdentity): { subject: string } {
    return { subject: identity.subject }
  }

  @Public()
  @Get('publica')
  publica(): { ok: true } {
    return { ok: true }
  }

  @Roles(Role.Administrator)
  @Get('administracion')
  administracion(): { ok: true } {
    return { ok: true }
  }

  @InternalOnly()
  @Post('interna')
  interna(@Body() body: unknown): { recibido: unknown } {
    return { recibido: body }
  }
}

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador': { subject: 'sujeto-jugador', email: null, roles: new Set([Role.Player]) },
  'token-super': {
    subject: 'sujeto-super',
    email: null,
    roles: new Set([Role.Player, Role.SuperAdministrator]),
  },
  'token-admin': {
    subject: 'sujeto-admin',
    email: null,
    roles: new Set([Role.Administrator]),
  },
}

const publishedAuction = {
  id: 'auction-created',
  sellerId: 'sujeto-jugador',
  productId: 'product-ok',
  durationHours: 24 as const,
  publicationFeeCredits: 1,
  minimumBidCredits: 10,
  buyNowCredits: 20,
  status: 'ACTIVE' as const,
  publishedAt: new Date('2026-09-21T12:00:00.000Z'),
  closesAt: new Date('2026-09-22T12:00:00.000Z'),
}

const publishAuctionStub = {
  execute: jest.fn((command: { productId: string }) => {
    if (command.productId === 'product-sanction') {
      return Promise.reject(
        new AuctionRuleViolation(AuctionRuleCode.SellerSanctioned, 'Vendedor sancionado.'),
      )
    }
    if (command.productId === 'product-limit') {
      return Promise.reject(new ActiveAuctionLimitExceededError())
    }
    if (command.productId === 'product-price') {
      return Promise.reject(
        new AuctionRuleViolation(
          AuctionRuleCode.InvalidBuyNowPrice,
          'El precio de compra inmediata debe superar la puja minima.',
        ),
      )
    }
    if (command.productId === 'product-unavailable') {
      return Promise.reject(new ExternalDependencyUnavailableError('catalog'))
    }
    return Promise.resolve({ ...publishedAuction, productId: command.productId })
  }),
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const SECRET = 'secreto-de-integracion'

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

const buildApp = async (): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)
    .overrideProvider(PublishAuction)
    .useValue(publishAuctionStub)
    .compile()

  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()

  return app
}

describe('Servicio con autenticacion activa', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      PERSISTENCE_DRIVER: 'memory',
    })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  describe('Sondas', () => {
    it('responden sin testimonio', async () => {
      const server = app.getHttpServer()

      expect((await request(server).get('/api/health/live')).status).toBe(200)
      expect((await request(server).get('/api/health/ready')).body).toEqual({
        status: 'ok',
        checks: {},
      })
      expect((await request(server).get('/api/version')).body).toMatchObject({
        service: 'nexus-battle-auction',
      })
    })
  })

  describe('Una ruta nueva nace protegida', () => {
    it('responde 401 sin testimonio', async () => {
      expect((await request(app.getHttpServer()).get('/api/probe/protegida')).status).toBe(401)
    })

    it('responde 401 con un testimonio que no verifica', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/protegida')
        .set('Authorization', 'Bearer token-falso')

      expect(response.status).toBe(401)
    })

    it('toma la identidad del testimonio verificado', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/protegida')
        .set('Authorization', 'Bearer token-jugador')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ subject: 'sujeto-jugador' })
    })

    it('abrir una ruta es explicito', async () => {
      expect((await request(app.getHttpServer()).get('/api/probe/publica')).status).toBe(200)
    })
  })

  describe('Roles', () => {
    it('deniega con 403 a quien no tiene el rol', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/administracion')
        .set('Authorization', 'Bearer token-jugador')

      expect(response.status).toBe(403)
    })

    it('el super administrador satisface la exigencia de administrador', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/administracion')
        .set('Authorization', 'Bearer token-super')

      expect(response.status).toBe(200)
    })
  })

  describe('Publicacion de subastas', () => {
    const validBody = {
      productId: 'product-ok',
      durationHours: 24,
      minimumBidCredits: 10,
      buyNowCredits: 20,
    }

    const publish = (token = 'token-jugador', body: Record<string, unknown> = validBody) =>
      request(app.getHttpServer())
        .post('/api/v1/auctions')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'operation-1')
        .send(body)

    beforeEach(() => publishAuctionStub.execute.mockClear())

    it('responde 201 y usa el sujeto verificado como vendedor', async () => {
      const response = await publish()

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        id: 'auction-created',
        sellerId: 'sujeto-jugador',
        status: 'ACTIVE',
        publicationFeeCredits: 1,
      })
      expect(publishAuctionStub.execute).toHaveBeenCalledWith(
        expect.objectContaining({ sellerId: 'sujeto-jugador', operationId: 'operation-1' }),
      )
    })

    it('responde 401 sin access token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions')
        .set('Idempotency-Key', 'operation-1')
        .send(validBody)
      expect(response.status).toBe(401)
    })

    it('responde 403 si la identidad no tiene rol PLAYER', async () => {
      expect((await publish('token-admin')).status).toBe(403)
    })

    it('responde 400 ante campos desconocidos o sin clave idempotente', async () => {
      const unknownField = await publish('token-jugador', { ...validBody, sellerId: 'otro' })
      expect(unknownField.status).toBe(400)
      expect(unknownField.body).toMatchObject({ code: 'INVALID_REQUEST' })
      const missingKey = await request(app.getHttpServer())
        .post('/api/v1/auctions')
        .set('Authorization', 'Bearer token-jugador')
        .send(validBody)
      expect(missingKey.status).toBe(400)
      expect(missingKey.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })
    })

    it.each([
      ['product-sanction', 403, AuctionRuleCode.SellerSanctioned],
      ['product-limit', 409, AuctionRuleCode.ActiveAuctionLimitReached],
      ['product-price', 422, AuctionRuleCode.InvalidBuyNowPrice],
      ['product-unavailable', 503, 'DEPENDENCY_UNAVAILABLE'],
    ])('mapea %s a HTTP %i con codigo estable', async (productId, status, code) => {
      const response = await publish('token-jugador', { ...validBody, productId })
      expect(response.status).toBe(status)
      expect(response.body).toMatchObject({ statusCode: status, code })
    })

    it('publica en OpenAPI la operacion, seguridad, entrada y respuestas estables', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      )
      const operation = document.paths['/api/v1/auctions']?.post

      expect(operation).toBeDefined()
      expect(operation?.security).toEqual([{ bearer: [] }])
      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }),
        ]),
      )
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403', '409', '422', '503']),
      )
    })
  })

  describe('Contrato interno', () => {
    const body = { operationId: 'op-1' }
    const path = '/api/probe/interna'

    const signed = (service: string) => {
      const timestamp = String(Date.now())

      return request(app.getHttpServer())
        .post(path)
        .set('x-internal-service', service)
        .set('x-internal-timestamp', timestamp)
        .set(
          'x-internal-signature',
          signInternalRequest(SECRET, { service, method: 'POST', path, timestamp, body }),
        )
        .send(body)
    }

    /**
     * ADR-019 no declara todavia consumidores de las rutas internas de este
     * servicio, asi que una firma valida de cualquier servicio se rechaza. El
     * control de que una firma correcta SI se acepta esta en
     * `test/unit/internal-auth.spec.ts`. Cuando una Historia de Usuario anada
     * un consumidor, esta prueba debe pasar a comprobar que se acepta.
     */
    it('no acepta a ningun servicio mientras ADR-019 no declare consumidores', async () => {
      expect(INTERNAL_CALLERS).toEqual([])
      expect((await signed('wallet')).status).toBe(401)
    })

    it('rechaza a un servicio que no es consumidor', async () => {
      expect((await signed('catalog')).status).toBe(401)
    })

    it('rechaza una peticion sin firma', async () => {
      expect((await request(app.getHttpServer()).post(path).send(body)).status).toBe(401)
    })
  })
})

describe('Servicio sin autenticacion (solo desarrollo)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({ AUTH_MODE: 'disabled', PERSISTENCE_DRIVER: 'memory' })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('atribuye la identidad anonima en lugar de inventar una persona', async () => {
    const response = await request(app.getHttpServer()).get('/api/probe/protegida')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ subject: 'anonymous' })
  })

  it('el contrato interno sigue exigiendo firma y niega sin secreto', async () => {
    const response = await request(app.getHttpServer()).post('/api/probe/interna').send({})

    expect(response.status).toBe(503)
  })
})
