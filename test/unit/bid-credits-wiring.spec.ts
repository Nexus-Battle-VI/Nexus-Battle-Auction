import { HttpBidCreditsClient } from '../../src/adapters/outbound/http/HttpBidCreditsClient'
import { UnavailableBidCredits } from '../../src/adapters/outbound/http/UnavailableAuctionDependencies'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { createBidCreditsPort } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'

const clock: ClockPort = { now: () => new Date('2026-09-23T12:00:00.000Z') }

describe('BID_CREDITS wiring', () => {
  it('conserva el fallback fail-closed sin URL o secreto de Wallet', () => {
    expect(createBidCreditsPort(loadConfig({}), clock)).toBeInstanceOf(UnavailableBidCredits)
    expect(
      createBidCreditsPort(loadConfig({ INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret' }), clock),
    ).toBeInstanceOf(UnavailableBidCredits)
  })

  it('selecciona HttpBidCreditsClient con URL y secreto configurados', () => {
    const config = loadConfig({
      WALLET_BASE_URL: 'http://wallet:3009',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret',
    })
    expect(createBidCreditsPort(config, clock)).toBeInstanceOf(HttpBidCreditsClient)
  })
})
