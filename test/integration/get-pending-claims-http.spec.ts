import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import request from 'supertest'

import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import { GetPendingClaims } from '../../src/application/use-cases/GetPendingClaims'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }

const claim = {
  auctionId: 'auction-pending-1',
  winnerId: 'player-1',
  productId: 'product-1',
  winningBidId: 'bid-1',
  finalAmountCredits: 30,
  settledAt: new Date('2026-09-20T12:00:00.000Z'),
  claimDeadline: new Date('2026-09-27T12:00:00.000Z'),
  claimStatus: 'PENDING' as const,
  claimedAt: null,
  createdAt: new Date('2026-09-20T12:00:00.000Z'),
  updatedAt: new Date('2026-09-20T12:00:00.000Z'),
}

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  'token-player': {
    subject: 'player-1',
    email: null,
    roles: new Set([Role.Player]),
  },
  'token-admin': {
    subject: 'admin-1',
    email: null,
    roles: new Set([Role.Administrator]),
  },
  'token-other-player': {
    subject: 'player-empty',
    email: null,
    roles: new Set([Role.Player]),
  },
}

const verifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = identities[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const getPendingClaimsStub = {
  execute: jest.fn((winnerId: string) => {
    if (winnerId === 'player-1') {
      return Promise.resolve([claim])
    }

    return Promise.resolve([])
  }),
}

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

describe('GET productos ganados pendientes de reclamo HU-69.2', () => {
  let app: INestApplication

  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
      PERSISTENCE_DRIVER: 'memory',
    })

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(GetPendingClaims)
      .useValue(getPendingClaimsStub)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile()

    app = moduleRef.createNestApplication()

    app.setGlobalPrefix('api')

    await app.init()
  })

  afterAll(async () => {
    await app.close()

    restore()
  })

  beforeEach(() => {
    getPendingClaimsStub.execute.mockClear()
  })

  it('responde 200 con los productos pendientes del titular y el plazo restante', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/me/pending-claims')
      .set('Authorization', 'Bearer token-player')

    expect(response.status).toBe(200)

    expect(response.body).toEqual([
      {
        auctionId: 'auction-pending-1',
        productId: 'product-1',
        winningBidId: 'bid-1',
        finalAmountCredits: 30,
        settledAt: claim.settledAt.toISOString(),
        claimDeadline: claim.claimDeadline.toISOString(),
        claimStatus: 'PENDING',
        remainingClaimDays: 4,
        claimedAt: null,
      },
    ])

    expect(getPendingClaimsStub.execute).toHaveBeenCalledWith('player-1')
  })

  it('responde 200 con array vacio cuando no hay productos pendientes', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/me/pending-claims')
      .set('Authorization', 'Bearer token-other-player')

    expect(response.status).toBe(200)
    expect(response.body).toEqual([])
  })

  it('responde 401 sin autenticacion', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/auctions/me/pending-claims')

    expect(response.status).toBe(401)
    expect(getPendingClaimsStub.execute).not.toHaveBeenCalled()
  })

  it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auctions/me/pending-claims')
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(403)
    expect(getPendingClaimsStub.execute).not.toHaveBeenCalled()
  })

  it('publica el contrato GET en OpenAPI', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    )

    const operation = document.paths['/api/v1/auctions/me/pending-claims']?.get

    expect(operation).toBeDefined()

    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '403']),
    )
  })
})
