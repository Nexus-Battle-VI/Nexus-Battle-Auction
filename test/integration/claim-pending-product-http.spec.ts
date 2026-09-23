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
import { CLAIM_PERIOD_MS } from '../../src/domain/entities/AuctionPendingClaim'
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

class StubInventory implements ProductInventoryPort {
  confirmClaimShouldFail = false

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

  confirmClaim(command: { operationId: string; commitmentId: string; winnerId: string }): Promise<{
    operationId: string
    commitmentId: string
    status: 'CLAIMED'
    winnerId: string
    applied: boolean
  }> {
    if (this.confirmClaimShouldFail)
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

describe('POST reclamar producto ganado pendiente HU-69.3', () => {
  let app: INestApplication
  let restore: () => void
  let auctions: AuctionRepositoryPort
  let pendingClaims: AuctionPendingClaimRepositoryPort
  let inventory: StubInventory
  let wallet: SpyWallet

  const seed = async (auctionId: string, winnerId = 'winner-1'): Promise<void> => {
    await auctions.publish({
      operationId: `publish-${auctionId}`,
      auction: Auction.publish({
        auctionId,
        sellerId: 'seller-1',
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
      settledAt,
      createdAt: settledAt,
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
    inventory = new StubInventory()

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

  afterEach(() => {
    inventory.confirmClaimShouldFail = false
  })

  it('responde 200, confirma el reclamo y no toca creditos (Wallet)', async () => {
    const auctionId = 'auction-http-claim-ok'
    await seed(auctionId)

    const response = await request(app.getHttpServer())
      .post(`/api/v1/auctions/me/pending-claims/${auctionId}/claim`)
      .set('Authorization', 'Bearer token-winner')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      auctionId,
      claimStatus: 'CLAIMED',
    })
    expect(wallet.captureHold).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('responde 403 cuando la identidad no es titular del reclamo', async () => {
    const auctionId = 'auction-http-claim-wrong-owner'
    await seed(auctionId)

    const response = await request(app.getHttpServer())
      .post(`/api/v1/auctions/me/pending-claims/${auctionId}/claim`)
      .set('Authorization', 'Bearer token-other-player')

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'PENDING_CLAIM_NOT_OWNED' })
  })

  it('responde 404 cuando no existe un pending-claim para la subasta', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/auction-inexistente/claim')
      .set('Authorization', 'Bearer token-winner')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'PENDING_CLAIM_NOT_FOUND' })
  })

  it('responde 422 cuando el plazo de reclamo ya vencio', async () => {
    const auctionId = 'auction-http-claim-expired'
    await auctions.publish({
      operationId: `publish-${auctionId}`,
      auction: Auction.publish({
        auctionId,
        sellerId: 'seller-1',
        productId: `product-${auctionId}`,
        durationHours: 24,
        minimumBidCredits: 10,
        publishedAt: new Date('2026-08-01T12:00:00.000Z'),
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
    const longAgo = new Date(now.getTime() - CLAIM_PERIOD_MS - 1)
    await pendingClaims.createIfAbsent({
      auctionId,
      winnerId: 'winner-1',
      productId: `product-${auctionId}`,
      winningBidId: 'bid-1',
      finalAmountCredits: 30,
      settledAt: longAgo,
      createdAt: longAgo,
    })

    const response = await request(app.getHttpServer())
      .post(`/api/v1/auctions/me/pending-claims/${auctionId}/claim`)
      .set('Authorization', 'Bearer token-winner')

    expect(response.status).toBe(422)
    expect(response.body).toMatchObject({ code: 'CLAIM_DEADLINE_EXPIRED' })
  })

  it('responde 200 idempotente ante una solicitud duplicada tras un reclamo exitoso', async () => {
    const auctionId = 'auction-http-claim-duplicate'
    await seed(auctionId)

    const first = await request(app.getHttpServer())
      .post(`/api/v1/auctions/me/pending-claims/${auctionId}/claim`)
      .set('Authorization', 'Bearer token-winner')
    const second = await request(app.getHttpServer())
      .post(`/api/v1/auctions/me/pending-claims/${auctionId}/claim`)
      .set('Authorization', 'Bearer token-winner')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ claimStatus: 'CLAIMED' })
  })

  it('responde 503 cuando Player-Inventory no confirma la entrega y no cambia el estado', async () => {
    const auctionId = 'auction-http-claim-inventory-down'
    await seed(auctionId)
    inventory.confirmClaimShouldFail = true

    const response = await request(app.getHttpServer())
      .post(`/api/v1/auctions/me/pending-claims/${auctionId}/claim`)
      .set('Authorization', 'Bearer token-winner')

    expect(response.status).toBe(503)
    await expect(pendingClaims.findByAuctionId(auctionId)).resolves.toMatchObject({
      claimStatus: 'PENDING',
    })
  })

  it('responde 401 sin autenticacion', async () => {
    const response = await request(app.getHttpServer()).post(
      '/api/v1/auctions/me/pending-claims/auction-sin-auth/claim',
    )

    expect(response.status).toBe(401)
  })

  it('responde 403 cuando la identidad no tiene rol PLAYER', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/me/pending-claims/auction-sin-rol/claim')
      .set('Authorization', 'Bearer token-admin')

    expect(response.status).toBe(403)
  })
})
