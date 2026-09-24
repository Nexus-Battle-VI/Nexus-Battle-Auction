import { Controller, Get, Module, Param, type INestApplication } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'node:net'

import { InternalOnly } from '../../src/adapters/inbound/http/auth/decorators'
import { InternalServiceGuard } from '../../src/adapters/inbound/http/auth/internal-service.guard'
import { CatalogProductPolicyClient } from '../../src/adapters/outbound/http/CatalogProductPolicyClient'
import { HttpBidCreditsClient } from '../../src/adapters/outbound/http/HttpBidCreditsClient'
import { HttpSellerSanctionClient } from '../../src/adapters/outbound/http/HttpSellerSanctionClient'
import { OfficialAuctionEligibilityClient } from '../../src/adapters/outbound/http/OfficialAuctionEligibilityClient'
import { WalletHttpClient } from '../../src/adapters/outbound/http/WalletHttpClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import { SystemClock } from '../../src/adapters/outbound/system/SystemClock'
import { createLogger } from '../../src/infrastructure/observability/logger'

/**
 * Contrato HMAC de los GET internos contra un receptor HTTP REAL.
 *
 * Los guards internos de Wallet, Catalog y Account verifican la firma sobre
 * `request.body ?? {}`, y con Express 5 un GET sin cuerpo llega con
 * `request.body` indefinido. Las pruebas unitarias de los clientes usan un
 * `fetch` simulado y no pueden detectar esa diferencia; esta si: usa el
 * `InternalServiceGuard` productivo de Auction -mismo contrato, duplicado a
 * proposito en cada servicio- sobre un servidor Nest/Express real, y llama con
 * los clientes productivos y `fetch` real.
 *
 * Los controladores son fixtures con las rutas y respuestas de cada receptor.
 */

const secret = 'internal-get-hmac-secret'

@InternalOnly()
@Controller()
class InternalGetFixturesController {
  @Get('internal/v1/wallet/buy-now-transfers/balance/:playerId')
  balance(@Param('playerId') playerId: string) {
    return { playerId, balance: 5000, reserved: 1200, available: 3800 }
  }

  @Get('internal/v1/catalog/products/:productId/premium-status')
  premium(@Param('productId') productId: string) {
    return { productId, premium: false }
  }

  @Get('internal/v1/catalog/products/:productId/official-auction-eligibility')
  official(@Param('productId') productId: string) {
    return { productId, exclusive: true, officialMark: 'OFFICIAL', publishable: true }
  }

  @Get('internal/accounts/:sellerId/active-sanctions')
  sanctions() {
    return { hasActiveSanctions: false }
  }
}

@Module({
  controllers: [InternalGetFixturesController],
  providers: [
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) =>
        new InternalServiceGuard({
          reflector,
          secret,
          allowedServices: ['auction'],
          clock: new SystemClock(),
          logger: createLogger({ level: 'error', service: 'test', version: 'test' }),
        }),
      inject: [Reflector],
    },
  ],
})
class InternalGetFixturesModule {}

describe('Contrato HMAC de GET internos contra un guard HTTP real', () => {
  let app: INestApplication
  let baseUrl: string
  const logger = { warn: jest.fn() }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [InternalGetFixturesModule],
    }).compile()

    app = moduleRef.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')

    baseUrl = `http://127.0.0.1:${String((app.getHttpServer().address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await app.close()
  })

  it('control negativo: un GET firmado sobre null es rechazado con 401', async () => {
    const path = '/api/internal/v1/wallet/buy-now-transfers/balance/buyer-1'
    const timestamp = String(Date.now())

    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        [INTERNAL_SERVICE_HEADER]: 'auction',
        [INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(secret, {
          service: 'auction',
          method: 'GET',
          path,
          timestamp,
          body: null,
        }),
      },
    })

    expect(response.status).toBe(401)
  })

  it('WalletHttpClient (HU-64) obtiene el saldo sin 401', async () => {
    const client = new WalletHttpClient({
      baseUrl,
      secret,
      serviceName: 'auction',
      timeoutMs: 2_000,
      logger,
    })

    await expect(client.getAvailableCredits('buyer-1')).resolves.toBe(3800)
  })

  it('HttpBidCreditsClient (HU-63) obtiene el saldo sin 401', async () => {
    const client = new HttpBidCreditsClient({ baseUrl, secret, timeoutMs: 2_000 })

    await expect(client.getAvailableCredits('bidder-1')).resolves.toEqual({
      availableCredits: 3800,
    })
  })

  it('CatalogProductPolicyClient (HU-62) obtiene la politica sin 401', async () => {
    const client = new CatalogProductPolicyClient({
      baseUrl,
      secret,
      serviceName: 'auction',
      timeoutMs: 2_000,
      logger,
    })

    await expect(client.getPolicy('product-1')).resolves.toEqual({ tradableInAuction: true })
  })

  it('OfficialAuctionEligibilityClient (HU-66) obtiene la elegibilidad sin 401', async () => {
    const client = new OfficialAuctionEligibilityClient({
      baseUrl,
      secret,
      serviceName: 'auction',
      timeoutMs: 2_000,
      logger,
    })

    await expect(client.getEligibility('product-1')).resolves.toMatchObject({
      productId: 'product-1',
    })
  })

  it('HttpSellerSanctionClient (HU-62) consulta sanciones sin 401', async () => {
    const client = new HttpSellerSanctionClient({
      baseUrl,
      secret,
      serviceName: 'auction',
      timeoutMs: 2_000,
      logger,
    })

    await expect(client.hasActiveSanctions('seller-1')).resolves.toBe(false)
  })
})
