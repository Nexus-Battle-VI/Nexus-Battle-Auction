import { HttpWatchlistEventPublisher } from '../../src/adapters/outbound/http/HttpWatchlistEventPublisher'
import { UnavailableWatchlistEventPublisher } from '../../src/adapters/outbound/http/UnavailableWatchlistEventPublisher'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { WATCHLIST_EVENT_PUBLISHER } from '../../src/application/ports/WatchlistEventPublisherPort'
import {
  AppModule,
  createWatchlistEventPublisher,
} from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'

const clock: ClockPort = { now: () => new Date('2026-09-24T12:00:00.000Z') }

interface FactoryProvider {
  readonly provide: unknown
  readonly useFactory: (...args: never[]) => unknown
  readonly inject?: readonly unknown[]
}

const providerFor = (token: symbol): FactoryProvider => {
  const providers = Reflect.getMetadata('providers', AppModule) as readonly unknown[]
  const provider = providers.find(
    (candidate): candidate is FactoryProvider =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { provide?: unknown }).provide === token,
  )

  if (provider === undefined) {
    throw new Error(`No hay provider para ${String(token)}.`)
  }

  return provider
}

/**
 * HU-68: watchlist-events vive en un servidor/puerto de Notifications
 * DISTINTO del de outbid/closed-by-buy-now/auto-bid-limit-reached. Antes de
 * esta correccion, el publisher usaba `config.notificationsBaseUrl` -el
 * mismo valor que esos otros tres-, asi que con la topologia real
 * (`NOTIFICATIONS_BASE_URL=http://notifications:3005`) toda publicacion de
 * eventos de watchlist llegaba al puerto equivocado y Notifications
 * respondia 404.
 */
describe('WATCHLIST_EVENT_PUBLISHER wiring HU-68', () => {
  it('A. con NOTIFICATIONS_WATCHLIST_BASE_URL y secreto selecciona HttpWatchlistEventPublisher', () => {
    const config = loadConfig({
      NOTIFICATIONS_WATCHLIST_BASE_URL: 'http://notifications:3004',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret',
    })

    expect(createWatchlistEventPublisher(config, clock)).toBeInstanceOf(HttpWatchlistEventPublisher)
  })

  it('B. sin URL de watchlist o sin secreto conserva el fallback UnavailableWatchlistEventPublisher', () => {
    expect(createWatchlistEventPublisher(loadConfig({}), clock)).toBeInstanceOf(
      UnavailableWatchlistEventPublisher,
    )
    expect(
      createWatchlistEventPublisher(
        loadConfig({ INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret' }),
        clock,
      ),
    ).toBeInstanceOf(UnavailableWatchlistEventPublisher)
  })

  it('C. configurar solo NOTIFICATIONS_BASE_URL (outbid/closed-by-buy-now) NO activa watchlist', () => {
    // Es exactamente el bug que esta prueba impide que vuelva: la topologia
    // real solo declara NOTIFICATIONS_BASE_URL (puerto 3005) y, sin la
    // variable propia de watchlist, el publisher debe seguir fail-closed en
    // vez de apuntar por error al puerto de outbid.
    const config = loadConfig({
      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret',
    })

    expect(createWatchlistEventPublisher(config, clock)).toBeInstanceOf(
      UnavailableWatchlistEventPublisher,
    )
  })

  it('D. la URL de watchlist puede coexistir con NOTIFICATIONS_BASE_URL, cada una a su puerto', () => {
    const config = loadConfig({
      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',
      NOTIFICATIONS_WATCHLIST_BASE_URL: 'http://notifications:3004',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret',
    })

    const publisher = createWatchlistEventPublisher(config, clock)

    expect(publisher).toBeInstanceOf(HttpWatchlistEventPublisher)
    expect(publisher).toMatchObject({
      options: expect.objectContaining({ baseUrl: 'http://notifications:3004' }),
    })
  })

  it('AppModule registra WATCHLIST_EVENT_PUBLISHER con la factory real y sus dependencias', () => {
    const provider = providerFor(WATCHLIST_EVENT_PUBLISHER)

    expect(provider.useFactory).toBe(createWatchlistEventPublisher)
    expect(provider.inject).toHaveLength(2)
  })
})
