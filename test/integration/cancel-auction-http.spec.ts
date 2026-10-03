import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import {
  AUCTION_REPOSITORY,
  type AuctionRepositoryPort,
} from '../../src/application/ports/AuctionRepositoryPort'
import {
  PUBLICATION_FEE,
  type ChargePublicationFeeCommand,
  type PublicationFeeCharge,
  type PublicationFeePort,
} from '../../src/application/ports/PublicationFeePort'
import {
  PRODUCT_INVENTORY,
  type ClaimedInventoryProductCommitment,
  type InventoryProductCommitment,
  type InventoryProductEligibility,
  type PendingClaimInventoryProductCommitment,
  type ProductInventoryPort,
  type ReleasedInventoryProductCommitment,
  type ReleaseInventoryProductCommand,
} from '../../src/application/ports/ProductInventoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'

/**
 * HU-90. HTTP end-to-end REAL: `CancelAuction`, `AuctionRepositoryPort` (en
 * memoria, `PERSISTENCE_DRIVER=memory`) y la autenticacion/validacion de
 * Nest son los de produccion -nada de eso se dobla-. Solo se sustituyen los
 * DOS clientes HTTP salientes (Wallet, Player-Inventory) por fakes en
 * memoria, porque sin `WALLET_BASE_URL`/`INVENTORY_BASE_URL` configurados
 * `app.module.ts` cablea los adaptadores "Unavailable" fail-closed, que
 * nunca confirmarian un refund/release real.
 */

const SECRET = 'secreto-de-cancelacion'
const SELLER_SUBJECT = 'seller-1'
const OTHER_SUBJECT = 'other-player'

const identities: Readonly<Record<string, VerifiedIdentity>> = {
  'token-seller': { subject: SELLER_SUBJECT, email: null, roles: new Set([Role.Player]) },
  'token-other': { subject: OTHER_SUBJECT, email: null, roles: new Set([Role.Player]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = identities[token]
    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

class FakePublicationFeePort implements PublicationFeePort {
  readonly refundCalls: { operationId: string; chargeId: string; amount: number }[] = []

  charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge> {
    void command
    throw new Error('No usado en esta suite.')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(operationId: string, chargeId: string, amount: number): Promise<void> {
    this.refundCalls.push({ operationId, chargeId, amount })
  }
}

class FakeProductInventoryPort implements ProductInventoryPort {
  readonly releaseCalls: ReleaseInventoryProductCommand[] = []

  inspect(): Promise<InventoryProductEligibility> {
    throw new Error('No usado en esta suite.')
  }

  commit(): Promise<InventoryProductCommitment> {
    throw new Error('No usado en esta suite.')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async release(
    command: ReleaseInventoryProductCommand,
  ): Promise<ReleasedInventoryProductCommitment> {
    this.releaseCalls.push(command)
    return {
      operationId: command.operationId,
      commitmentId: command.commitmentId,
      status: 'RELEASED',
      applied: true,
    }
  }

  markPendingClaim(): Promise<PendingClaimInventoryProductCommitment> {
    throw new Error('No usado en esta suite.')
  }

  confirmClaim(): Promise<ClaimedInventoryProductCommitment> {
    throw new Error('No usado en esta suite.')
  }
}

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('POST /api/v1/auctions/:auctionId/cancel (HU-90, 7.7.10)', () => {
  let app: INestApplication
  let restore: () => void
  let auctions: AuctionRepositoryPort
  let fees: FakePublicationFeePort
  let inventory: FakeProductInventoryPort

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      PERSISTENCE_DRIVER: 'memory',
    })

    fees = new FakePublicationFeePort()
    inventory = new FakeProductInventoryPort()

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(PUBLICATION_FEE)
      .useValue(fees)
      .overrideProvider(PRODUCT_INVENTORY)
      .useValue(inventory)
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()

    auctions = moduleRef.get(AUCTION_REPOSITORY)
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  // Este test usa el reloj REAL del proceso (no se dobla CLOCK): `publishedAt`
  // debe quedar relativo a "ahora", no a una fecha fija, o quedaria en el
  // pasado y la ventana de 6h (7.7.10) rechazaria la cancelacion por error.
  const recentlyPublishedAt = (): Date => new Date(Date.now() - 1_000)

  /** 48h de duracion -> publicationFeeCredits=3 -> refund esperado 1.5. */
  const seed = async (auctionId: string, bidCount = 0): Promise<void> => {
    const auction = Auction.publish({
      auctionId,
      sellerId: SELLER_SUBJECT,
      productId: 'product-1',
      durationHours: 48,
      minimumBidCredits: 10,
      publishedAt: recentlyPublishedAt(),
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })
    await auctions.publish({
      operationId: `publish:${auctionId}`,
      auction,
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
    })
    for (let index = 0; index < bidCount; index += 1) {
      await auctions.persistBid(
        Bid.restore({
          id: `bid:${auctionId}:${String(index)}`,
          auctionId,
          bidderId: 'bidder-1',
          amountCredits: 10 + index,
          placedAt: new Date(),
        }),
      )
    }
  }

  const cancel = (
    auctionId: string,
    idempotencyKey: string | undefined,
    token = 'token-seller',
  ) => {
    const req = request(app.getHttpServer())
      .post(`/api/v1/auctions/${auctionId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    return idempotencyKey === undefined
      ? req.send()
      : req.set('Idempotency-Key', idempotencyKey).send()
  }

  // 28. cancel valida -> respuesta correcta.
  it('cancela una subasta activa propia sin pujas y a mas de 6h del cierre', async () => {
    const auctionId = 'auction-http-ok'
    await seed(auctionId)

    const response = await cancel(auctionId, 'op-ok')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      auctionId,
      status: 'CANCELLED',
      refundAmountCredits: 1.5,
      walletRefundStatus: 'CONFIRMED',
      inventoryReleaseStatus: 'CONFIRMED',
      replayed: false,
    })
    expect(fees.refundCalls).toContainEqual({
      operationId: `auction:${auctionId}:cancellation:wallet-refund`,
      chargeId: `charge:${auctionId}`,
      amount: 1.5,
    })
    expect(inventory.releaseCalls).toContainEqual(
      expect.objectContaining({
        commitmentId: `commitment:${auctionId}`,
        auctionId,
        ownerId: SELLER_SUBJECT,
        productId: 'product-1',
        reason: 'AUCTION_CANCELLED',
      }),
    )
    const persisted = await auctions.findById(auctionId)
    expect(persisted?.status).toBe('CANCELLED')
  })

  // 29. falta Idempotency-Key -> rechazo.
  it('rechaza con 400 si falta Idempotency-Key', async () => {
    const auctionId = 'auction-http-no-key'
    await seed(auctionId)

    const response = await cancel(auctionId, undefined)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })
  })

  // 30. misma key/mismo payload -> replay seguro.
  it('un reintento con la misma Idempotency-Key replica la respuesta sin duplicar efectos', async () => {
    const auctionId = 'auction-http-replay'
    await seed(auctionId)

    const first = await cancel(auctionId, 'op-replay')
    expect(first.status).toBe(200)
    expect(first.body.replayed).toBe(false)

    const second = await cancel(auctionId, 'op-replay')
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ ...first.body, replayed: true })

    expect(fees.refundCalls.filter((call) => call.chargeId === `charge:${auctionId}`)).toHaveLength(
      1,
    )
    expect(
      inventory.releaseCalls.filter((call) => call.commitmentId === `commitment:${auctionId}`),
    ).toHaveLength(1)
  })

  // 31. misma key/payload distinto -> 409.
  it('rechaza con 409 la misma Idempotency-Key reutilizada contra otra subasta', async () => {
    const first = 'auction-http-conflict-a'
    const second = 'auction-http-conflict-b'
    await seed(first)
    await seed(second)

    const ok = await cancel(first, 'op-conflict')
    expect(ok.status).toBe(200)

    const conflict = await cancel(second, 'op-conflict')
    expect(conflict.status).toBe(409)
  })

  // 32. con bids -> error correcto.
  it('rechaza con 409 AUCTION_HAS_BIDS si la subasta ya tiene pujas', async () => {
    const auctionId = 'auction-http-has-bids'
    await seed(auctionId, 1)

    const response = await cancel(auctionId, 'op-has-bids')

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'AUCTION_HAS_BIDS' })
    expect(fees.refundCalls).not.toContainEqual(
      expect.objectContaining({ chargeId: `charge:${auctionId}` }),
    )
  })

  // 33. ventana cerrada -> error correcto.
  it('rechaza con 409 AUCTION_CANCELLATION_WINDOW_CLOSED a menos de 6h del cierre', async () => {
    const auctionId = 'auction-http-window-closed'
    const auction = Auction.publish({
      auctionId,
      sellerId: SELLER_SUBJECT,
      productId: 'product-1',
      durationHours: 24,
      minimumBidCredits: 10,
      // Publicada hace casi 24h: menos de 6h restantes para el cierre.
      publishedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })
    await auctions.publish({
      operationId: `publish:${auctionId}`,
      auction,
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
    })

    const response = await cancel(auctionId, 'op-window-closed')

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: 'AUCTION_CANCELLATION_WINDOW_CLOSED' })
  })

  // 34. no owner -> error correcto.
  it('rechaza con 403 si el solicitante no es el vendedor', async () => {
    const auctionId = 'auction-http-not-owner'
    await seed(auctionId)

    const response = await cancel(auctionId, 'op-not-owner', 'token-other')

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'AUCTION_NOT_OWNER' })
    const persisted = await auctions.findById(auctionId)
    expect(persisted?.status).toBe('ACTIVE')
  })

  // 35. not found -> error correcto.
  it('rechaza con 404 una subasta inexistente', async () => {
    const response = await cancel('auction-http-missing', 'op-missing')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'AUCTION_NOT_FOUND' })
  })

  it('rechaza sin autenticacion', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auctions/auction-http-any/cancel')
      .set('Idempotency-Key', 'op-no-auth')
      .send()

    expect(response.status).toBe(401)
  })
})
