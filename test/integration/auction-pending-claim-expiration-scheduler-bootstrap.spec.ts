import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import type { ExpirePendingClaimsResult } from '../../src/application/use-cases/ExpirePendingClaims'
import { ExpirePendingClaims } from '../../src/application/use-cases/ExpirePendingClaims'
import { APP_CONFIG, AppModule, LOGGER } from '../../src/infrastructure/bootstrap/app.module'
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

const batchResult: ExpirePendingClaimsResult = { candidates: 0, expired: 0, skipped: 0 }

const bootstrap = async (enabled: boolean) => {
  const timer = new BootstrapTimer()
  const worker: jest.Mocked<Pick<ExpirePendingClaims, 'runBatch'>> = {
    runBatch: jest.fn().mockResolvedValue(batchResult),
  }
  const config = loadConfig(
    enabled
      ? {
          NODE_ENV: 'test',
          AUCTION_PENDING_CLAIM_EXPIRATION_SCHEDULER_ENABLED: 'true',
          AUCTION_PENDING_CLAIM_EXPIRATION_POLL_INTERVAL_MS: '90000',
        }
      : { NODE_ENV: 'test' },
  )
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(LOGGER)
    .useValue(log)
    .overrideProvider(SCHEDULER_TIMER)
    .useValue(timer)
    .overrideProvider(ExpirePendingClaims)
    .useValue(worker)
    .compile()
  const app = moduleRef.createNestApplication()
  await app.init()
  return { app, timer, worker }
}

describe('Bootstrap del scheduler de vencimiento de pending-claims (HU-69.6)', () => {
  let app: INestApplication | null = null

  afterEach(async () => {
    await app?.close()
    app = null
    jest.clearAllMocks()
  })

  it('arranca deshabilitado sin registrar timer ni ejecutar el batch', async () => {
    const runtime = await bootstrap(false)
    app = runtime.app

    expect(runtime.timer.registrations).toEqual([])
    expect(runtime.worker.runBatch).not.toHaveBeenCalled()
  })

  it('arranca habilitado (sin postgres ni Wallet/Inventory) y registra timer', async () => {
    const runtime = await bootstrap(true)
    app = runtime.app

    expect(runtime.timer.registrations).toHaveLength(1)
    expect(runtime.timer.registrations[0]?.intervalMs).toBe(90_000)
    expect(runtime.worker.runBatch).not.toHaveBeenCalled()
  })
})
