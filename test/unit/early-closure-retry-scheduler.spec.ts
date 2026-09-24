import type { EarlyClosureNotificationService } from '../../src/application/services/EarlyClosureNotificationService'
import { EarlyClosureRetryScheduler } from '../../src/infrastructure/scheduling/EarlyClosureRetryScheduler'
import type { Logger } from '../../src/infrastructure/observability/logger'
import type {
  SchedulerTimerHandle,
  SchedulerTimerPort,
} from '../../src/infrastructure/scheduling/SchedulerTimer'

class ManualSchedulerTimer implements SchedulerTimerPort {
  readonly registrations: { callback: () => void; intervalMs: number }[] = []
  readonly cleared: SchedulerTimerHandle[] = []

  setInterval(callback: () => void, intervalMs: number): SchedulerTimerHandle {
    const handle = { index: this.registrations.length }
    this.registrations.push({ callback, intervalMs })
    return handle
  }

  clearInterval(handle: SchedulerTimerHandle): void {
    this.cleared.push(handle)
  }

  trigger(index = 0): void {
    const registration = this.registrations[index]
    if (registration === undefined) throw new Error('No existe el timer solicitado.')
    registration.callback()
  }
}

const logger = (): jest.Mocked<Logger> => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const createScheduler = (enabled: boolean, intervalMs = 30_000) => {
  const timer = new ManualSchedulerTimer()
  const log = logger()
  const retryFailed: jest.MockedFunction<EarlyClosureNotificationService['retryFailed']> = jest
    .fn()
    .mockResolvedValue([])
  const scheduler = new EarlyClosureRetryScheduler({ retryFailed }, timer, log, {
    enabled,
    pollIntervalMs: intervalMs,
  })
  return { scheduler, timer, log, retryFailed }
}

describe('EarlyClosureRetryScheduler', () => {
  it('disabled no registra timer, no ejecuta y destroy es seguro', async () => {
    const { scheduler, timer, retryFailed } = createScheduler(false)
    scheduler.onModuleInit()

    expect(timer.registrations).toEqual([])
    expect(retryFailed).not.toHaveBeenCalled()
    await expect(scheduler.onModuleDestroy()).resolves.toBeUndefined()
    expect(timer.cleared).toEqual([])
  })

  it('enabled registra un timer y espera al primer tick', async () => {
    const { scheduler, timer, log, retryFailed } = createScheduler(true, 90_000)
    scheduler.onModuleInit()

    expect(timer.registrations).toHaveLength(1)
    expect(timer.registrations[0]?.intervalMs).toBe(90_000)
    expect(retryFailed).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('early_closure_retry_scheduler_started', {
      pollIntervalMs: 90_000,
    })
    await scheduler.onModuleDestroy()
  })

  it('cada tick libre reintenta exactamente un batch', async () => {
    const { scheduler, timer, retryFailed } = createScheduler(true)
    scheduler.onModuleInit()
    timer.trigger()
    await flushPromises()

    expect(retryFailed).toHaveBeenCalledTimes(1)
    await scheduler.onModuleDestroy()
  })

  it('omite ticks solapados y vuelve a ejecutar tras completar', async () => {
    const { scheduler, timer, log, retryFailed } = createScheduler(true)
    const first = deferred<Awaited<ReturnType<EarlyClosureNotificationService['retryFailed']>>>()
    retryFailed.mockReturnValueOnce(first.promise).mockResolvedValue([])
    scheduler.onModuleInit()

    timer.trigger()
    timer.trigger()
    expect(retryFailed).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('early_closure_retry_scheduler_tick_skipped')

    first.resolve([])
    await flushPromises()
    timer.trigger()
    await flushPromises()
    expect(retryFailed).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('captura un error de batch y permite el tick siguiente', async () => {
    const { scheduler, timer, log, retryFailed } = createScheduler(true)
    retryFailed.mockRejectedValueOnce(new Error('notifications unavailable')).mockResolvedValue([])
    scheduler.onModuleInit()

    timer.trigger()
    await flushPromises()
    expect(log.error).toHaveBeenCalledWith('early_closure_retry_scheduler_error', {
      detail: 'notifications unavailable',
    })

    timer.trigger()
    await flushPromises()
    expect(retryFailed).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('destroy cancela el timer, espera el batch activo e ignora callbacks residuales', async () => {
    const { scheduler, timer, log, retryFailed } = createScheduler(true)
    const active = deferred<Awaited<ReturnType<EarlyClosureNotificationService['retryFailed']>>>()
    retryFailed.mockReturnValue(active.promise)
    scheduler.onModuleInit()
    timer.trigger()

    const destroying = scheduler.onModuleDestroy()
    expect(timer.cleared).toHaveLength(1)
    timer.trigger()
    expect(retryFailed).toHaveBeenCalledTimes(1)

    active.resolve([])
    await destroying
    expect(log.info).toHaveBeenCalledWith('early_closure_retry_scheduler_stopped')
  })
})
