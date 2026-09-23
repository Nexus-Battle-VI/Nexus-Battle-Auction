import type { AuctionInventorySettlementIntentRepositoryPort } from '../ports/AuctionInventorySettlementIntentRepositoryPort'
import {
  AuctionSettlementStatus,
  type AuctionSettlementSnapshot,
} from '../ports/AuctionSettlementRepositoryPort'
import type { AuctionSettlementWorkRepositoryPort } from '../ports/AuctionSettlementWorkRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { SettleAuction } from './SettleAuction'

export interface ProcessExpiredAuctionsLogger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  warn(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
  error(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void
}

export interface ProcessExpiredAuctionsOptions {
  readonly batchSize: number
  readonly concurrency: number
  readonly leaseMs: number
  readonly retryDelayMs: number
  readonly workerId: string
}

export interface ProcessExpiredAuctionsResult {
  readonly claimed: number
  readonly completed: number
  readonly retryable: number
  readonly terminal: number
  readonly unexpectedErrors: number
}

type MutableResult = {
  -readonly [Key in keyof ProcessExpiredAuctionsResult]: ProcessExpiredAuctionsResult[Key]
}

export class ProcessExpiredAuctions {
  constructor(
    private readonly work: AuctionSettlementWorkRepositoryPort,
    private readonly settleAuction: Pick<SettleAuction, 'execute'>,
    private readonly inventoryIntents: AuctionInventorySettlementIntentRepositoryPort,
    private readonly clock: ClockPort,
    private readonly logger: ProcessExpiredAuctionsLogger,
    private readonly options: ProcessExpiredAuctionsOptions,
  ) {}

  async runBatch(): Promise<ProcessExpiredAuctionsResult> {
    const now = this.clock.now()
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs)
    const claimed = await this.work.claimDue({
      now,
      workerId: this.options.workerId,
      leaseUntil,
      limit: this.options.batchSize,
    })
    const result: MutableResult = {
      claimed: claimed.length,
      completed: 0,
      retryable: 0,
      terminal: 0,
      unexpectedErrors: 0,
    }

    this.logger.info('auction_settlement_batch_started', {
      workerId: this.options.workerId,
      claimed: claimed.length,
    })

    let nextIndex = 0
    const processNext = async (): Promise<void> => {
      while (nextIndex < claimed.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        const current = claimed[currentIndex]
        if (current === undefined) return
        await this.processOne(current.auctionId, result)
      }
    }
    const workerCount = Math.min(this.options.concurrency, claimed.length)
    await Promise.all(Array.from({ length: workerCount }, processNext))

    this.logger.info('auction_settlement_batch_completed', {
      workerId: this.options.workerId,
      ...result,
    })
    return result
  }

  private async processOne(auctionId: string, result: MutableResult): Promise<void> {
    this.logger.info('auction_settlement_claimed', {
      workerId: this.options.workerId,
      auctionId,
    })

    try {
      const settlement = await this.settleAuction.execute({ auctionId })
      const inventoryIntent = await this.inventoryIntents.getByAuctionId(auctionId)
      const updatedAt = this.clock.now()

      if (
        settlement.status === AuctionSettlementStatus.FailedTerminal ||
        inventoryIntent?.status === 'TERMINAL_ERROR'
      ) {
        await this.work.markTerminal({
          auctionId,
          workerId: this.options.workerId,
          now: updatedAt,
          error: this.outcomeError(settlement, inventoryIntent?.lastError ?? null),
        })
        result.terminal += 1
        this.logger.error('auction_settlement_terminal', {
          workerId: this.options.workerId,
          auctionId,
        })
        return
      }

      if (inventoryIntent?.status === 'PENDING' || inventoryIntent?.status === 'RETRYABLE') {
        await this.markRetryable(
          auctionId,
          this.outcomeError(settlement, inventoryIntent.lastError),
        )
        result.retryable += 1
        this.logger.warn('auction_settlement_retryable', {
          workerId: this.options.workerId,
          auctionId,
        })
        return
      }

      if (settlement.status === AuctionSettlementStatus.Completed) {
        await this.work.markCompleted({
          auctionId,
          workerId: this.options.workerId,
          now: updatedAt,
        })
        result.completed += 1
        this.logger.info('auction_settlement_succeeded', {
          workerId: this.options.workerId,
          auctionId,
        })
        return
      }

      await this.markRetryable(
        auctionId,
        this.outcomeError(settlement, inventoryIntent?.lastError ?? null),
      )
      result.retryable += 1
      this.logger.warn('auction_settlement_retryable', {
        workerId: this.options.workerId,
        auctionId,
      })
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      await this.markRetryable(auctionId, detail)
      result.retryable += 1
      result.unexpectedErrors += 1
      this.logger.error('auction_settlement_unexpected_error', {
        workerId: this.options.workerId,
        auctionId,
        detail,
      })
    }
  }

  private markRetryable(auctionId: string, error: string): Promise<unknown> {
    const updatedAt = this.clock.now()
    return this.work.markRetryable({
      auctionId,
      workerId: this.options.workerId,
      now: updatedAt,
      availableAt: new Date(updatedAt.getTime() + this.options.retryDelayMs),
      error,
    })
  }

  private outcomeError(
    settlement: AuctionSettlementSnapshot,
    inventoryError: string | null,
  ): string {
    return inventoryError ?? settlement.lastError ?? `Settlement pendiente: ${settlement.status}`
  }
}
