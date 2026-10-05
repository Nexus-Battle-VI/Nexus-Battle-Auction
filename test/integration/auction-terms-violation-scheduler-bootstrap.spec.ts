import 'reflect-metadata'

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AuctionCancellationReconciler } from '../../src/application/use-cases/AuctionCancellationReconciler'
import { CancelAuctionAutomatically } from '../../src/application/use-cases/CancelAuctionAutomatically'
import {
  CancelAuctionsForTermsViolations,
  type CancelAuctionsForTermsViolationsResult,
} from '../../src/application/use-cases/CancelAuctionsForTermsViolations'
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

const batchResult: CancelAuctionsForTermsViolationsResult = {
  processedSellers: 0,
  triggeredSellers: 0,
  cancelledAuctions: 0,
  failed: 0,
}

const bootstrap = async (enabled: boolean) => {
  const timer = new BootstrapTimer()
  const worker: jest.Mocked<Pick<CancelAuctionsForTermsViolations, 'runBatch'>> = {
    runBatch: jest.fn().mockResolvedValue(batchResult),
  }
  // `loadConfig` exige postgres y dependencias reales para habilitarlo (ver
  // config.spec); aqui solo interesa el cableado, asi que se activa sobre la
  // configuracion en memoria ya validada.
  const config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    auctionTermsViolationSchedulerEnabled: enabled,
    auctionTermsViolationPollIntervalMs: 45_000,
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(LOGGER)
    .useValue(log)
    .overrideProvider(SCHEDULER_TIMER)
    .useValue(timer)
    .overrideProvider(CancelAuctionsForTermsViolations)
    .useValue(worker)
    .compile()
  const app = moduleRef.createNestApplication()
  await app.init()
  return { app, timer, worker, moduleRef }
}

describe('Bootstrap del sondeo de sanciones AUCTION_TERMS_VIOLATION (HU-90, CA-05)', () => {
  let app: INestApplication | null = null

  afterEach(async () => {
    await app?.close()
    app = null
    jest.clearAllMocks()
  })

  it('arranca deshabilitado por defecto sin registrar timer ni ejecutar el ciclo', async () => {
    const runtime = await bootstrap(false)
    app = runtime.app

    expect(loadConfig({ NODE_ENV: 'test' }).auctionTermsViolationSchedulerEnabled).toBe(false)
    expect(runtime.timer.registrations).toEqual([])
    expect(runtime.worker.runBatch).not.toHaveBeenCalled()
  })

  it('habilitado registra un timer con el intervalo configurado y lo cancela al cerrar', async () => {
    const runtime = await bootstrap(true)

    expect(runtime.timer.registrations).toHaveLength(1)
    expect(runtime.timer.registrations[0]?.intervalMs).toBe(45_000)
    expect(runtime.worker.runBatch).not.toHaveBeenCalled()

    await runtime.app.close()
    expect(runtime.timer.cleared).toHaveLength(1)
  })

  it('resuelve el caso de uso automatico y el reconciler que lo reutiliza', async () => {
    const runtime = await bootstrap(false)
    app = runtime.app

    expect(runtime.moduleRef.get(CancelAuctionAutomatically)).toBeInstanceOf(
      CancelAuctionAutomatically,
    )
    expect(runtime.moduleRef.get(AuctionCancellationReconciler)).toBeInstanceOf(
      AuctionCancellationReconciler,
    )
  })

  it('no expone la cancelacion automatica en ningun controlador HTTP', () => {
    const httpDirectory = join(__dirname, '../../src/adapters/inbound/http')
    const sources = readdirSync(httpDirectory)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(httpDirectory, file), 'utf8'))

    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources) {
      expect(source).not.toContain('CancelAuctionAutomatically')
      expect(source).not.toContain('CancelAuctionsForTermsViolations')
      expect(source).not.toMatch(/auto-cancel/i)
    }
  })
})
