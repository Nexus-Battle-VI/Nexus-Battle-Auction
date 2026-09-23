import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import type { ProcessExpiredAuctionsResult } from '../../src/application/use-cases/ProcessExpiredAuctions'
import { ProcessExpiredAuctions } from '../../src/application/use-cases/ProcessExpiredAuctions'
import { SettleAuction } from '../../src/application/use-cases/SettleAuction'
import {
  APP_CONFIG,
  AppModule,
  DATABASE,
  LOGGER,
} from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import type { Logger } from '../../src/infrastructure/observability/logger'
import {
  SCHEDULER_TIMER,
  type SchedulerTimerHandle,
  type SchedulerTimerPort,
} from '../../src/infrastructure/scheduling/SchedulerTimer'

class BootstrapTimer implements SchedulerTimerPort {
  readonly registrations: { callback: () => void; intervalMs: number }[] = []
  readonly cleared: SchedulerTimerHandle[] = []

  setInterval(callback: () => void, intervalMs: number): SchedulerTimerHandle {
    const handle = { timer: this.registrations.length }
    this.registrations.push({ callback, intervalMs })
    return handle
  }

  clearInterval(handle: SchedulerTimerHandle): void {
    this.cleared.push(handle)
  }
}

const log: jest.Mocked<Logger> = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

const batchResult: ProcessExpiredAuctionsResult = {
  claimed: 0,
  completed: 0,
  retryable: 0,
  terminal: 0,
  unexpectedErrors: 0,
}

const bootstrap = async (enabled: boolean) => {
  const timer = new BootstrapTimer()
  const worker: jest.Mocked<Pick<ProcessExpiredAuctions, 'runBatch'>> = {
    runBatch: jest.fn().mockResolvedValue(batchResult),
  }
  const config = loadConfig(
    enabled
      ? {
          NODE_ENV: 'test',
          PERSISTENCE_DRIVER: 'postgres',
          DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
          INTERNAL_SERVICE_AUTH_SECRET: 'shared-secret',
          WALLET_BASE_URL: 'http://wallet:3004',
          INVENTORY_BASE_URL: 'http://inventory:3006',
          AUCTION_SETTLEMENT_SCHEDULER_ENABLED: 'true',
          AUCTION_SETTLEMENT_POLL_INTERVAL_MS: '2500',
        }
      : { NODE_ENV: 'test' },
  )
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(DATABASE)
    .useValue(null)
    .overrideProvider(LOGGER)
    .useValue(log)
    .overrideProvider(SCHEDULER_TIMER)
    .useValue(timer)
    .overrideProvider(ProcessExpiredAuctions)
    .useValue(worker)
    .compile()
  const app = moduleRef.createNestApplication()
  await app.init()
  return { app, timer, worker }
}

describe('Bootstrap del scheduler de settlement', () => {
  let app: INestApplication | null = null

  afterEach(async () => {
    await app?.close()
    app = null
    jest.clearAllMocks()
  })

  it('arranca deshabilitado sin registrar timer ni ejecutar settlement', async () => {
    const runtime = await bootstrap(false)
    app = runtime.app

    expect(runtime.timer.registrations).toEqual([])
    expect(runtime.worker.runBatch).not.toHaveBeenCalled()
  })

  it('arranca habilitado, registra timer y no ejecuta antes del primer tick', async () => {
    const runtime = await bootstrap(true)
    app = runtime.app

    expect(runtime.timer.registrations).toHaveLength(1)
    expect(runtime.timer.registrations[0]?.intervalMs).toBe(2_500)
    expect(runtime.worker.runBatch).not.toHaveBeenCalled()
    expect(runtime.app.get(SettleAuction)).toBeInstanceOf(SettleAuction)
  })
})
