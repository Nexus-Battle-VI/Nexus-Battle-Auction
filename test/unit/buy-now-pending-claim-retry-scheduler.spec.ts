import { BuyNowPendingClaimRetryScheduler } from '../../src/infrastructure/scheduling/BuyNowPendingClaimRetryScheduler'
import type { Logger } from '../../src/infrastructure/observability/logger'
import type {
  SchedulerTimerHandle,
  SchedulerTimerPort,
} from '../../src/infrastructure/scheduling/SchedulerTimer'

class Timer implements SchedulerTimerPort {
  registrations: { callback: () => void; interval: number }[] = []
  cleared: SchedulerTimerHandle[] = []
  setInterval(callback: () => void, interval: number): SchedulerTimerHandle {
    const handle = { index: this.registrations.length }
    this.registrations.push({ callback, interval })
    return handle
  }
  clearInterval(handle: SchedulerTimerHandle): void {
    this.cleared.push(handle)
  }
  tick(): void {
    this.registrations[0]?.callback()
  }
}
const log = (): jest.Mocked<Logger> => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
})
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const fixture = (enabled = true) => {
  const timer = new Timer()
  const logger = log()
  const runBatch = jest.fn().mockResolvedValue({})
  return {
    scheduler: new BuyNowPendingClaimRetryScheduler({ runBatch }, timer, logger, {
      enabled,
      pollIntervalMs: 1234,
    }),
    timer,
    logger,
    runBatch,
  }
}

describe('BuyNowPendingClaimRetryScheduler', () => {
  it('disabled no registra ni ejecuta', () => {
    const f = fixture(false)
    f.scheduler.onModuleInit()
    expect(f.timer.registrations).toEqual([])
    expect(f.runBatch).not.toHaveBeenCalled()
  })
  it('registra el intervalo y ejecuta un tick', async () => {
    const f = fixture()
    f.scheduler.onModuleInit()
    expect(f.timer.registrations[0]?.interval).toBe(1234)
    f.timer.tick()
    await flush()
    expect(f.runBatch).toHaveBeenCalledTimes(1)
  })
  it('no solapa y permite otro tick al terminar', async () => {
    const f = fixture()
    let resolve!: () => void
    f.runBatch.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    f.scheduler.onModuleInit()
    f.timer.tick()
    f.timer.tick()
    expect(f.runBatch).toHaveBeenCalledTimes(1)
    resolve()
    await flush()
    f.timer.tick()
    await flush()
    expect(f.runBatch).toHaveBeenCalledTimes(2)
  })
  it('captura error y shutdown espera el batch', async () => {
    const f = fixture()
    f.runBatch.mockRejectedValueOnce(new Error('down'))
    f.scheduler.onModuleInit()
    f.timer.tick()
    await flush()
    expect(f.logger.error).toHaveBeenCalled()
    let resolve!: () => void
    f.runBatch.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done
      }),
    )
    f.timer.tick()
    const stopping = f.scheduler.onModuleDestroy()
    expect(f.timer.cleared).toHaveLength(1)
    resolve()
    await expect(stopping).resolves.toBeUndefined()
  })
})
