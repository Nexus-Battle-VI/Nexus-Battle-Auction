import {
  AuctionClosingOutcome,
  type AuctionClosingResultSnapshot,
} from '../../domain/entities/AuctionClosingResult'
import { AuctionStatus } from '../../domain/entities/Auction'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import {
  AuctionSettlementStatus,
  CaptureStatus,
  ReleaseStatus,
} from '../ports/AuctionSettlementRepositoryPort'
import type {
  AuctionSettlementRepositoryPort,
  AuctionSettlementSnapshot,
} from '../ports/AuctionSettlementRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { AuctionWalletPort } from '../ports/AuctionWalletPort'
import type { ClassifyAuctionLoserCredits } from './ClassifyAuctionLoserCredits'
import type { PrepareAuctionLoserReleaseTasks } from './PrepareAuctionLoserReleaseTasks'

export class SettleAuction {
  constructor(
    private readonly auctions: AuctionRepositoryPort,
    private readonly settlements: AuctionSettlementRepositoryPort,
    private readonly clock: ClockPort,
    private readonly wallet: AuctionWalletPort,
    private readonly classifyLoserCredits: ClassifyAuctionLoserCredits,
    private readonly prepareLoserReleaseTasks: PrepareAuctionLoserReleaseTasks,
  ) {}

  async execute(input: { auctionId: string }): Promise<AuctionSettlementSnapshot> {
    const auction = await this.auctions.findAuctionAggregate(input.auctionId)
    if (auction === null) throw new Error(`La subasta ${input.auctionId} no existe.`)

    if (auction.status === AuctionStatus.Active) {
      const leadingBid = await this.auctions.findLeadingBid(input.auctionId)
      const closing = auction.finish({
        finishedAt: this.clock.now(),
        leadingBid:
          leadingBid === null
            ? null
            : {
                auctionId: leadingBid.auctionId,
                bidId: leadingBid.id,
                bidderId: leadingBid.bidderId,
                amountCredits: leadingBid.amountCredits,
              },
      })
      await this.auctions.finishAuction({
        auctionId: input.auctionId,
        finishedAt: closing.finishedAt,
        closingResult: closing,
      })
    }

    const closed = await this.auctions.findAuctionAggregate(input.auctionId)
    if (closed?.closingResult === null || closed === null)
      throw new Error('El cierre durable no existe.')
    if (closed.closingResult.outcome === AuctionClosingOutcome.WithWinner)
      return this.settleWithWinner(input.auctionId, closed)
    const existing = await this.settlements.getByAuctionId(input.auctionId)
    if (existing?.status === AuctionSettlementStatus.Completed) return existing
    const settlement = await this.settlements.createIfAbsent({
      auctionId: input.auctionId,
      resultType: 'WITHOUT_BIDS',
      sellerId: closed.sellerId.value,
      createdAt: this.clock.now(),
    })
    if (settlement.status !== AuctionSettlementStatus.Completed)
      await this.settlements.markCompleted(input.auctionId, this.clock.now())
    const completed = await this.settlements.getByAuctionId(input.auctionId)
    if (completed === null) throw new Error('El settlement durable no existe.')
    return completed
  }

  private async settleWithWinner(
    auctionId: string,
    auction: NonNullable<Awaited<ReturnType<AuctionRepositoryPort['findAuctionAggregate']>>>,
  ): Promise<AuctionSettlementSnapshot> {
    const existing = await this.settlements.getByAuctionId(auctionId)
    if (existing?.status === AuctionSettlementStatus.Completed) return existing
    const closing = auction.closingResult
    if (
      closing?.winningBidId === null ||
      closing?.winnerId === null ||
      closing?.finalAmountCredits === null ||
      closing === null
    ) {
      throw new Error('El cierre WITH_WINNER durable es invalido.')
    }

    const winningBid = await this.auctions.findLeadingBid(auctionId)
    if (winningBid?.id !== closing.winningBidId) {
      throw new Error('La puja ganadora durable no coincide con el cierre de la subasta.')
    }
    if (winningBid.creditReservationId == null) {
      throw new Error('La puja ganadora no tiene una reserva de creditos.')
    }

    const operationId = `auction:${auctionId}:settlement:capture`
    const settlement = await this.settlements.createIfAbsent({
      auctionId,
      resultType: 'WITH_WINNER',
      winningBidId: closing.winningBidId,
      winnerId: closing.winnerId,
      winningHoldId: winningBid.creditReservationId,
      sellerId: auction.sellerId.value,
      finalAmountCredits: closing.finalAmountCredits,
      captureOperationId: operationId,
      createdAt: this.clock.now(),
    })
    if (settlement.captureStatus === CaptureStatus.TerminalError) {
      return settlement
    }
    if (settlement.captureStatus === CaptureStatus.Confirmed)
      return this.prepareLoserReleases(
        auctionId,
        closing,
        settlement.status === AuctionSettlementStatus.LoserReleasesPending,
      )
    if (![CaptureStatus.Pending, CaptureStatus.Retryable].includes(settlement.captureStatus)) {
      throw new Error(`El settlement no admite captura en estado ${settlement.captureStatus}.`)
    }

    const capture = await this.wallet.captureHold({
      holdId: winningBid.creditReservationId,
      operationId,
      beneficiaryPlayerId: auction.sellerId.value,
      auctionId,
      winningBidId: closing.winningBidId,
    })
    if (capture.outcome === 'SUCCESS') {
      await this.settlements.markCaptureConfirmed(auctionId, this.clock.now())
    } else if (capture.outcome === 'RETRYABLE' || capture.outcome === 'INVALID_RESPONSE') {
      await this.settlements.markCaptureRetryable(
        auctionId,
        `La captura Wallet requiere reintento: ${capture.outcome}.`,
        this.clock.now(),
      )
    } else {
      await this.settlements.markCaptureTerminal(
        auctionId,
        `La captura Wallet fallo terminalmente: ${capture.outcome}.`,
        this.clock.now(),
      )
    }

    const persisted = await this.settlements.getByAuctionId(auctionId)
    if (persisted === null) throw new Error('El settlement durable no existe.')
    return persisted.captureStatus === CaptureStatus.Confirmed
      ? this.prepareLoserReleases(auctionId, closing, false)
      : persisted
  }

  private async prepareLoserReleases(
    auctionId: string,
    closing: AuctionClosingResultSnapshot,
    executeReleases: boolean,
  ): Promise<AuctionSettlementSnapshot> {
    const bids = await this.auctions.findBidHistory(auctionId)
    const actions = await this.classifyLoserCredits.execute(auctionId, bids, closing.winningBidId)
    if (actions.some((action) => action.classification === 'INCONSISTENT')) {
      await this.settlements.markLoserReleasesTerminal(
        auctionId,
        'No se pueden preparar releases: existe una puja perdedora inconsistente.',
        this.clock.now(),
      )
    } else {
      await this.prepareLoserReleaseTasks.execute(actions, this.clock.now())
      if (actions.some((action) => action.releaseOperationId !== null)) {
        await this.settlements.markLoserReleasesPending(auctionId, this.clock.now())
      }
      if (executeReleases) await this.executePendingReleases(auctionId)
    }
    const persisted = await this.settlements.getByAuctionId(auctionId)
    if (persisted === null) throw new Error('El settlement durable no existe.')
    return this.completeIfReady(auctionId, persisted)
  }

  private async completeIfReady(
    auctionId: string,
    settlement: AuctionSettlementSnapshot,
  ): Promise<AuctionSettlementSnapshot> {
    if (
      settlement.status === AuctionSettlementStatus.Completed ||
      settlement.status === AuctionSettlementStatus.FailedTerminal ||
      settlement.captureStatus !== CaptureStatus.Confirmed
    ) {
      return settlement
    }
    const releases = await this.settlements.listReleaseTasks(auctionId)
    if (releases.some((release) => release.status !== ReleaseStatus.Released)) return settlement
    await this.settlements.markCompleted(auctionId, this.clock.now())
    const completed = await this.settlements.getByAuctionId(auctionId)
    if (completed === null) throw new Error('El settlement durable no existe.')
    return completed
  }

  private async executePendingReleases(auctionId: string): Promise<void> {
    const tasks = await this.settlements.listPendingReleaseTasks(auctionId)
    for (const task of tasks) {
      const release = await this.wallet.releaseHold({
        holdId: task.holdId,
        operationId: task.operationId,
        reason: task.reason,
      })
      if (release.outcome === 'SUCCESS') {
        await this.settlements.markReleaseConfirmed(auctionId, task.bidId, this.clock.now())
      } else if (release.outcome === 'RETRYABLE' || release.outcome === 'INVALID_RESPONSE') {
        await this.settlements.markReleaseRetryable(
          auctionId,
          task.bidId,
          `El release Wallet requiere reintento: ${release.outcome}.`,
          this.clock.now(),
        )
      } else {
        await this.settlements.markReleaseTerminal(
          auctionId,
          task.bidId,
          `El release Wallet fallo terminalmente: ${release.outcome}.`,
          this.clock.now(),
        )
      }
    }
  }
}
