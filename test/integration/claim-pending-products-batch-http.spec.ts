import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import {
  AUCTION_PENDING_CLAIM_REPOSITORY,
  type AuctionPendingClaimRepositoryPort,
} from '../../src/application/ports/AuctionPendingClaimRepositoryPort'
import {
  AUCTION_REPOSITORY,
  type AuctionRepositoryPort,
} from '../../src/application/ports/AuctionRepositoryPort'
import {
  PRODUCT_INVENTORY,
  type ProductInventoryPort,
} from '../../src/application/ports/ProductInventoryPort'
import {
  AUCTION_WALLET,
  type AuctionWalletPort,
} from '../../src/application/ports/AuctionWalletPort'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import { Auction } from '../../src/domain/entities/Auction'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const settledAt = new Date('2026-09-01T12:00:00.000Z')
const now = new Date(settledAt)
const clock: ClockPort = { now: () => new Date(now) }

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  'token-winner': { subject: 'winner-1', email: null, roles: new Set([Role.Player]) },
  'token-other-player': { subject: 'otro-jugador', email: null, roles: new Set([Role.Player]) },
  'token-admin': { subject: 'admin-1', email: null, roles: new Set([Role.Administrator]) },
}

const verifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = identities[token]
    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

class SpyWallet implements AuctionWalletPort {
  readonly captureHold = jest.fn()
  readonly releaseHold = jest.fn()
}

class SelectiveStubInventory implements ProductInventoryPort {
  readonly failingAuctionIds = new Set<string>()

  inspect(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  commit(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  release(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  markPendingClaim(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  confirmClaim(command: {
    operationId: string
    commitmentId: string
    auctionId: string
    winnerId: string
  }): Promise<{
    operationId: string
    commitmentId: string
    status: 'CLAIMED'
    winnerId: string
    applied: boolean
  }> {
    if (this.failingAuctionIds.has(command.auctionId))
      return Promise.reject(new ExternalDependencyUnavailableError('player-inventory'))
    return Promise.resolve({
      operationId: command.operationId,
      commitmentId: command.commitmentId,
      status: 'CLAIMED',
      winnerId: command.winnerId,
      applied: true,
    })
  }
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

interface BatchItemBody {
  readonly auctionId: string
  readonly status: string
}

const byAuctionId = (
  results: readonly BatchItemBody[],
  auctionId: string,
): BatchItemBody | undefined => results.find((item) => item.auctionId === auctionId)

describe('POST reclamar en bloque productos ganados pendientes HU-69.4', () => {
  let app: INestApplication
  let restore: () => void
  let auctions: AuctionRepositoryPort
  let pendingClaims: AuctionPendingClaimRepositoryPort
  let inventory: SelectiveStubInventory
  let wallet: SpyWallet

  const seed = async (
    auctionId: string,
    winnerId = 'winner-1',
    claimSettledAt: Date = settledAt,
  ): Promise<void> => {
    await auctions.publish({
      operationId: `publish-${auctionId}`,
      auction: Auction.publish({
        auctionId,
        sellerId: `seller-${auctionId}`,
        productId: `product-${auctionId}`,
        durationHours: 24,
        minimumBidCredits: 10,
        publishedAt: new Date('2026-08-30T12:00:00.000Z'),
        eligibility: {
          productOwnedBySeller: true,
          productInUse: false,
          productTradable: true,
          sellerHasActiveSanctions: false,
          activeAuctionCount: 0,
        },
      }),
      inventoryCommitmentId: `commitment-${auctionId}`,
      feeChargeId: `charge-${auctionId}`,
    })
    await pendingClaims.createIfAbsent({
      auctionId,
      winnerId,
      productId: `product-${auctionId}`,
      winningBidId: 'bid-1',
      finalAmountCredits: 30,
      settledAt: claimSettledAt,
      createdAt: claimSettledAt,
    })
  }

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: 'secret-test',
      PERSISTENCE_DRIVER: 'memory',
    })

    wallet = new SpyWallet()
    inventory = new SelectiveStubInventory()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(PRODUCT_INVENTORY)
      .useValue(inventory)
      .overrideProvider(AUCTION_WALLET)
      .useValue(wallet)
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()

    auctions = moduleRef.get(AUCTION_REPOSITORY)
    pendingClaims = moduleRef.get(AUCTION_PENDING_CLAIM_REPOSITORY)
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('responde 200 con todos CLAIMED y no toca creditos (Wallet)', async () => {
    await seed('auction-batch-ok-a')
    await seed('auction-batch-ok-b')

    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: ['auction-batch-ok-a', 'auction-batch-ok-b'] })

    expect(response.status).toBe(200)
    expect(response.body.results).toHaveLength(2)
    expect(response.body.results.every((item: BatchItemBody) => item.status === 'CLAIMED')).toBe(
      true,
    )
    expect(wallet.captureHold).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('responde 200 parcial: mezcla de exitosos y fallidos sin abortar el lote', async () => {
    await seed('auction-batch-partial-ok')
    await seed('auction-batch-partial-not-owned', 'otro-jugador')
    const veryOld = new Date('2026-01-01T00:00:00.000Z')
    await seed('auction-batch-partial-expired', 'winner-1', veryOld)

    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({
        auctionIds: [
          'auction-batch-partial-ok',
          'auction-batch-partial-not-owned',
          'auction-batch-partial-expired',
        ],
      })

    expect(response.status).toBe(200)
    expect(byAuctionId(response.body.results, 'auction-batch-partial-ok')).toMatchObject({
      status: 'CLAIMED',
    })
    expect(byAuctionId(response.body.results, 'auction-batch-partial-not-owned')).toMatchObject({
      status: 'NOT_OWNED',
    })
    expect(byAuctionId(response.body.results, 'auction-batch-partial-expired')).toMatchObject({
      status: 'EXPIRED',
    })
  })

  it('deduplica auctionIds repetidos en el request', async () => {
    await seed('auction-batch-dup')

    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: ['auction-batch-dup', 'auction-batch-dup'] })

    expect(response.status).toBe(200)
    expect(response.body.results).toHaveLength(1)
  })

  it('responde 200 con results vacio para un lote vacio', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: [] })

    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([])
  })

  it('claimAll reclama todos los pendientes del titular autenticado', async () => {
    await seed('auction-batch-all-1')
    await seed('auction-batch-all-2')

    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ claimAll: true })

    expect(response.status).toBe(200)
    expect(byAuctionId(response.body.results, 'auction-batch-all-1')).toMatchObject({
      status: 'CLAIMED',
    })
    expect(byAuctionId(response.body.results, 'auction-batch-all-2')).toMatchObject({
      status: 'CLAIMED',
    })
  })

  it('aisla por usuario: no permite reclamar un pending-claim de otro titular', async () => {
    await seed('auction-batch-isolation', 'otro-jugador')

    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: ['auction-batch-isolation'] })

    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      expect.objectContaining({ auctionId: 'auction-batch-isolation', status: 'NOT_OWNED' }),
    ])
    await expect(pendingClaims.findByAuctionId('auction-batch-isolation')).resolves.toMatchObject({
      claimStatus: 'PENDING',
      winnerId: 'otro-jugador',
    })
  })

  it('es idempotente ante un reenvio del mismo lote tras una respuesta parcial', async () => {
    await seed('auction-batch-retry-a')
    await seed('auction-batch-retry-b')
    inventory.failingAuctionIds.add('auction-batch-retry-b')

    const first = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: ['auction-batch-retry-a', 'auction-batch-retry-b'] })
    expect(byAuctionId(first.body.results, 'auction-batch-retry-a')).toMatchObject({
      status: 'CLAIMED',
    })
    expect(byAuctionId(first.body.results, 'auction-batch-retry-b')).toMatchObject({
      status: 'INVENTORY_UNAVAILABLE',
    })

    inventory.failingAuctionIds.delete('auction-batch-retry-b')

    const second = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: ['auction-batch-retry-a', 'auction-batch-retry-b'] })

    expect(byAuctionId(second.body.results, 'auction-batch-retry-a')).toMatchObject({
      status: 'ALREADY_CLAIMED',
    })
    expect(byAuctionId(second.body.results, 'auction-batch-retry-b')).toMatchObject({
      status: 'CLAIMED',
    })
  })

  it('Player-Inventory indisponible para un item no afecta a los demas del lote', async () => {
    await seed('auction-batch-down')
    await seed('auction-batch-up')
    inventory.failingAuctionIds.add('auction-batch-down')

    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-winner')
      .send({ auctionIds: ['auction-batch-down', 'auction-batch-up'] })

    inventory.failingAuctionIds.delete('auction-batch-down')

    expect(response.status).toBe(200)
    expect(byAuctionId(response.body.results, 'auction-batch-down')).toMatchObject({
      status: 'INVENTORY_UNAVAILABLE',
    })
    expect(byAuctionId(response.body.results, 'auction-batch-up')).toMatchObject({
      status: 'CLAIMED',
    })
    expect(wallet.captureHold).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('responde 401 sin autenticacion', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .send({ auctionIds: [] })

    expect(response.status).toBe(401)
  })

  it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/claim-batch')
      .set('Authorization', 'Bearer token-admin')
      .send({ auctionIds: [] })

    expect(response.status).toBe(403)
  })
})
