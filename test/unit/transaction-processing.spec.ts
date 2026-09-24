import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { PersistedAuctionNotFoundError } from '../../src/application/errors/AuctionPersistenceError'
import {
  AuctionAlreadyClosedError,
  BuyNowIdempotencyConflictError,
} from '../../src/application/errors/BuyNowTransactionError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import type {
  AuctionRepositoryPort,
  RecordBuyNowFailureCommand,
} from '../../src/application/ports/AuctionRepositoryPort'
import type {
  BuyNowCreditTransfer,
  BuyNowCreditTransferCommand,
  WalletPort,
} from '../../src/application/ports/WalletPort'
import {
  TransactionProcessingService,
  type ProcessBuyNowTransactionCommand,
} from '../../src/application/services/TransactionProcessingService'
import { Auction, AuctionStatus } from '../../src/domain/entities/Auction'
import type { BuyNowApproval } from '../../src/domain/services/BuyNowDomainService'

const PUBLISHED_AT = new Date('2026-09-20T12:00:00.000Z')
const NOW = new Date('2026-09-21T15:00:00.000Z')

class StatefulWallet implements WalletPort {
  readonly transfers = new Map<string, { transferId: string; amount: number; reversed: boolean }>()

  failure: Error | null = null
  reverseFailure: Error | null = null
  private sequence = 0

  getAvailableCredits(): Promise<number> {
    return Promise.resolve(5000)
  }

  transferBuyNowCredits(command: BuyNowCreditTransferCommand): Promise<BuyNowCreditTransfer> {
    if (this.failure !== null) {
      return Promise.reject(this.failure)
    }

    const previous = this.transfers.get(command.operationId)

    if (previous !== undefined) {
      return Promise.resolve({ transferId: previous.transferId })
    }

    const transferId = `transfer-${String(++this.sequence)}`

    this.transfers.set(command.operationId, {
      transferId,
      amount: command.amount,
      reversed: false,
    })

    return Promise.resolve({ transferId })
  }

  reverseBuyNowCredits(operationId: string, transferId: string): Promise<void> {
    if (this.reverseFailure !== null) {
      return Promise.reject(this.reverseFailure)
    }

    const transfer = this.transfers.get(operationId)

    if (transfer?.transferId === transferId) {
      transfer.reversed = true
    }

    return Promise.resolve()
  }
}

const seedActiveAuction = async (
  repository: AuctionRepositoryPort,
  overrides: { auctionId?: string; sellerId?: string; buyNowCredits?: number } = {},
): Promise<string> => {
  const auctionId = overrides.auctionId ?? 'auction-64-1'

  const auction = Auction.publish({
    auctionId,
    sellerId: overrides.sellerId ?? 'seller-1',
    productId: 'product-1',
    durationHours: 24,
    minimumBidCredits: 10,
    buyNowCredits: overrides.buyNowCredits ?? 2500,
    publishedAt: PUBLISHED_AT,
    eligibility: {
      productOwnedBySeller: true,
      productInUse: false,
      productTradable: true,
      sellerHasActiveSanctions: false,
      activeAuctionCount: 0,
    },
  })

  await repository.publish({
    operationId: `publish-${auctionId}`,
    auction,
    inventoryCommitmentId: 'commitment-1',
    feeChargeId: 'fee-1',
  })

  return auctionId
}

const approvalFor = (
  auctionId: string,
  overrides: Partial<BuyNowApproval> = {},
): BuyNowApproval => ({
  auctionId,
  sellerId: 'seller-1',
  productId: 'product-1',
  buyerId: 'buyer-1',
  priceCredits: 2500,
  availableCredits: 5000,
  remainingCredits: 2500,
  requestedAt: NOW,
  ...overrides,
})

const fixture = () => {
  const repository = new InMemoryAuctionRepository()
  const wallet = new StatefulWallet()
  const clock = { now: () => new Date(NOW) }
  let sequence = 0
  const identifiers = { generate: () => `txn-${String(++sequence)}` }
  const service = new TransactionProcessingService(repository, wallet, clock, identifiers)

  return { repository, wallet, clock, identifiers, service }
}

const command = (
  auctionId: string,
  overrides: Partial<ProcessBuyNowTransactionCommand> = {},
): ProcessBuyNowTransactionCommand => ({
  operationId: 'operation-1',
  approval: approvalFor(auctionId),
  ...overrides,
})

describe('TransactionProcessingService HU-64.3', () => {
  it('CA-01: transfiere los creditos, cierra la subasta y confirma la transaccion', async () => {
    const { repository, wallet, service } = fixture()
    const auctionId = await seedActiveAuction(repository)

    const confirmation = await service.execute(command(auctionId))

    expect(confirmation).toEqual({
      transactionId: 'txn-1',
      auctionId,
      buyerId: 'buyer-1',
      sellerId: 'seller-1',
      productId: 'product-1',
      debitedCredits: 2500,
      remainingCredits: 2500,
      closedAt: NOW,
      replayed: false,
    })

    const closed = await repository.findById(auctionId)

    expect(closed?.status).toBe(AuctionStatus.SoldByBuyNow)
    expect(closed?.closesAt).toEqual(NOW)
    expect(wallet.transfers.get('operation-1')).toMatchObject({ amount: 2500, reversed: false })
  })

  it('es idempotente: reintentar el mismo operationId devuelve la misma confirmacion', async () => {
    const { repository, wallet, service } = fixture()
    const auctionId = await seedActiveAuction(repository)

    const first = await service.execute(command(auctionId))
    const second = await service.execute(command(auctionId))

    expect(second).toEqual({ ...first, replayed: true })
    expect(wallet.transfers.size).toBe(1)
  })

  it('rechaza una subasta que ya fue vendida por otra operacion', async () => {
    const { repository, service } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await service.execute(command(auctionId))

    await expect(
      service.execute(
        command(auctionId, { operationId: 'operation-2', approval: approvalFor(auctionId) }),
      ),
    ).rejects.toBeInstanceOf(AuctionAlreadyClosedError)
  })

  it('revierte la transferencia y audita el fallo si la subasta ya no existe', async () => {
    const { repository, wallet, service } = fixture()

    await expect(service.execute(command('auction-inexistente'))).rejects.toBeInstanceOf(
      PersistedAuctionNotFoundError,
    )

    const transfer = wallet.transfers.get('operation-1')

    expect(transfer?.reversed).toBe(true)

    const failures = (
      repository as unknown as { buyNowFailures: Map<string, RecordBuyNowFailureCommand> }
    ).buyNowFailures

    expect(failures.get('operation-1')).toMatchObject({
      stage: 'CLOSING_AUCTION',
      creditsReversed: true,
    })
  })

  it('si registrar la auditoria del fallo tambien falla, propaga el error ORIGINAL, no el de auditoria', async () => {
    const { repository, service } = fixture()

    repository.recordBuyNowFailure = () =>
      Promise.reject(new Error('tambien fallo escribir la auditoria'))

    await expect(service.execute(command('auction-inexistente'))).rejects.toBeInstanceOf(
      PersistedAuctionNotFoundError,
    )
  })

  it('registra el fallo sin creditos revertidos si Wallet nunca transfirio', async () => {
    const { repository, wallet, service } = fixture()

    wallet.failure = new ExternalDependencyUnavailableError('wallet')

    await expect(service.execute(command('auction-64-1'))).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )

    const failures = (
      repository as unknown as { buyNowFailures: Map<string, RecordBuyNowFailureCommand> }
    ).buyNowFailures

    expect(failures.get('operation-1')).toMatchObject({
      stage: 'TRANSFERRING_CREDITS',
      transferId: null,
      creditsReversed: true,
    })
  })

  it('si la reversion tambien falla, lo audita como no revertido y no oculta el error original', async () => {
    const { repository, wallet, service } = fixture()

    wallet.reverseFailure = new Error('wallet caido')

    await expect(service.execute(command('auction-inexistente'))).rejects.toBeInstanceOf(
      PersistedAuctionNotFoundError,
    )

    const failures = (
      repository as unknown as { buyNowFailures: Map<string, RecordBuyNowFailureCommand> }
    ).buyNowFailures

    expect(failures.get('operation-1')).toMatchObject({ creditsReversed: false })
  })

  it('dos operaciones distintas sobre la misma subasta con datos distintos no reutilizan el cierre', async () => {
    const { repository, service } = fixture()
    const auctionId = await seedActiveAuction(repository)

    await service.execute(
      command(auctionId, {
        operationId: 'operation-1',
        approval: approvalFor(auctionId, { priceCredits: 2500 }),
      }),
    )

    await expect(
      repository.closeByBuyNow({
        operationId: 'operation-1',
        transactionId: 'otra-transaccion',
        auctionId,
        buyerId: 'buyer-1',
        transferId: 'transfer-x',
        priceCredits: 999,
        remainingCredits: 0,
        closedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(BuyNowIdempotencyConflictError)
  })
})
