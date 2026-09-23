import type { ExpirePendingClaims, ExpirePendingClaimsResult } from '../../src/application/use-cases/ExpirePendingClaims'
import { AuctionPendingClaimExpirationScheduler } from '../../src/infrastructure/scheduling/AuctionPendingClaimExpirationScheduler'
import type {
  SchedulerTimerHandle,
  SchedulerTimerPort,
} from '../../src/infrastructure/scheduling/SchedulerTimer'
import type { Logger } from '../../src/infrastructure/observability/logger'

const batchResult: ExpirePendingClaimsResult = { candidates: 0, expired: 0, skipped: 0 }

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

const createScheduler = (enabled: boolean, intervalMs = 60_000) => {
  const timer = new ManualSchedulerTimer()
  const log = logger()
  const runBatch: jest.MockedFunction<ExpirePendingClaims['runBatch']> = jest
    .fn()
    .mockResolvedValue(batchResult)
  const scheduler = new AuctionPendingClaimExpirationScheduler({ runBatch }, timer, log, {
    enabled,
    pollIntervalMs: intervalMs,
  })
  return { scheduler, timer, log, runBatch }
}

describe('AuctionPendingClaimExpirationScheduler', () => {
  it('disabled no registra timer, no ejecuta y destroy es seguro', async () => {
    const { scheduler, timer, runBatch } = createScheduler(false)
    scheduler.onModuleInit()

    expect(timer.registrations).toEqual([])
    expect(runBatch).not.toHaveBeenCalled()
    await expect(scheduler.onModuleDestroy()).resolves.toBeUndefined()
    expect(timer.cleared).toEqual([])
  })

  it('enabled registra un timer y espera al primer tick', async () => {
    const { scheduler, timer, log, runBatch } = createScheduler(true, 90_000)
    scheduler.onModuleInit()

    expect(timer.registrations).toHaveLength(1)
    expect(timer.registrations[0]?.intervalMs).toBe(90_000)
    expect(runBatch).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('auction_pending_claim_expiration_scheduler_started', {
      pollIntervalMs: 90_000,
    })
    await scheduler.onModuleDestroy()
  })

  it('cada tick libre ejecuta exactamente un batch', async () => {
    const { scheduler, timer, runBatch } = createScheduler(true)
    scheduler.onModuleInit()
    timer.trigger()
    await flushPromises()

    expect(runBatch).toHaveBeenCalledTimes(1)
    await scheduler.onModuleDestroy()
  })

  it('omite ticks solapados y vuelve a ejecutar tras completar', async () => {
    const { scheduler, timer, log, runBatch } = createScheduler(true)
    const first = deferred<ExpirePendingClaimsResult>()
    runBatch.mockReturnValueOnce(first.promise).mockResolvedValue(batchResult)
    scheduler.onModuleInit()

    timer.trigger()
    timer.trigger()
    expect(runBatch).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('auction_pending_claim_expiration_scheduler_tick_skipped')

    first.resolve(batchResult)
    await flushPromises()
    timer.trigger()
    await flushPromises()
    expect(runBatch).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('captura un error de batch y permite el tick siguiente', async () => {
    const { scheduler, timer, log, runBatch } = createScheduler(true)
    runBatch.mockRejectedValueOnce(new Error('db unavailable')).mockResolvedValue(batchResult)
    scheduler.onModuleInit()

    timer.trigger()
    await flushPromises()
    expect(log.error).toHaveBeenCalledWith('auction_pending_claim_expiration_scheduler_error', {
      detail: 'db unavailable',
    })

    timer.trigger()
    await flushPromises()
    expect(runBatch).toHaveBeenCalledTimes(2)
    await scheduler.onModuleDestroy()
  })

  it('destroy cancela el timer, espera el batch activo e ignora callbacks residuales', async () => {
    const { scheduler, timer, log, runBatch } = createScheduler(true)
    const active = deferred<ExpirePendingClaimsResult>()
    runBatch.mockReturnValue(active.promise)
    scheduler.onModuleInit()
    timer.trigger()

    const destroying = scheduler.onModuleDestroy()
    expect(timer.cleared).toHaveLength(1)
    timer.trigger()
    expect(runBatch).toHaveBeenCalledTimes(1)

    active.resolve(batchResult)
    await destroying
    expect(log.info).toHaveBeenCalledWith('auction_pending_claim_expiration_scheduler_stopped')
  })
})
