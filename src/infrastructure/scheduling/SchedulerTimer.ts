export type SchedulerTimerHandle = object

export interface SchedulerTimerPort {
  setInterval(callback: () => void, intervalMs: number): SchedulerTimerHandle
  clearInterval(handle: SchedulerTimerHandle): void
}

export const SCHEDULER_TIMER = Symbol('SchedulerTimerPort')

export class NodeSchedulerTimer implements SchedulerTimerPort {
  setInterval(callback: () => void, intervalMs: number): SchedulerTimerHandle {
    return globalThis.setInterval(callback, intervalMs)
  }

  clearInterval(handle: SchedulerTimerHandle): void {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>)
  }
}
