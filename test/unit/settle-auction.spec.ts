import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InMemoryAuctionSettlementRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionSettlementRepository'
import { InMemoryBidCreditOperationReader } from '../../src/adapters/outbound/persistence/InMemoryBidCreditOperationReader'
import { Auction } from '../../src/domain/entities/Auction'
import { Bid } from '../../src/domain/entities/Bid'
import { SettleAuction } from '../../src/application/use-cases/SettleAuction'
import { ClassifyAuctionLoserCredits } from '../../src/application/use-cases/ClassifyAuctionLoserCredits'
import { PrepareAuctionLoserReleaseTasks } from '../../src/application/use-cases/PrepareAuctionLoserReleaseTasks'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { BidCreditOperationSnapshot } from '../../src/application/ports/AuctionRepositoryPort'
import type {
  AuctionWalletPort,
  CaptureAuctionHoldCommand,
  ReleaseAuctionHoldCommand,
  WalletHoldOutcome,
  WalletHoldResult,
} from '../../src/application/ports/AuctionWalletPort'

const now = new Date('2026-09-23T12:00:00.000Z')
const clock: ClockPort = { now: () => new Date(now) }

const publish = async (repository: InMemoryAuctionRepository, auctionId: string): Promise<void> => {
  await repository.publish({
    operationId: `publish-${auctionId}`,
    auction: Auction.publish({
      auctionId,
      sellerId: 'seller-1',
      productId: `product-${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      publishedAt: new Date('2026-09-21T12:00:00.000Z'),
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    }),
    inventoryCommitmentId: `commitment-${auctionId}`,
    feeChargeId: `charge-${auctionId}`,
  })
}

class FakeAuctionWallet implements AuctionWalletPort {
  private captureIndex = 0
  private releaseIndex = 0

  readonly captureHold = jest.fn(
    (command: CaptureAuctionHoldCommand): Promise<WalletHoldResult> => {
      const outcome = this.outcomes[Math.min(this.captureIndex, this.outcomes.length - 1)]
      this.captureIndex += 1
      if (outcome === undefined) throw new Error('Fake Wallet sin respuesta configurada.')
      return Promise.resolve({
        outcome,
        operationId: command.operationId,
        holdId: command.holdId,
        ...(outcome === 'SUCCESS'
          ? {
              holdStatus: 'CAPTURED',
              beneficiaryPlayerId: command.beneficiaryPlayerId,
              applied: this.applied,
            }
          : {}),
      })
    },
  )

  readonly releaseHold = jest.fn(
    (command: ReleaseAuctionHoldCommand): Promise<WalletHoldResult> => {
      const outcome =
        this.releaseOutcomes[Math.min(this.releaseIndex, this.releaseOutcomes.length - 1)]
      this.releaseIndex += 1
      if (outcome === undefined) throw new Error('Fake Wallet sin respuesta release configurada.')
      return Promise.resolve({
        outcome,
        operationId: command.operationId,
        holdId: command.holdId,
        ...(outcome === 'SUCCESS' ? { holdStatus: 'RELEASED', applied: this.applied } : {}),
      })
    },
  )

  constructor(
    private readonly outcomes: readonly WalletHoldOutcome[] = ['SUCCESS'],
    private readonly applied = true,
    private readonly releaseOutcomes: readonly WalletHoldOutcome[] = ['SUCCESS'],
  ) {}
}

const persistLeadingBid = async (
  repository: InMemoryAuctionRepository,
  auctionId: string,
  creditReservationId: string | null,
): Promise<void> => {
  await persistBid(repository, {
    auctionId,
    bidId: `bid-${auctionId}`,
    bidderId: 'winner-1',
    amountCredits: 30,
    creditReservationId,
  })
}

const persistBid = async (
  repository: InMemoryAuctionRepository,
  input: {
    auctionId: string
    bidId: string
    bidderId: string
    amountCredits: number
    creditReservationId: string | null
  },
): Promise<void> => {
  const bid = Bid.register({
    bidId: input.bidId,
    auctionId: input.auctionId,
    bidderId: input.bidderId,
    amountCredits: input.amountCredits,
    placedAt: new Date('2026-09-22T12:00:00.000Z'),
    eligibility: {
      auctionStatus: 'ACTIVE',
      sellerId: 'seller-1',
      currentBidCredits: null,
      minimumIncrementCredits: 1,
      lastBidAtByBidder: null,
      activeBidCount: 0,
    },
  })
  await repository.persistBid(bid, input.creditReservationId)
}

const creditOperation = (
  auctionId: string,
  status: 'COMPLETED' | 'COMPENSATED' | 'COMPENSATION_PENDING',
  holdId: string,
): BidCreditOperationSnapshot => ({
  operationId: 'hu63-operation:release-previous',
  bidId: 'new-bid',
  auctionId,
  bidderId: 'new-bidder',
  amountCredits: 30,
  status,
  reservationId: 'new-hold',
  previousReservationId: holdId,
  createdAt: now,
  updatedAt: now,
})

describe('SettleAuction', () => {
  const setup = (
    wallet = new FakeAuctionWallet(),
    operations: readonly BidCreditOperationSnapshot[] = [],
  ) => {
    const auctions = new InMemoryAuctionRepository()
    const settlements = new InMemoryAuctionSettlementRepository()
    const classifyLoserCredits = new ClassifyAuctionLoserCredits(
      new InMemoryBidCreditOperationReader(operations),
    )
    const prepareLoserReleaseTasks = new PrepareAuctionLoserReleaseTasks(settlements)
    return {
      auctions,
      settlements,
      wallet,
      useCase: new SettleAuction(
        auctions,
        settlements,
        clock,
        wallet,
        classifyLoserCredits,
        prepareLoserReleaseTasks,
      ),
    }
  }

  it('rechaza una auction inexistente', async () => {
    await expect(setup().useCase.execute({ auctionId: 'auction-missing' })).rejects.toThrow(
      'no existe',
    )
  })

  it('finaliza ACTIVE sin bids y completa el settlement WITHOUT_BIDS', async () => {
    const { auctions, settlements, useCase } = setup()
    await publish(auctions, 'auction-empty')

    await expect(useCase.execute({ auctionId: 'auction-empty' })).resolves.toMatchObject({
      status: 'COMPLETED',
      resultType: 'WITHOUT_BIDS',
      captureStatus: 'NOT_REQUIRED',
    })
    await expect(settlements.getByAuctionId('auction-empty')).resolves.toMatchObject({
      status: 'COMPLETED',
    })
  })

  it('persiste Auction FINISHED con cierre WITHOUT_BIDS y fecha del ClockPort', async () => {
    const { auctions, useCase } = setup()
    await publish(auctions, 'auction-finished')
    await useCase.execute({ auctionId: 'auction-finished' })

    await expect(auctions.findAuctionAggregate('auction-finished')).resolves.toMatchObject({
      status: 'FINISHED',
      finishedAt: now,
      closingResult: { outcome: 'WITHOUT_BIDS' },
    })
  })

  it('persiste los campos nulos requeridos para WITHOUT_BIDS', async () => {
    const { auctions, settlements, useCase } = setup()
    await publish(auctions, 'auction-nulls')
    await useCase.execute({ auctionId: 'auction-nulls' })

    await expect(settlements.getByAuctionId('auction-nulls')).resolves.toMatchObject({
      winningBidId: null,
      winnerId: null,
      winningHoldId: null,
      finalAmountCredits: null,
      captureOperationId: null,
      captureStatus: 'NOT_REQUIRED',
      status: 'COMPLETED',
    })
  })

  it('reproduce settlement COMPLETED sin cambiar el cierre WITHOUT_BIDS', async () => {
    const { auctions, useCase } = setup()
    await publish(auctions, 'auction-replay')

    await useCase.execute({ auctionId: 'auction-replay' })
    await expect(useCase.execute({ auctionId: 'auction-replay' })).resolves.toMatchObject({
      status: 'COMPLETED',
      resultType: 'WITHOUT_BIDS',
      captureStatus: 'NOT_REQUIRED',
    })
    await expect(auctions.findAuctionAggregate('auction-replay')).resolves.toMatchObject({
      status: 'FINISHED',
      finishedAt: now,
      closingResult: { outcome: 'WITHOUT_BIDS' },
    })
  })

  it('llama finishAuction una sola vez ante replay', async () => {
    const { auctions, useCase } = setup()
    await publish(auctions, 'auction-finish-once')
    const finishAuction = jest.spyOn(auctions, 'finishAuction')

    await useCase.execute({ auctionId: 'auction-finish-once' })
    await useCase.execute({ auctionId: 'auction-finish-once' })

    expect(finishAuction).toHaveBeenCalledTimes(1)
  })

  it('crea settlement para Auction ya FINISHED/WITHOUT_BIDS sin volver a cerrar', async () => {
    const { auctions, useCase } = setup()
    await publish(auctions, 'auction-already-finished')
    const auction = await auctions.findAuctionAggregate('auction-already-finished')
    if (auction === null) throw new Error('Auction expected.')
    const closing = auction.finish({ finishedAt: now, leadingBid: null })
    await auctions.finishAuction({
      auctionId: 'auction-already-finished',
      finishedAt: now,
      closingResult: closing,
    })
    const finishAuction = jest.spyOn(auctions, 'finishAuction')

    await expect(useCase.execute({ auctionId: 'auction-already-finished' })).resolves.toMatchObject(
      { status: 'COMPLETED', captureStatus: 'NOT_REQUIRED' },
    )
    expect(finishAuction).not.toHaveBeenCalled()
    await expect(auctions.findAuctionAggregate('auction-already-finished')).resolves.toMatchObject({
      status: 'FINISHED',
      finishedAt: now,
    })
  })

  it('no escribe al reproducir settlement ya COMPLETED', async () => {
    const { auctions, settlements, useCase } = setup()
    await publish(auctions, 'auction-settlement-completed')
    const auction = await auctions.findAuctionAggregate('auction-settlement-completed')
    if (auction === null) throw new Error('Auction expected.')
    const closing = auction.finish({ finishedAt: now, leadingBid: null })
    await auctions.finishAuction({
      auctionId: 'auction-settlement-completed',
      finishedAt: now,
      closingResult: closing,
    })
    await settlements.createIfAbsent({
      auctionId: 'auction-settlement-completed',
      resultType: 'WITHOUT_BIDS',
      sellerId: 'seller-1',
      createdAt: now,
    })
    await settlements.markCompleted('auction-settlement-completed', now)
    const before = await settlements.getByAuctionId('auction-settlement-completed')
    const finishAuction = jest.spyOn(auctions, 'finishAuction')
    const createIfAbsent = jest.spyOn(settlements, 'createIfAbsent')
    const markCompleted = jest.spyOn(settlements, 'markCompleted')

    await expect(useCase.execute({ auctionId: 'auction-settlement-completed' })).resolves.toEqual(
      before,
    )
    expect(finishAuction).not.toHaveBeenCalled()
    expect(createIfAbsent).not.toHaveBeenCalled()
    expect(markCompleted).not.toHaveBeenCalled()
    await expect(settlements.getByAuctionId('auction-settlement-completed')).resolves.toEqual(
      before,
    )
  })

  it('captura el hold ganador y confirma settlement WITH_WINNER', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true)
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-with-winner'
    const winningBidId = `bid-${auctionId}`
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-winner')
    const createIfAbsent = jest.spyOn(settlements, 'createIfAbsent')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      resultType: 'WITH_WINNER',
      winningBidId,
      winnerId: 'winner-1',
      winningHoldId: 'hold-winner',
      sellerId: 'seller-1',
      finalAmountCredits: 30,
      captureOperationId: `auction:${auctionId}:settlement:capture`,
      captureStatus: 'CONFIRMED',
    })
    await expect(auctions.findAuctionAggregate(auctionId)).resolves.toMatchObject({
      status: 'FINISHED',
      closingResult: {
        outcome: 'WITH_WINNER',
        winningBidId,
        winnerId: 'winner-1',
        finalAmountCredits: 30,
      },
    })
    expect(wallet.captureHold).toHaveBeenCalledTimes(1)
    expect(wallet.captureHold).toHaveBeenCalledWith({
      holdId: 'hold-winner',
      operationId: `auction:${auctionId}:settlement:capture`,
      beneficiaryPlayerId: 'seller-1',
      auctionId,
      winningBidId,
    })
    expect(createIfAbsent.mock.invocationCallOrder[0]).toBeLessThan(
      wallet.captureHold.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(wallet.captureHold.mock.calls[0]?.[0].beneficiaryPlayerId).not.toBe('winner-1')
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('confirma capture Wallet idempotente applied:false sin completar settlement', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], false)
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-capture-replay'
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-capture-replay')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      captureStatus: 'CONFIRMED',
      captureOperationId: `auction:${auctionId}:settlement:capture`,
    })
    expect(wallet.captureHold).toHaveBeenCalledTimes(1)
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('falla antes de Wallet cuando la puja ganadora no tiene hold', async () => {
    const wallet = new FakeAuctionWallet()
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-winner-without-hold'
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, null)

    await expect(useCase.execute({ auctionId })).rejects.toThrow('no tiene una reserva')
    expect(wallet.captureHold).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
    await expect(settlements.getByAuctionId(auctionId)).resolves.toBeNull()
  })

  it('persiste capture RETRYABLE sin completar ni liberar holds', async () => {
    const wallet = new FakeAuctionWallet(['RETRYABLE'])
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-capture-retryable'
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-retryable')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'FAILED_RETRYABLE',
      captureStatus: 'RETRYABLE',
      captureOperationId: `auction:${auctionId}:settlement:capture`,
      lastError: expect.any(String),
    })
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('reintenta capture con el mismo operationId y confirma el replay Wallet', async () => {
    const wallet = new FakeAuctionWallet(['RETRYABLE', 'SUCCESS'], false)
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-capture-retry'
    const operationId = `auction:${auctionId}:settlement:capture`
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-retry')

    await useCase.execute({ auctionId })
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      captureStatus: 'CONFIRMED',
      captureOperationId: operationId,
    })
    expect(wallet.captureHold).toHaveBeenCalledTimes(2)
    expect(wallet.captureHold.mock.calls.map(([command]) => command.operationId)).toEqual([
      operationId,
      operationId,
    ])
    expect(wallet.captureHold.mock.calls.map(([command]) => command.holdId)).toEqual([
      'hold-retry',
      'hold-retry',
    ])
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('no recaptura un settlement WITH_WINNER ya confirmado', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-capture-confirmed'
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-confirmed')
    await useCase.execute({ auctionId })
    wallet.captureHold.mockClear()

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      captureStatus: 'CONFIRMED',
    })
    expect(wallet.captureHold).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('persiste 404 Wallet como terminal y no lo reintenta', async () => {
    const wallet = new FakeAuctionWallet(['TERMINAL_NOT_FOUND'])
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-capture-not-found'
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-not-found')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      captureStatus: 'TERMINAL_ERROR',
      lastError: expect.stringContaining('TERMINAL_NOT_FOUND'),
    })
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      captureStatus: 'TERMINAL_ERROR',
    })
    expect(wallet.captureHold).toHaveBeenCalledTimes(1)
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it.each(['TERMINAL_CONFLICT', 'TERMINAL_RULE_ERROR'] as const)(
    'persiste %s Wallet como terminal',
    async (outcome) => {
      const wallet = new FakeAuctionWallet([outcome])
      const { auctions, useCase } = setup(wallet)
      const auctionId = `auction-capture-${outcome.toLowerCase()}`
      await publish(auctions, auctionId)
      await persistLeadingBid(auctions, auctionId, `hold-${outcome}`)

      await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
        status: 'FAILED_TERMINAL',
        captureStatus: 'TERMINAL_ERROR',
        lastError: expect.stringContaining(outcome),
      })
      expect(wallet.releaseHold).not.toHaveBeenCalled()
    },
  )

  it('trata INVALID_RESPONSE como retryable sin confirmar capture', async () => {
    const wallet = new FakeAuctionWallet(['INVALID_RESPONSE'])
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-capture-invalid-response'
    await publish(auctions, auctionId)
    await persistLeadingBid(auctions, auctionId, 'hold-invalid-response')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'FAILED_RETRYABLE',
      captureStatus: 'RETRYABLE',
      captureOperationId: `auction:${auctionId}:settlement:capture`,
      lastError: expect.stringContaining('INVALID_RESPONSE'),
    })
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('prepara release task para loser ACTIVE_HOLD sin llamar Wallet release', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-loser-active-hold'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: 'hold-loser-active',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-active')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'LOSER_RELEASES_PENDING',
      captureStatus: 'CONFIRMED',
    })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({
        bidId: loserBidId,
        holdId: 'hold-loser-active',
        operationId: `auction:${auctionId}:bid:${loserBidId}:release`,
        reason: 'AUCTION_SETTLEMENT_LOST',
      }),
    ])
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('reutiliza operationId HU-63 para loser COMPENSATION_PENDING', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const auctionId = 'auction-loser-compensation-pending'
    const { auctions, settlements, useCase } = setup(wallet, [
      creditOperation(auctionId, 'COMPENSATION_PENDING', 'hold-loser-pending'),
    ])
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: 'hold-loser-pending',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-pending')

    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({
        bidId: loserBidId,
        holdId: 'hold-loser-pending',
        operationId: 'hu63-operation:release-previous',
      }),
    ])
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('no prepara release para loser ALREADY_RELEASED', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const auctionId = 'auction-loser-already-released'
    const { auctions, settlements, useCase } = setup(wallet, [
      creditOperation(auctionId, 'COMPLETED', 'hold-loser-released'),
    ])
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-${auctionId}`,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: 'hold-loser-released',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-released')

    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([])
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('no prepara release para loser COMPENSATED', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const auctionId = 'auction-loser-compensated'
    const { auctions, settlements, useCase } = setup(wallet, [
      creditOperation(auctionId, 'COMPENSATED', 'hold-loser-compensated'),
    ])
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-${auctionId}`,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: 'hold-loser-compensated',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-compensated')

    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([])
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('bloquea settlement por loser INCONSISTENT sin inventar release task', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-loser-inconsistent'
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-${auctionId}`,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: null,
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-inconsistent')

    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
      captureStatus: 'CONFIRMED',
      lastError: expect.any(String),
    })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([])
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('excluye explícitamente el winning bid de las release tasks', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-winner-excluded'
    const winningBidId = `bid-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-${auctionId}`,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: 'hold-loser-excluded',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-excluded')

    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ bidId: `bid-loser-${auctionId}` }),
    ])
    await expect(settlements.listReleaseTasks(auctionId)).resolves.not.toContainEqual(
      expect.objectContaining({ bidId: winningBidId }),
    )
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('prepara releases idempotentemente tras capture confirmada', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-loser-replay'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser-1',
      amountCredits: 20,
      creditReservationId: 'hold-loser-replay',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-replay')

    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({
        bidId: loserBidId,
        holdId: 'hold-loser-replay',
        operationId: `auction:${auctionId}:bid:${loserBidId}:release`,
      }),
    ])
    expect(wallet.releaseHold).toHaveBeenCalledTimes(1)
  })

  it('ejecuta release SUCCESS applied:true', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-success'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-success',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-success')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({
        bidId: loserBidId,
        holdId: 'hold-release-success',
        operationId: `auction:${auctionId}:bid:${loserBidId}:release`,
        reason: 'AUCTION_SETTLEMENT_LOST',
        status: 'RELEASED',
      }),
    ])
    expect(wallet.releaseHold).toHaveBeenCalledTimes(1)
  })

  it('confirma release SUCCESS applied:false', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], false, ['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-replay-success'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-replay',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-replay')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ status: 'RELEASED' }),
    ])
  })

  it('persiste release RETRYABLE sin completar settlement', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['RETRYABLE'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-retryable'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-retryable',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-retryable')
    await useCase.execute({ auctionId })
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'LOSER_RELEASES_PENDING',
    })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ status: 'RETRYABLE', lastError: expect.any(String) }),
    ])
  })

  it('reintenta release con mismo hold y operationId', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], false, ['RETRYABLE', 'SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-retry'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-retry',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-retry')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    expect(wallet.releaseHold).toHaveBeenCalledTimes(2)
    expect(
      wallet.releaseHold.mock.calls.map(([command]) => [command.holdId, command.operationId]),
    ).toEqual([
      ['hold-release-retry', `auction:${auctionId}:bid:${loserBidId}:release`],
      ['hold-release-retry', `auction:${auctionId}:bid:${loserBidId}:release`],
    ])
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ status: 'RELEASED' }),
    ])
  })

  it('no reintenta release TERMINAL_NOT_FOUND', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['TERMINAL_NOT_FOUND'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-not-found'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-not-found',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-not-found')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    expect(wallet.releaseHold).toHaveBeenCalledTimes(1)
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ status: 'TERMINAL_ERROR' }),
    ])
  })

  it.each(['TERMINAL_CONFLICT', 'TERMINAL_RULE_ERROR'] as const)(
    'persiste release %s como terminal',
    async (outcome) => {
      const wallet = new FakeAuctionWallet(['SUCCESS'], true, [outcome])
      const { auctions, settlements, useCase } = setup(wallet)
      const auctionId = `auction-release-${outcome.toLowerCase()}`
      const loserBidId = `bid-loser-${auctionId}`
      await publish(auctions, auctionId)
      await persistBid(auctions, {
        auctionId,
        bidId: loserBidId,
        bidderId: 'loser',
        amountCredits: 20,
        creditReservationId: `hold-${outcome}`,
      })
      await persistLeadingBid(auctions, auctionId, `hold-winner-${outcome}`)
      await useCase.execute({ auctionId })
      await useCase.execute({ auctionId })
      await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
        expect.objectContaining({ status: 'TERMINAL_ERROR' }),
      ])
    },
  )

  it('trata INVALID_RESPONSE de release como retryable', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['INVALID_RESPONSE'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-invalid'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-invalid',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-invalid')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ status: 'RETRYABLE' }),
    ])
  })

  it('no re-releases una task ya RELEASED', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['SUCCESS'])
    const { auctions, useCase } = setup(wallet)
    const auctionId = 'auction-release-already-released'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-release-done',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-done')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    wallet.releaseHold.mockClear()
    await useCase.execute({ auctionId })
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('procesa multiples tasks independientes sin completar settlement', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['SUCCESS', 'RETRYABLE'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-release-multiple'
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-a-${auctionId}`,
      bidderId: 'loser-a',
      amountCredits: 15,
      creditReservationId: 'hold-release-a',
    })
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-b-${auctionId}`,
      bidderId: 'loser-b',
      amountCredits: 20,
      creditReservationId: 'hold-release-b',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-release-multiple')
    await useCase.execute({ auctionId })
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'LOSER_RELEASES_PENDING',
    })
    expect(wallet.releaseHold).toHaveBeenCalledTimes(2)
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'RELEASED' }),
        expect.objectContaining({ status: 'RETRYABLE' }),
      ]),
    )
  })

  it('completa WITH_WINNER cuando la release termina correctamente', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-completion-happy'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-completion',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-completion')
    await useCase.execute({ auctionId })
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'COMPLETED',
      captureStatus: 'CONFIRMED',
    })
    await expect(settlements.listReleaseTasks(auctionId)).resolves.toEqual([
      expect.objectContaining({ status: 'RELEASED' }),
    ])
  })

  it('completa sin release tasks para losers ya compensados', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const auctionId = 'auction-completion-no-tasks'
    const { auctions, useCase } = setup(wallet, [
      creditOperation(auctionId, 'COMPENSATED', 'hold-loser-no-task'),
    ])
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-${auctionId}`,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-loser-no-task',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-no-task')
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('no completa con release RETRYABLE', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['RETRYABLE'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-completion-retry'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-completion-retry',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-completion-retry')
    const markCompleted = jest.spyOn(settlements, 'markCompleted')
    await useCase.execute({ auctionId })
    await expect(useCase.execute({ auctionId })).resolves.not.toMatchObject({ status: 'COMPLETED' })
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it('no completa con release terminal', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['TERMINAL_NOT_FOUND'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-completion-terminal'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-completion-terminal',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-completion-terminal')
    const markCompleted = jest.spyOn(settlements, 'markCompleted')
    await useCase.execute({ auctionId })
    await expect(useCase.execute({ auctionId })).resolves.not.toMatchObject({ status: 'COMPLETED' })
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it('no realiza operaciones al reproducir settlement COMPLETED', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'], true, ['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-completion-replay'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-completion-replay',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-completion-replay')
    await useCase.execute({ auctionId })
    await useCase.execute({ auctionId })
    const finish = jest.spyOn(auctions, 'finishAuction')
    const complete = jest.spyOn(settlements, 'markCompleted')
    wallet.captureHold.mockClear()
    wallet.releaseHold.mockClear()
    await useCase.execute({ auctionId })
    expect(finish).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(wallet.captureHold).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('completa cuando la task ya estaba RELEASED', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-completion-released'
    const loserBidId = `bid-loser-${auctionId}`
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: loserBidId,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: 'hold-completion-released',
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-completion-released')
    await useCase.execute({ auctionId })
    await settlements.markReleaseConfirmed(auctionId, loserBidId, now)
    const complete = jest.spyOn(settlements, 'markCompleted')
    wallet.releaseHold.mockClear()
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })

  it('no completa una clasificación INCONSISTENT', async () => {
    const wallet = new FakeAuctionWallet(['SUCCESS'])
    const { auctions, settlements, useCase } = setup(wallet)
    const auctionId = 'auction-completion-inconsistent'
    await publish(auctions, auctionId)
    await persistBid(auctions, {
      auctionId,
      bidId: `bid-loser-${auctionId}`,
      bidderId: 'loser',
      amountCredits: 20,
      creditReservationId: null,
    })
    await persistLeadingBid(auctions, auctionId, 'hold-winner-completion-inconsistent')
    const complete = jest.spyOn(settlements, 'markCompleted')
    await expect(useCase.execute({ auctionId })).resolves.toMatchObject({
      status: 'FAILED_TERMINAL',
    })
    expect(complete).not.toHaveBeenCalled()
    expect(wallet.releaseHold).not.toHaveBeenCalled()
  })
})
