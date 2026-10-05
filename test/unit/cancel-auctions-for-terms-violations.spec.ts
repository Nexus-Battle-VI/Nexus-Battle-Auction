import { InMemoryAuctionCancellationRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionCancellationRepository'
import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { UnavailableSellerSanctions } from '../../src/adapters/outbound/http/UnavailableAuctionDependencies'
import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import type {
  ActiveSanction,
  ActiveSanctionStatus,
  SellerActiveSanctionsPort,
} from '../../src/application/ports/SellerSanctionPort'
import {
  AUCTION_TERMS_VIOLATION_REASON_CODE,
  findAuctionTermsViolation,
} from '../../src/application/ports/SellerSanctionPort'
import {
  AutomaticCancellationOutcome,
  type CancelAuctionAutomatically,
  type CancelAuctionAutomaticallyCommand,
} from '../../src/application/use-cases/CancelAuctionAutomatically'
import {
  CancelAuctionsForTermsViolations,
  type CancelAuctionsForTermsViolationsLogger,
} from '../../src/application/use-cases/CancelAuctionsForTermsViolations'
import { Auction } from '../../src/domain/entities/Auction'

const publishedAt = new Date('2026-09-21T12:00:00.000Z')

const sanction = (overrides: Partial<ActiveSanction> = {}): ActiveSanction => ({
  id: 'sanction-1',
  type: 'TEMPORARY_SUSPENSION',
  reasonCode: AUCTION_TERMS_VIOLATION_REASON_CODE,
  expiresAt: new Date('2026-10-21T12:00:00.000Z'),
  ...overrides,
})

const noSanctions: ActiveSanctionStatus = { hasActiveSanctions: false, sanctions: [] }

class StubSanctions implements SellerActiveSanctionsPort {
  readonly calls: string[] = []
  readonly bySeller = new Map<string, ActiveSanctionStatus | Error>()

  getActiveSanctions(subject: string): Promise<ActiveSanctionStatus> {
    this.calls.push(subject)
    const answer = this.bySeller.get(subject) ?? noSanctions
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
}

const logger = (): jest.Mocked<CancelAuctionsForTermsViolationsLogger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
})

const publish = async (
  auctions: InMemoryAuctionRepository,
  auctionId: string,
  sellerId: string,
): Promise<void> => {
  await auctions.publish({
    operationId: `publish:${auctionId}`,
    auction: Auction.publish({
      auctionId,
      sellerId,
      productId: `product:${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      buyNowCredits: null,
      publishedAt,
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    }),
    inventoryCommitmentId: `commitment:${auctionId}`,
    feeChargeId: `charge:${auctionId}`,
  })
}

const setup = (batchSize = 50) => {
  const auctions = new InMemoryAuctionRepository(new InMemoryAuctionCancellationRepository())
  const sanctions = new StubSanctions()
  const log = logger()
  const execute: jest.MockedFunction<CancelAuctionAutomatically['execute']> = jest
    .fn()
    .mockImplementation((command: CancelAuctionAutomaticallyCommand) => {
      void command
      return Promise.resolve({
        outcome: AutomaticCancellationOutcome.Cancelled,
        cancellation: null,
      })
    })
  const worker = new CancelAuctionsForTermsViolations(auctions, sanctions, { execute }, log, {
    batchSize,
  })
  return { auctions, sanctions, log, execute, worker }
}

describe('findAuctionTermsViolation (HU-90, CA-05)', () => {
  it('no dispara con una sancion OTHER', () => {
    expect(
      findAuctionTermsViolation({
        hasActiveSanctions: true,
        sanctions: [sanction({ reasonCode: 'OTHER' })],
      }),
    ).toBeNull()
  })

  it('no dispara con hasActiveSanctions=true y sanctions vacio (BANNED legado)', () => {
    expect(findAuctionTermsViolation({ hasActiveSanctions: true, sanctions: [] })).toBeNull()
  })

  it('dispara con AUCTION_TERMS_VIOLATION, sea suspension o veto', () => {
    const ban = sanction({ id: 'ban-1', type: 'PERMANENT_BAN', expiresAt: null })

    expect(
      findAuctionTermsViolation({ hasActiveSanctions: true, sanctions: [sanction()] })?.id,
    ).toBe('sanction-1')
    expect(findAuctionTermsViolation({ hasActiveSanctions: true, sanctions: [ban] })).toBe(ban)
  })

  it('con varias sanciones usa la primera AUCTION_TERMS_VIOLATION en el orden de Account', () => {
    expect(
      findAuctionTermsViolation({
        hasActiveSanctions: true,
        sanctions: [
          sanction({ id: 'other-newest', reasonCode: 'OTHER' }),
          sanction({ id: 'violation-newer' }),
          sanction({ id: 'violation-older' }),
        ],
      })?.id,
    ).toBe('violation-newer')
  })
})

describe('CancelAuctionsForTermsViolations (HU-90, CA-05)', () => {
  it('sin subastas activas no consulta Account ni registra nada', async () => {
    const { worker, sanctions, log } = setup()

    await expect(worker.runBatch()).resolves.toEqual({
      processedSellers: 0,
      triggeredSellers: 0,
      cancelledAuctions: 0,
      failed: 0,
    })
    expect(sanctions.calls).toEqual([])
    expect(log.info).not.toHaveBeenCalled()
  })

  it('consulta Account una vez por vendedor, no por subasta', async () => {
    const { worker, auctions, sanctions } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    await publish(auctions, 'a-2', 'seller-a')
    await publish(auctions, 'b-1', 'seller-b')

    await worker.runBatch()

    expect(sanctions.calls).toEqual(['seller-a', 'seller-b'])
  })

  it('cancela TODAS las subastas activas del vendedor con AUCTION_TERMS_VIOLATION', async () => {
    const { worker, auctions, sanctions, execute } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    await publish(auctions, 'a-2', 'seller-a')
    await publish(auctions, 'b-1', 'seller-b')
    sanctions.bySeller.set('seller-a', { hasActiveSanctions: true, sanctions: [sanction()] })

    const result = await worker.runBatch()

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { auctionId: 'a-1', sanctionId: 'sanction-1' },
      { auctionId: 'a-2', sanctionId: 'sanction-1' },
    ])
    expect(result).toEqual({
      processedSellers: 2,
      triggeredSellers: 1,
      cancelledAuctions: 2,
      failed: 0,
    })
  })

  it.each([
    ['sancion OTHER', { hasActiveSanctions: true, sanctions: [sanction({ reasonCode: 'OTHER' })] }],
    ['BANNED legado sin sanciones', { hasActiveSanctions: true, sanctions: [] }],
    ['sin sanciones', noSanctions],
  ] as const)('no cancela con %s', async (_label, status) => {
    const { worker, auctions, sanctions, execute } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    sanctions.bySeller.set('seller-a', status)

    const result = await worker.runBatch()

    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ processedSellers: 1, triggeredSellers: 0, cancelledAuctions: 0 })
  })

  it('con varias sanciones genera una sola cancelacion por subasta, con un disparador estable', async () => {
    const { worker, auctions, sanctions, execute } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    sanctions.bySeller.set('seller-a', {
      hasActiveSanctions: true,
      sanctions: [sanction({ id: 'violation-2' }), sanction({ id: 'violation-1' })],
    })

    await worker.runBatch()

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { auctionId: 'a-1', sanctionId: 'violation-2' },
    ])
  })

  it.each([
    [
      'Account no disponible / timeout / 5xx / 401',
      new ExternalDependencyUnavailableError('account'),
    ],
    ['Account no reconoce al vendedor (404)', new ExternalResourceNotFoundError('account', 'x')],
    ['un fallo inesperado', new Error('boom')],
  ] as const)('falla cerrado y NO cancela si %s', async (_label, error) => {
    const { worker, auctions, sanctions, execute, log } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    await publish(auctions, 'b-1', 'seller-b')
    sanctions.bySeller.set('seller-a', error)
    sanctions.bySeller.set('seller-b', { hasActiveSanctions: true, sanctions: [sanction()] })

    const result = await worker.runBatch()

    // El fallo de seller-a no detiene a seller-b.
    expect(execute.mock.calls.map(([command]) => command.auctionId)).toEqual(['b-1'])
    expect(result).toEqual({
      processedSellers: 2,
      triggeredSellers: 1,
      cancelledAuctions: 1,
      failed: 1,
    })
    expect(log.warn).toHaveBeenCalledWith('auction_terms_violation_seller_check_failed', {
      reason: error.name,
    })
  })

  it('sin Account configurado (cliente no disponible) no cancela nada', async () => {
    const auctions = new InMemoryAuctionRepository(new InMemoryAuctionCancellationRepository())
    await publish(auctions, 'a-1', 'seller-a')
    const execute = jest.fn()
    const worker = new CancelAuctionsForTermsViolations(
      auctions,
      new UnavailableSellerSanctions(),
      { execute },
      logger(),
      { batchSize: 50 },
    )

    await expect(worker.runBatch()).resolves.toMatchObject({ failed: 1, cancelledAuctions: 0 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('si listar las subastas del vendedor falla, lo cuenta y sigue', async () => {
    const { worker, auctions, sanctions, execute } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    sanctions.bySeller.set('seller-a', { hasActiveSanctions: true, sanctions: [sanction()] })
    jest.spyOn(auctions, 'listActiveAuctionIdsBySeller').mockRejectedValue(new Error('db caida'))

    await expect(worker.runBatch()).resolves.toMatchObject({ triggeredSellers: 0, failed: 1 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('el fallo de una subasta no impide cancelar las demas', async () => {
    const { worker, auctions, sanctions, execute, log } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    await publish(auctions, 'a-2', 'seller-a')
    await publish(auctions, 'a-3', 'seller-a')
    sanctions.bySeller.set('seller-a', { hasActiveSanctions: true, sanctions: [sanction()] })
    execute.mockRejectedValueOnce(new Error('wallet caido'))

    const result = await worker.runBatch()

    expect(execute).toHaveBeenCalledTimes(3)
    expect(result).toEqual({
      processedSellers: 1,
      triggeredSellers: 1,
      cancelledAuctions: 2,
      failed: 1,
    })
    expect(log.error).toHaveBeenCalledWith('auction_terms_violation_cancellation_failed', {
      auctionId: 'a-1',
      reason: 'Error',
    })
  })

  it('no cuenta como cancelada una subasta que ya no estaba activa o ya estaba cancelada', async () => {
    const { worker, auctions, sanctions, execute } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    await publish(auctions, 'a-2', 'seller-a')
    sanctions.bySeller.set('seller-a', { hasActiveSanctions: true, sanctions: [sanction()] })
    execute
      .mockResolvedValueOnce({
        outcome: AutomaticCancellationOutcome.NotActive,
        cancellation: null,
      })
      .mockResolvedValueOnce({
        outcome: AutomaticCancellationOutcome.AlreadyCancelled,
        cancellation: null,
      })

    await expect(worker.runBatch()).resolves.toMatchObject({
      triggeredSellers: 1,
      cancelledAuctions: 0,
      failed: 0,
    })
  })

  it('recorre todas las paginas de vendedores con el cursor', async () => {
    const { worker, auctions, sanctions } = setup(2)
    for (const seller of ['seller-a', 'seller-b', 'seller-c', 'seller-d', 'seller-e']) {
      await publish(auctions, `auction:${seller}`, seller)
    }
    const list = jest.spyOn(auctions, 'listActiveSellerIds')

    const result = await worker.runBatch()

    expect(sanctions.calls).toEqual(['seller-a', 'seller-b', 'seller-c', 'seller-d', 'seller-e'])
    expect(list.mock.calls.map(([input]) => input.afterSellerId)).toEqual([
      null,
      'seller-b',
      'seller-d',
    ])
    expect(result.processedSellers).toBe(5)
  })

  it('registra solo contadores del ciclo, sin ids de vendedor ni de sancion', async () => {
    const { worker, auctions, sanctions, log } = setup()
    await publish(auctions, 'a-1', 'seller-a')
    sanctions.bySeller.set('seller-a', { hasActiveSanctions: true, sanctions: [sanction()] })

    await worker.runBatch()

    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith('auction_terms_violation_cycle_completed', {
      processedSellers: 1,
      triggeredSellers: 1,
      cancelledAuctions: 1,
      failed: 0,
    })
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(logged).not.toContain('seller-a')
    expect(logged).not.toContain('sanction-1')
  })
})
