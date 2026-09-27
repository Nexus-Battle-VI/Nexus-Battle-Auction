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
import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import {
  ActiveAuctionLimitExceededError,
  ConcurrentBidConflictError,
  IdempotencyConflictError,
  InsufficientPublicationFundsError,
  PersistedAuctionNotFoundError,
  ProductNotEligibleForOfficialAuctionError,
} from '../../src/application/errors/AuctionPersistenceError'
import { InsufficientBidCreditsError } from '../../src/application/errors/BidCreditError'
import { AuctionNotFoundError } from '../../src/application/errors/BuyNowRequestError'
import { AuctionAlreadyClosedError } from '../../src/application/errors/BuyNowTransactionError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { ConfigureAutoBid } from '../../src/application/use-cases/ConfigureAutoBid'
import { AppModule, INTERNAL_CALLERS } from '../../src/infrastructure/bootstrap/app.module'
import { ExecuteBuyNowUseCase } from '../../src/application/use-cases/ExecuteBuyNowUseCase'
import { PublishAuction } from '../../src/application/use-cases/PublishAuction'
import { PublishOfficialAuction } from '../../src/application/use-cases/PublishOfficialAuction'
import { RegisterBid } from '../../src/application/use-cases/RegisterBid'
import { AuctionRuleCode, AuctionRuleViolation } from '../../src/domain/errors/AuctionRuleViolation'
import { AutoBidRuleCode, AutoBidRuleViolation } from '../../src/domain/errors/AutoBidRuleViolation'
import { BidRuleCode, BidRuleViolation } from '../../src/domain/errors/BidRuleViolation'
import {
  BuyNowRuleCode,
  BuyNowRuleViolation,
  InsufficientCreditsViolation,
} from '../../src/domain/errors/BuyNowRuleViolation'

/**
 * Controlador SOLO de prueba. Lo que se demuestra aqui es que la proteccion
 * global aplica a cualquier ruta nueva: nace protegida, y abrirla o
 * restringirla es una decision explicita.
 */
@Controller('probe')
class ProbeController {
  @Get('protegida')
  protegida(@CurrentIdentity() identity: VerifiedIdentity): {
    subject: string
  } {
    return {
      subject: identity.subject,
    }
  }

  @Public()
  @Get('publica')
  publica(): {
    ok: true
  } {
    return {
      ok: true,
    }
  }

  @Roles(Role.Administrator)
  @Get('administracion')
  administracion(): {
    ok: true
  } {
    return {
      ok: true,
    }
  }

  @Roles(Role.GameMaster)
  @Get('maestro-juego')
  maestroJuego(@CurrentIdentity() identity: VerifiedIdentity): { subject: string } {
    return { subject: identity.subject }
  }

  @InternalOnly()
  @Post('interna')
  interna(@Body() body: unknown): {
    recibido: unknown
  } {
    return {
      recibido: body,
    }
  }
}

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador': {
    subject: 'sujeto-jugador',
    email: null,
    roles: new Set([Role.Player]),
  },

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
  'token-maestro': {
    subject: 'subject-upb-company',
    email: null,
    roles: new Set([Role.GameMaster]),
  },
  'token-maestro-ajeno': {
    subject: 'subject-no-autorizado',
    email: null,
    roles: new Set([Role.GameMaster]),
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

    if (command.productId === 'product-insufficient-funds') {
      return Promise.reject(new InsufficientPublicationFundsError())
    }

    return Promise.resolve({
      ...publishedAuction,
      productId: command.productId,
    })
  }),
}

const publishedOfficialAuction = {
  id: 'official-auction-created',
  publisherId: 'subject-upb-company',
  publisherType: 'GAME_MASTER' as const,
  productId: 'exclusive-ok',
  durationHours: 48 as const,
  publicationFeeCredits: 0,
  currency: 'COP',
  minimumBidAmountMinor: 150_000,
  buyNowAmountMinor: 300_000,
  mark: 'OFFICIAL' as const,
  status: 'ACTIVE' as const,
  publishedAt: new Date('2026-09-23T12:00:00.000Z'),
  closesAt: new Date('2026-09-25T12:00:00.000Z'),
}

const publishOfficialAuctionStub = {
  execute: jest.fn((command: { productId: string }) => {
    if (command.productId === 'exclusive-not-eligible') {
      return Promise.reject(new ProductNotEligibleForOfficialAuctionError(command.productId))
    }

    if (command.productId === 'exclusive-unavailable') {
      return Promise.reject(new ExternalDependencyUnavailableError('catalog'))
    }

    return Promise.resolve({
      ...publishedOfficialAuction,
      productId: command.productId,
    })
  }),
}

interface RegisterBidStubCommand {
  operationId: string
  auctionId: string
  bidderId: string
  amountCredits: number
}

const registerBidStub = {
  execute: jest.fn((command: RegisterBidStubCommand) => {
    if (command.auctionId === 'auction-closed') {
      return Promise.reject(
        new BidRuleViolation(BidRuleCode.AuctionNotActive, 'La subasta no esta activa.'),
      )
    }

    if (command.auctionId === 'auction-own') {
      return Promise.reject(
        new BidRuleViolation(
          BidRuleCode.SellerCannotBid,
          'El vendedor no puede pujar en su propia subasta.',
        ),
      )
    }

    if (command.auctionId === 'auction-too-low') {
      return Promise.reject(
        new BidRuleViolation(BidRuleCode.BidTooLow, 'La puja debe superar la oferta actual.'),
      )
    }

    if (command.auctionId === 'auction-minimum-increment') {
      return Promise.reject(
        new BidRuleViolation(
          BidRuleCode.MinimumIncrementNotMet,
          'La puja no cumple el incremento minimo requerido.',
        ),
      )
    }

    if (command.auctionId === 'auction-cooldown') {
      return Promise.reject(
        new BidRuleViolation(
          BidRuleCode.BidCooldownActive,
          'El jugador debe esperar antes de realizar otra puja.',
        ),
      )
    }

    if (command.auctionId === 'auction-active-limit') {
      return Promise.reject(
        new BidRuleViolation(
          BidRuleCode.ActiveBidLimitReached,
          'El jugador alcanzo el limite de pujas activas.',
        ),
      )
    }

    if (command.auctionId === 'auction-insufficient-credits') {
      return Promise.reject(new InsufficientBidCreditsError(10, command.amountCredits))
    }

    if (command.auctionId === 'auction-not-found') {
      return Promise.reject(new PersistedAuctionNotFoundError(command.auctionId))
    }

    if (command.auctionId === 'auction-concurrent') {
      return Promise.reject(new ConcurrentBidConflictError())
    }

    if (command.auctionId === 'auction-idempotency-conflict') {
      return Promise.reject(new IdempotencyConflictError())
    }

    if (command.auctionId === 'auction-wallet-unavailable') {
      return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
    }

    return Promise.resolve({
      id: 'bid-created',
      auctionId: command.auctionId,
      bidderId: command.bidderId,
      amountCredits: command.amountCredits,
      placedAt: new Date('2026-09-21T12:00:10.000Z'),
    })
  }),
}

interface ConfigureAutoBidStubCommand {
  auctionId: string
  bidderId: string
  maxAmountCredits: number
}

const configureAutoBidStub = {
  execute: jest.fn((command: ConfigureAutoBidStubCommand) => {
    if (command.auctionId === 'auction-closed') {
      return Promise.reject(
        new AutoBidRuleViolation(AutoBidRuleCode.AuctionNotActive, 'La subasta no esta activa.'),
      )
    }

    if (command.auctionId === 'auction-own') {
      return Promise.reject(
        new AutoBidRuleViolation(
          AutoBidRuleCode.SellerCannotConfigure,
          'El vendedor no puede configurar en su propia subasta.',
        ),
      )
    }

    if (command.auctionId === 'auction-not-found') {
      return Promise.reject(new PersistedAuctionNotFoundError(command.auctionId))
    }

    return Promise.resolve({
      auctionId: command.auctionId,
      bidderId: command.bidderId,
      maxAmountCredits: command.maxAmountCredits,
      configuredAt: new Date('2026-09-21T12:00:10.000Z'),
      isActive: true,
    })
  }),
}

const buyNowConfirmation = {
  transactionId: 'txn-created',
  auctionId: 'auction-buy-now',
  buyerId: 'sujeto-jugador',
  sellerId: 'seller-1',
  productId: 'product-1',
  debitedCredits: 2500,
  remainingCredits: 2500,
  closedAt: new Date('2026-09-21T15:00:00.000Z'),
  replayed: false,
}

const executeBuyNowStub = {
  execute: jest.fn((command: { auctionId: string }) => {
    if (command.auctionId === 'auction-not-found') {
      return Promise.reject(new AuctionNotFoundError(command.auctionId))
    }
    if (command.auctionId === 'auction-not-active') {
      return Promise.reject(
        new BuyNowRuleViolation(BuyNowRuleCode.AuctionNotActive, 'La subasta no esta activa.'),
      )
    }
    if (command.auctionId === 'auction-no-price') {
      return Promise.reject(
        new BuyNowRuleViolation(
          BuyNowRuleCode.BuyNowPriceUnavailable,
          'Sin precio de compra inmediata.',
        ),
      )
    }
    if (command.auctionId === 'auction-insufficient-credits') {
      return Promise.reject(
        new InsufficientCreditsViolation({
          requiredCredits: 3000,
          availableCredits: 2500,
          missingCredits: 500,
        }),
      )
    }
    if (command.auctionId === 'auction-own') {
      return Promise.reject(
        new BuyNowRuleViolation(
          BuyNowRuleCode.SellerCannotBuyOwnAuction,
          'El vendedor no puede comprar su propia subasta.',
        ),
      )
    }
    if (command.auctionId === 'auction-already-closed') {
      return Promise.reject(new AuctionAlreadyClosedError(command.auctionId))
    }
    if (command.auctionId === 'auction-unavailable') {
      return Promise.reject(new ExternalDependencyUnavailableError('wallet'))
    }
    return Promise.resolve({ ...buyNowConfirmation, auctionId: command.auctionId })
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
    .overrideProvider(PublishOfficialAuction)
    .useValue(publishOfficialAuctionStub)
    .overrideProvider(RegisterBid)
    .useValue(registerBidStub)
    .overrideProvider(ConfigureAutoBid)
    .useValue(configureAutoBidStub)
    .overrideProvider(ExecuteBuyNowUseCase)
    .useValue(executeBuyNowStub)
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
      GAME_MASTER_SUBJECT: 'subject-upb-company',
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

      expect(response.body).toEqual({
        subject: 'sujeto-jugador',
      })
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

    it('autoriza GAME_MASTER solo cuando tambien coincide el subject configurado', async () => {
      const server = app.getHttpServer()
      const allowed = await request(server)
        .get('/api/probe/maestro-juego')
        .set('Authorization', 'Bearer token-maestro')

      expect(allowed.status).toBe(200)
      expect(allowed.body).toEqual({ subject: 'subject-upb-company' })
      for (const token of ['token-maestro-ajeno', 'token-jugador', 'token-admin', 'token-super']) {
        expect(
          (
            await request(server)
              .get('/api/probe/maestro-juego')
              .set('Authorization', `Bearer ${token}`)
          ).status,
        ).toBe(403)
      }
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

    beforeEach(() => {
      publishAuctionStub.execute.mockClear()
    })

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
        expect.objectContaining({
          sellerId: 'sujeto-jugador',
          operationId: 'operation-1',
        }),
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
      const unknownField = await publish('token-jugador', {
        ...validBody,
        sellerId: 'otro',
      })

      expect(unknownField.status).toBe(400)

      expect(unknownField.body).toMatchObject({
        code: 'INVALID_REQUEST',
      })

      const realMoney = await publish('token-jugador', {
        ...validBody,
        currency: 'REAL_MONEY',
      })

      expect(realMoney.status).toBe(400)

      expect(realMoney.body).toMatchObject({
        code: 'INVALID_REQUEST',
      })

      const missingKey = await request(app.getHttpServer())
        .post('/api/v1/auctions')
        .set('Authorization', 'Bearer token-jugador')
        .send(validBody)

      expect(missingKey.status).toBe(400)

      expect(missingKey.body).toMatchObject({
        code: 'INVALID_IDEMPOTENCY_KEY',
      })
    })

    it.each([
      ['product-sanction', 403, AuctionRuleCode.SellerSanctioned],
      ['product-limit', 409, AuctionRuleCode.ActiveAuctionLimitReached],
      ['product-price', 422, AuctionRuleCode.InvalidBuyNowPrice],
      ['product-unavailable', 503, 'DEPENDENCY_UNAVAILABLE'],
      ['product-insufficient-funds', 422, 'INSUFFICIENT_FUNDS'],
    ])('mapea %s a HTTP %i con codigo estable', async (productId, status, code) => {
      const response = await publish('token-jugador', {
        ...validBody,
        productId,
      })

      expect(response.status).toBe(status)

      expect(response.body).toMatchObject({
        statusCode: status,
        code,
      })
    })

    it('publica en OpenAPI la operacion, seguridad, entrada y respuestas estables', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      )

      const operation = document.paths['/api/v1/auctions']?.post

      expect(operation).toBeDefined()

      expect(operation?.security).toEqual([
        {
          bearer: [],
        },
      ])

      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
          }),
        ]),
      )

      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403', '409', '422', '503']),
      )
    })
  })

  describe('Publicacion de subastas oficiales HU-66.5', () => {
    const validBody = {
      productId: 'exclusive-ok',
      durationHours: 48,
      currency: 'COP',
      minimumBidAmountMinor: 150_000,
      buyNowAmountMinor: 300_000,
    }

    const publish = (
      token = 'token-maestro',
      body: Record<string, unknown> = validBody,
      operationId = 'operation-official-1',
    ) =>
      request(app.getHttpServer())
        .post('/api/v1/official-auctions')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', operationId)
        .send(body)

    beforeEach(() => {
      publishOfficialAuctionStub.execute.mockClear()
    })

    it('responde 201 y deriva el publicador de la identidad autorizada', async () => {
      const response = await publish()

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        id: 'official-auction-created',
        publisherId: 'subject-upb-company',
        publisherType: 'GAME_MASTER',
        publicationFeeCredits: 0,
        mark: 'OFFICIAL',
      })
      expect(publishOfficialAuctionStub.execute).toHaveBeenCalledWith({
        operationId: 'operation-official-1',
        publisherId: 'subject-upb-company',
        productId: 'exclusive-ok',
        durationHours: 48,
        currency: 'COP',
        minimumBidAmountMinor: 150_000,
        buyNowAmountMinor: 300_000,
      })
    })

    it('rechaza token ausente o invalido con 401', async () => {
      const missing = await request(app.getHttpServer())
        .post('/api/v1/official-auctions')
        .set('Idempotency-Key', 'operation-official-1')
        .send(validBody)

      expect(missing.status).toBe(401)
      expect((await publish('token-falso')).status).toBe(401)
      expect(publishOfficialAuctionStub.execute).not.toHaveBeenCalled()
    })

    it.each(['token-jugador', 'token-admin', 'token-super', 'token-maestro-ajeno'])(
      'rechaza con 403 la identidad no autorizada %s',
      async (token) => {
        expect((await publish(token)).status).toBe(403)
      },
    )

    it.each([
      ['marca inyectada', { ...validBody, mark: 'PREMIUM' }],
      ['publicador inyectado', { ...validBody, publisherId: 'attacker' }],
      ['comision inyectada', { ...validBody, publicationFeeCredits: 99 }],
      ['duracion invalida', { ...validBody, durationHours: 72 }],
      ['moneda invalida', { ...validBody, currency: 'cop' }],
      ['precio decimal', { ...validBody, minimumBidAmountMinor: 1.5 }],
    ])('rechaza %s con contrato estricto', async (_case, body) => {
      const response = await publish('token-maestro', body)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(publishOfficialAuctionStub.execute).not.toHaveBeenCalled()
    })

    it('exige Idempotency-Key y propaga la misma clave en los reintentos', async () => {
      const missing = await request(app.getHttpServer())
        .post('/api/v1/official-auctions')
        .set('Authorization', 'Bearer token-maestro')
        .send(validBody)

      expect(missing.status).toBe(400)
      expect(missing.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })

      const first = await publish('token-maestro', validBody, 'official-retry-1')
      const retry = await publish('token-maestro', validBody, 'official-retry-1')
      expect(first.status).toBe(201)
      expect(retry.status).toBe(201)
      expect(retry.body).toEqual(first.body)
      expect(publishOfficialAuctionStub.execute).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ operationId: 'official-retry-1' }),
      )
    })

    it.each([
      ['exclusive-not-eligible', 422, 'PRODUCT_NOT_ELIGIBLE'],
      ['exclusive-unavailable', 503, 'DEPENDENCY_UNAVAILABLE'],
    ])('mapea %s a HTTP %i con codigo estable', async (productId, status, code) => {
      const response = await publish('token-maestro', { ...validBody, productId })

      expect(response.status).toBe(status)
      expect(response.body).toMatchObject({ statusCode: status, code })
    })

    it('publica en OpenAPI seguridad, idempotencia, DTO y respuestas estables', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      )
      const operation = document.paths['/api/v1/official-auctions']?.post

      expect(operation).toBeDefined()
      expect(operation?.security).toEqual([{ bearer: [] }])
      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
        ]),
      )
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403', '409', '422', '503']),
      )
      expect(operation?.requestBody).toBeDefined()
    })
  })

  describe('Registro de pujas HU-63.4', () => {
    const validBody = {
      amountCredits: 30,
    }

    const invalidRequests: readonly {
      body: Record<string, unknown>
      description: string
    }[] = [
      {
        body: {
          amountCredits: 0,
        },
        description: 'monto cero',
      },
      {
        body: {
          amountCredits: -10,
        },
        description: 'monto negativo',
      },
      {
        body: {
          amountCredits: 10.5,
        },
        description: 'monto decimal',
      },
      {
        body: {
          amountCredits: '30',
        },
        description: 'monto con tipo incorrecto',
      },
      {
        body: {},
        description: 'monto ausente',
      },
    ]

    const bid = (
      auctionId = 'auction-ok',
      token = 'token-jugador',
      body: Record<string, unknown> = validBody,
      operationId = 'operation-bid-1',
    ) =>
      request(app.getHttpServer())
        .post(`/api/v1/auctions/${auctionId}/bids`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', operationId)
        .send(body)

    beforeEach(() => {
      registerBidStub.execute.mockClear()
    })

    it('responde 201 y usa la identidad autenticada como bidder', async () => {
      const response = await bid()

      expect(response.status).toBe(201)

      expect(response.body).toMatchObject({
        id: 'bid-created',
        auctionId: 'auction-ok',
        bidderId: 'sujeto-jugador',
        amountCredits: 30,
      })

      expect(registerBidStub.execute).toHaveBeenCalledWith({
        operationId: 'operation-bid-1',
        auctionId: 'auction-ok',
        bidderId: 'sujeto-jugador',
        amountCredits: 30,
      })
    })

    it('responde 401 cuando no existe access token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions/auction-ok/bids')
        .set('Idempotency-Key', 'operation-bid-1')
        .send(validBody)

      expect(response.status).toBe(401)

      expect(registerBidStub.execute).not.toHaveBeenCalled()
    })

    it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
      const response = await bid('auction-ok', 'token-admin')

      expect(response.status).toBe(403)

      expect(registerBidStub.execute).not.toHaveBeenCalled()
    })

    it('rechaza campos desconocidos y no permite que el cliente envie bidderId', async () => {
      const response = await bid('auction-ok', 'token-jugador', {
        amountCredits: 30,
        bidderId: 'jugador-falsificado',
      })

      expect(response.status).toBe(400)

      expect(response.body).toMatchObject({
        code: 'INVALID_REQUEST',
      })

      expect(registerBidStub.execute).not.toHaveBeenCalled()
    })

    it.each(invalidRequests)(
      'responde 400 ante request invalido: $description',
      async ({ body }) => {
        const response = await bid('auction-ok', 'token-jugador', body)

        expect(response.status).toBe(400)

        expect(response.body).toMatchObject({
          code: 'INVALID_REQUEST',
        })

        expect(registerBidStub.execute).not.toHaveBeenCalled()
      },
    )

    it('responde 400 cuando falta Idempotency-Key', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions/auction-ok/bids')
        .set('Authorization', 'Bearer token-jugador')
        .send(validBody)

      expect(response.status).toBe(400)

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_IDEMPOTENCY_KEY',
      })
    })

    it('responde 400 cuando Idempotency-Key esta vacio', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions/auction-ok/bids')
        .set('Authorization', 'Bearer token-jugador')
        .set('Idempotency-Key', ' ')
        .send(validBody)

      expect(response.status).toBe(400)

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_IDEMPOTENCY_KEY',
      })
    })

    it.each([
      ['auction-closed', 422, BidRuleCode.AuctionNotActive],
      ['auction-own', 403, BidRuleCode.SellerCannotBid],
      ['auction-too-low', 422, BidRuleCode.BidTooLow],
      ['auction-minimum-increment', 422, BidRuleCode.MinimumIncrementNotMet],
      ['auction-cooldown', 409, BidRuleCode.BidCooldownActive],
      ['auction-active-limit', 409, BidRuleCode.ActiveBidLimitReached],
      ['auction-insufficient-credits', 422, 'INSUFFICIENT_BID_CREDITS'],
      ['auction-not-found', 422, 'AUCTION_NOT_FOUND'],
      ['auction-concurrent', 409, 'CONCURRENT_BID_CONFLICT'],
      ['auction-idempotency-conflict', 409, 'IDEMPOTENCY_CONFLICT'],
      ['auction-wallet-unavailable', 503, 'DEPENDENCY_UNAVAILABLE'],
    ])('mapea el escenario %s a HTTP %i con codigo %s', async (auctionId, status, code) => {
      const response = await bid(auctionId)

      expect(response.status).toBe(status)

      expect(response.body).toMatchObject({
        statusCode: status,
        code,
      })
    })

    it('publica en OpenAPI el endpoint, autenticacion, Idempotency-Key y respuestas estables', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      )

      const operation = document.paths['/api/v1/auctions/{auctionId}/bids']?.post

      expect(operation).toBeDefined()

      expect(operation?.security).toEqual([
        {
          bearer: [],
        },
      ])

      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'auctionId',
            in: 'path',
            required: true,
          }),
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ]),
      )

      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403', '409', '422', '503']),
      )
    })
  })

  describe('Configuracion de puja automatica HU-67.5', () => {
    const validBody = {
      maxAmountCredits: 100,
    }

    const invalidRequests: readonly {
      body: Record<string, unknown>
      description: string
    }[] = [
      {
        body: { maxAmountCredits: 0 },
        description: 'limite cero',
      },
      {
        body: { maxAmountCredits: -10 },
        description: 'limite negativo',
      },
      {
        body: { maxAmountCredits: 10.5 },
        description: 'limite decimal',
      },
      {
        body: { maxAmountCredits: '100' },
        description: 'limite con tipo incorrecto',
      },
      {
        body: {},
        description: 'limite ausente',
      },
    ]

    const autoBid = (
      auctionId = 'auction-ok',
      token = 'token-jugador',
      body: Record<string, unknown> = validBody,
      operationId = 'operation-auto-bid-1',
    ) =>
      request(app.getHttpServer())
        .post(`/api/v1/auctions/${auctionId}/auto-bid`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', operationId)
        .send(body)

    beforeEach(() => {
      configureAutoBidStub.execute.mockClear()
    })

    it('responde 201 y usa la identidad autenticada como bidder', async () => {
      const response = await autoBid()

      expect(response.status).toBe(201)

      expect(response.body).toMatchObject({
        auctionId: 'auction-ok',
        bidderId: 'sujeto-jugador',
        maxAmountCredits: 100,
        isActive: true,
      })

      expect(configureAutoBidStub.execute).toHaveBeenCalledWith({
        auctionId: 'auction-ok',
        bidderId: 'sujeto-jugador',
        maxAmountCredits: 100,
      })
    })

    it('responde 401 cuando no existe access token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions/auction-ok/auto-bid')
        .set('Idempotency-Key', 'operation-auto-bid-1')
        .send(validBody)

      expect(response.status).toBe(401)

      expect(configureAutoBidStub.execute).not.toHaveBeenCalled()
    })

    it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
      const response = await autoBid('auction-ok', 'token-admin')

      expect(response.status).toBe(403)

      expect(configureAutoBidStub.execute).not.toHaveBeenCalled()
    })

    it('rechaza campos desconocidos y no permite que el cliente envie bidderId', async () => {
      const response = await autoBid('auction-ok', 'token-jugador', {
        maxAmountCredits: 100,
        bidderId: 'jugador-falsificado',
      })

      expect(response.status).toBe(400)

      expect(response.body).toMatchObject({
        code: 'INVALID_REQUEST',
      })

      expect(configureAutoBidStub.execute).not.toHaveBeenCalled()
    })

    it.each(invalidRequests)(
      'responde 400 ante request invalido: $description',
      async ({ body }) => {
        const response = await autoBid('auction-ok', 'token-jugador', body)

        expect(response.status).toBe(400)

        expect(response.body).toMatchObject({
          code: 'INVALID_REQUEST',
        })

        expect(configureAutoBidStub.execute).not.toHaveBeenCalled()
      },
    )

    it('responde 400 cuando falta Idempotency-Key', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions/auction-ok/auto-bid')
        .set('Authorization', 'Bearer token-jugador')
        .send(validBody)

      expect(response.status).toBe(400)

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_IDEMPOTENCY_KEY',
      })

      expect(configureAutoBidStub.execute).not.toHaveBeenCalled()
    })

    it.each([
      ['auction-closed', 422, AutoBidRuleCode.AuctionNotActive],
      ['auction-own', 403, AutoBidRuleCode.SellerCannotConfigure],
      ['auction-not-found', 422, 'AUCTION_NOT_FOUND'],
    ])('mapea el escenario %s a HTTP %i con codigo %s', async (auctionId, status, code) => {
      const response = await autoBid(auctionId)

      expect(response.status).toBe(status)

      expect(response.body).toMatchObject({
        statusCode: status,
        code,
      })
    })

    it('publica en OpenAPI el endpoint, autenticacion, Idempotency-Key y respuestas estables', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      )

      const operation = document.paths['/api/v1/auctions/{auctionId}/auto-bid']?.post

      expect(operation).toBeDefined()

      expect(operation?.security).toEqual([
        {
          bearer: [],
        },
      ])

      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'auctionId',
            in: 'path',
            required: true,
          }),
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ]),
      )

      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '401', '403', '422', '503']),
      )
    })
  })

  describe('Compra inmediata HU-64', () => {
    const buyNow = (
      auctionId = 'auction-buy-now',
      token = 'token-jugador',
      body: Record<string, unknown> = { confirmed: true },
      idempotencyKey: string | null = 'operation-buy-now-1',
    ) => {
      const req = request(app.getHttpServer())
        .post(`/api/v1/auctions/${auctionId}/buy-now`)
        .set('Authorization', `Bearer ${token}`)

      if (idempotencyKey !== null) {
        req.set('Idempotency-Key', idempotencyKey)
      }

      return req.send(body)
    }

    beforeEach(() => executeBuyNowStub.execute.mockClear())

    it('responde 200 y usa el sujeto verificado como comprador', async () => {
      const response = await buyNow()

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        auctionId: 'auction-buy-now',
        buyerId: 'sujeto-jugador',
        debitedCredits: 2500,
      })
      expect(executeBuyNowStub.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          buyerId: 'sujeto-jugador',
          auctionId: 'auction-buy-now',
          operationId: 'operation-buy-now-1',
          confirmed: true,
        }),
      )
    })

    it('responde 401 sin access token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auctions/auction-buy-now/buy-now')
        .set('Idempotency-Key', 'operation-buy-now-1')
        .send({ confirmed: true })
      expect(response.status).toBe(401)
    })

    it('responde 403 si la identidad no tiene rol PLAYER', async () => {
      expect((await buyNow('auction-buy-now', 'token-admin')).status).toBe(403)
    })

    it('responde 400 ante un cuerpo con campos desconocidos o sin clave idempotente', async () => {
      const unknownField = await buyNow('auction-buy-now', 'token-jugador', {
        confirmed: true,
        auctionId: 'otra',
      })
      expect(unknownField.status).toBe(400)
      expect(unknownField.body).toMatchObject({ code: 'INVALID_REQUEST' })

      const missingKey = await buyNow('auction-buy-now', 'token-jugador', { confirmed: true }, null)
      expect(missingKey.status).toBe(400)
      expect(missingKey.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })
    })

    it.each([
      ['auction-not-found', 404, 'AUCTION_NOT_FOUND'],
      ['auction-not-active', 409, BuyNowRuleCode.AuctionNotActive],
      ['auction-already-closed', 409, 'BUY_NOW_CONFLICT'],
      ['auction-no-price', 422, BuyNowRuleCode.BuyNowPriceUnavailable],
      ['auction-insufficient-credits', 422, BuyNowRuleCode.InsufficientCredits],
      ['auction-own', 403, BuyNowRuleCode.SellerCannotBuyOwnAuction],
      ['auction-unavailable', 503, 'DEPENDENCY_UNAVAILABLE'],
    ])('mapea %s a HTTP %i con codigo estable', async (auctionId, status, code) => {
      const response = await buyNow(auctionId)
      expect(response.status).toBe(status)
      expect(response.body).toMatchObject({ statusCode: status, code })
    })

    it('CA-04: reenvia la casilla de confirmacion sin marcar tal como llego', async () => {
      await buyNow('auction-buy-now', 'token-jugador', { confirmed: false })

      expect(executeBuyNowStub.execute).toHaveBeenCalledWith(
        expect.objectContaining({ confirmed: false }),
      )
    })

    it('incluye el detalle de creditos faltantes en la respuesta de CA-02', async () => {
      const response = await buyNow('auction-insufficient-credits')

      expect(response.body).toMatchObject({
        details: { requiredCredits: 3000, availableCredits: 2500, missingCredits: 500 },
      })
    })

    it('publica en OpenAPI la operacion, seguridad y respuestas estables', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      )
      const operation = document.paths['/api/v1/auctions/{auctionId}/buy-now']?.post

      expect(operation).toBeDefined()
      expect(operation?.security).toEqual([{ bearer: [] }])
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '409', '422', '503']),
      )
    })
  })

  describe('Contrato interno', () => {
    const body = {
      operationId: 'op-1',
    }

    const path = '/api/probe/interna'

    const signed = (service: string) => {
      const timestamp = String(Date.now())

      return request(app.getHttpServer())
        .post(path)
        .set('x-internal-service', service)
        .set('x-internal-timestamp', timestamp)
        .set(
          'x-internal-signature',
          signInternalRequest(SECRET, {
            service,
            method: 'POST',
            path,
            timestamp,
            body,
          }),
        )
        .send(body)
    }

    /**
     * ADR-019 no declara todavia consumidores de las rutas internas de este
     * servicio, asi que una firma valida de cualquier servicio se rechaza.
     * El control de que una firma correcta SI se acepta esta en
     * `test/unit/internal-auth.spec.ts`. Cuando una Historia de Usuario
     * anada un consumidor, esta prueba debe pasar a comprobar que se acepta.
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
    restore = withEnv({
      AUTH_MODE: 'disabled',
      PERSISTENCE_DRIVER: 'memory',
    })

    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()

    restore()
  })

  it('atribuye la identidad anonima en lugar de inventar una persona', async () => {
    const response = await request(app.getHttpServer()).get('/api/probe/protegida')

    expect(response.status).toBe(200)

    expect(response.body).toEqual({
      subject: 'anonymous',
    })
  })

  it('el contrato interno sigue exigiendo firma y niega sin secreto', async () => {
    const response = await request(app.getHttpServer()).post('/api/probe/interna').send({})

    expect(response.status).toBe(503)
  })
})
