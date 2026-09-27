import { HttpEarlyClosureNotificationClient } from '../../src/adapters/outbound/http/HttpEarlyClosureNotificationClient'
import { HttpOutbidNotificationClient } from '../../src/adapters/outbound/http/HttpOutbidNotificationClient'
import { UnavailableEarlyClosureNotification } from '../../src/adapters/outbound/http/UnavailableAuctionDependencies'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { NOTIFICATION } from '../../src/application/ports/NotificationPort'
import { OUTBID_NOTIFICATION } from '../../src/application/ports/OutbidNotificationPort'
import {
  AppModule,
  createEarlyClosureNotificationPort,
} from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { createLogger } from '../../src/infrastructure/observability/logger'

const clock: ClockPort = { now: () => new Date('2026-09-24T12:00:00.000Z') }
const logger = createLogger({ level: 'error', service: 'test', version: 'test' })

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

describe('NOTIFICATION wiring HU-64.5', () => {
  it('A. con NOTIFICATIONS_BASE_URL y secreto selecciona HttpEarlyClosureNotificationClient', () => {
    const config = loadConfig({
      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret',
    })

    expect(createEarlyClosureNotificationPort(config, logger, clock)).toBeInstanceOf(
      HttpEarlyClosureNotificationClient,
    )
  })

  it('B. sin URL o sin secreto conserva el fallback UnavailableEarlyClosureNotification', () => {
    expect(createEarlyClosureNotificationPort(loadConfig({}), logger, clock)).toBeInstanceOf(
      UnavailableEarlyClosureNotification,
    )
    expect(
      createEarlyClosureNotificationPort(
        loadConfig({ INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret' }),
        logger,
        clock,
      ),
    ).toBeInstanceOf(UnavailableEarlyClosureNotification)
  })

  it('AppModule registra NOTIFICATION con la factory real y sus dependencias', () => {
    const provider = providerFor(NOTIFICATION)

    expect(provider.useFactory).toBe(createEarlyClosureNotificationPort)
    expect(provider.inject).toHaveLength(3)
  })

  it('no rompe OUTBID_NOTIFICATION: sigue seleccionando HttpOutbidNotificationClient', () => {
    const config = loadConfig({
      NOTIFICATIONS_BASE_URL: 'http://notifications:3005',
      INTERNAL_SERVICE_AUTH_SECRET: 'test-only-secret',
    })
    const outbid = providerFor(OUTBID_NOTIFICATION).useFactory as (
      config: unknown,
      logger: unknown,
      clock: unknown,
    ) => unknown

    expect(outbid(config, logger, clock)).toBeInstanceOf(HttpOutbidNotificationClient)
  })
})
