import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { PostgresAuctionRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionRepository'
import { PostgresAuctionCancellationRepository } from '../../src/adapters/outbound/persistence/PostgresAuctionCancellationRepository'
import { AuctionCancellationEffectStatus } from '../../src/application/ports/AuctionCancellationRepositoryPort'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { Auction } from '../../src/domain/entities/Auction'
import { CancelAuction } from '../../src/application/use-cases/CancelAuction'
import {
  AuctionCancellationReconciler,
  type AuctionCancellationReconcilerLogger,
} from '../../src/application/use-cases/AuctionCancellationReconciler'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import {
  ExternalDependencyUnavailableError,
  ExternalResourceNotFoundError,
} from '../../src/application/errors/ExternalDependencyError'
import {
  walletCancellationRefundOperationId,
  type ChargePublicationFeeCommand,
  type PublicationFeeCharge,
  type PublicationFeePort,
} from '../../src/application/ports/PublicationFeePort'
import {
  inventoryCancellationReleaseOperationId,
  type ClaimedInventoryProductCommitment,
  type InventoryProductCommitment,
  type InventoryProductEligibility,
  type PendingClaimInventoryProductCommitment,
  type ProductInventoryPort,
  type ReleasedInventoryProductCommitment,
  type ReleaseInventoryProductCommand,
} from '../../src/application/ports/ProductInventoryPort'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

class StubClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

type RefundBehavior = 'success' | 'unavailable'

class StubPublicationFeePort implements PublicationFeePort {
  readonly refundCalls: { operationId: string; chargeId: string; amount: number }[] = []
  behavior: RefundBehavior = 'success'

  charge(command: ChargePublicationFeeCommand): Promise<PublicationFeeCharge> {
    void command
    throw new Error('No usado en estos tests.')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refund(operationId: string, chargeId: string, amount: number): Promise<void> {
    this.refundCalls.push({ operationId, chargeId, amount })
    if (this.behavior === 'unavailable') throw new ExternalDependencyUnavailableError('wallet')
  }
}

type ReleaseBehavior = 'success' | 'unavailable' | 'not-found'

class StubProductInventoryPort implements ProductInventoryPort {
  readonly releaseCalls: ReleaseInventoryProductCommand[] = []
  behavior: ReleaseBehavior = 'success'

  inspect(): Promise<InventoryProductEligibility> {
    throw new Error('No usado en estos tests.')
  }

  commit(): Promise<InventoryProductCommitment> {
    throw new Error('No usado en estos tests.')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async release(
    command: ReleaseInventoryProductCommand,
  ): Promise<ReleasedInventoryProductCommitment> {
    this.releaseCalls.push(command)
    if (this.behavior === 'unavailable')
      throw new ExternalDependencyUnavailableError('player-inventory')
    if (this.behavior === 'not-found')
      throw new ExternalResourceNotFoundError('player-inventory', command.commitmentId)
    return {
      operationId: command.operationId,
      commitmentId: command.commitmentId,
      status: 'RELEASED',
      applied: true,
    }
  }

  markPendingClaim(): Promise<PendingClaimInventoryProductCommitment> {
    throw new Error('No usado en estos tests.')
  }

  confirmClaim(): Promise<ClaimedInventoryProductCommitment> {
    throw new Error('No usado en estos tests.')
  }
}

const silentLogger: AuctionCancellationReconcilerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * HU-90 (PR3), `7.7.10` + deuda de reconciliacion durable. Prueba el camino
 * que NO cubre `test/unit/cancel-auction.spec.ts`: el reclamo
 * `FOR UPDATE SKIP LOCKED` con lease real contra PostgreSQL, y que el
 * reconciler puede completar Wallet/Inventory para una cancelacion cuyo
 * commit local ya ocurrio pero cuyos efectos nunca se intentaron (el
 * escenario de "el proceso murio justo despues del commit").
 */
describe('AuctionCancellationReconciler contra PostgreSQL real (HU-90)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let auctions: PostgresAuctionRepository
  let cancellations: PostgresAuctionCancellationRepository

  const now = new Date('2026-09-21T15:00:00.000Z')

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri(), maxConnections: 20 })
    const outcome = await migrateToLatest(db)
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error !== undefined) throw new Error('La migracion fallo.')
    auctions = new PostgresAuctionRepository(db)
    cancellations = new PostgresAuctionCancellationRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  /**
   * Deja una cancelacion "committed-local-only": exactamente el estado en el
   * que queda una cancelacion real si el proceso muere entre el commit de la
   * transaccion de `cancelAuction()` y la primera llamada a Wallet/Inventory
   * -sin pasar nunca por `CancelAuction.execute()`-.
   */
  const seedCommittedCancellation = async (auctionId: string): Promise<void> => {
    const auction = Auction.publish({
      auctionId,
      sellerId: 'seller-1',
      productId: `product:${auctionId}`,
      durationHours: 24,
      minimumBidCredits: 10,
      publishedAt: now,
      eligibility: {
        productOwnedBySeller: true,
        productInUse: false,
        productTradable: true,
        sellerHasActiveSanctions: false,
        activeAuctionCount: 0,
      },
    })
    await auctions.publish({
      operationId: `publish:${auctionId}`,
      auction,
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
    })
    await auctions.cancelAuction({
      operationId: `cancel:${auctionId}`,
      auctionId,
      sellerId: 'seller-1',
      productId: `product:${auctionId}`,
      cancelledAt: now,
      inventoryCommitmentId: `commitment:${auctionId}`,
      feeChargeId: `charge:${auctionId}`,
      refundAmountCredits: 0.5,
      walletRefundOperationId: walletCancellationRefundOperationId(auctionId),
      inventoryReleaseOperationId: inventoryCancellationReleaseOperationId(auctionId),
    })
  }

  const buildReconciler = (
    fees: StubPublicationFeePort,
    inventory: StubProductInventoryPort,
    workerId: string,
    leaseMs = 60_000,
    batchSize = 50,
  ) => {
    const clock = new StubClock(now)
    const cancelAuction = new CancelAuction(auctions, cancellations, fees, inventory, clock)
    return new AuctionCancellationReconciler(cancellations, cancelAuction, clock, silentLogger, {
      batchSize,
      leaseMs,
      workerId,
    })
  }

  // 1. ambos efectos CONFIRMED -> nunca se reclama de nuevo.
  it('no reclama una cancelacion con Wallet e Inventory ya CONFIRMED', async () => {
    const auctionId = 'reconciler-both-confirmed-1'
    await seedCommittedCancellation(auctionId)
    const fees = new StubPublicationFeePort()
    const inventory = new StubProductInventoryPort()
    const reconciler = buildReconciler(fees, inventory, 'worker-a')
    await reconciler.runBatch()
    expect(fees.refundCalls).toHaveLength(1)
    expect(inventory.releaseCalls).toHaveLength(1)

    fees.refundCalls.length = 0
    inventory.releaseCalls.length = 0
    const second = await reconciler.runBatch()
    expect(second.claimed).toBe(0)
    expect(fees.refundCalls).toHaveLength(0)
    expect(inventory.releaseCalls).toHaveLength(0)
  })

  // 3. Wallet RETRYABLE se reintenta y pasa a CONFIRMED.
  it('reintenta un refund RETRYABLE hasta CONFIRMED', async () => {
    const auctionId = 'reconciler-wallet-retryable-1'
    await seedCommittedCancellation(auctionId)
    const fees = new StubPublicationFeePort()
    fees.behavior = 'unavailable'
    const inventory = new StubProductInventoryPort()
    const failing = buildReconciler(fees, inventory, 'worker-a')
    const first = await failing.runBatch()
    expect(first.retryable).toBe(1)
    const afterFirst = await cancellations.getByAuctionId(auctionId)
    expect(afterFirst?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Retryable)

    fees.behavior = 'success'
    const recovering = buildReconciler(fees, inventory, 'worker-a')
    const second = await recovering.runBatch()
    expect(second.confirmed).toBe(1)
    const afterSecond = await cancellations.getByAuctionId(auctionId)
    expect(afterSecond?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
  })

  // 4. Inventory RETRYABLE se reintenta y pasa a CONFIRMED.
  it('reintenta un release RETRYABLE hasta CONFIRMED', async () => {
    const auctionId = 'reconciler-inventory-retryable-1'
    await seedCommittedCancellation(auctionId)
    const fees = new StubPublicationFeePort()
    const inventory = new StubProductInventoryPort()
    inventory.behavior = 'unavailable'
    const failing = buildReconciler(fees, inventory, 'worker-a')
    const first = await failing.runBatch()
    expect(first.retryable).toBe(1)

    inventory.behavior = 'success'
    const recovering = buildReconciler(fees, inventory, 'worker-a')
    const second = await recovering.runBatch()
    expect(second.confirmed).toBe(1)
    const afterSecond = await cancellations.getByAuctionId(auctionId)
    expect(afterSecond?.inventoryReleaseStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
  })

  // 5. Wallet CONFIRMED + Inventory RETRYABLE -> solo ejecuta Inventory.
  it('no vuelve a llamar a Wallet si ya esta CONFIRMED, aunque Inventory siga RETRYABLE', async () => {
    const auctionId = 'reconciler-mixed-1'
    await seedCommittedCancellation(auctionId)
    const fees = new StubPublicationFeePort()
    const inventory = new StubProductInventoryPort()
    inventory.behavior = 'unavailable'
    const firstPass = buildReconciler(fees, inventory, 'worker-a')
    await firstPass.runBatch()
    expect(fees.refundCalls).toHaveLength(1)
    expect(inventory.releaseCalls).toHaveLength(1)
    const midway = await cancellations.getByAuctionId(auctionId)
    expect(midway?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
    expect(midway?.inventoryReleaseStatus).toBe(AuctionCancellationEffectStatus.Retryable)

    inventory.behavior = 'success'
    const secondPass = buildReconciler(fees, inventory, 'worker-a')
    await secondPass.runBatch()
    expect(fees.refundCalls).toHaveLength(1) // Wallet NO se vuelve a llamar.
    expect(inventory.releaseCalls).toHaveLength(2)
  })

  // 6. TERMINAL_ERROR nunca se reclama (resuelto antes: not-found -> terminal).
  it('no reclama un release en TERMINAL_ERROR', async () => {
    const auctionId = 'reconciler-terminal-1'
    await seedCommittedCancellation(auctionId)
    const fees = new StubPublicationFeePort()
    const inventory = new StubProductInventoryPort()
    inventory.behavior = 'not-found'
    const reconciler = buildReconciler(fees, inventory, 'worker-a')
    const first = await reconciler.runBatch()
    expect(first.terminal).toBe(1)
    const afterFirst = await cancellations.getByAuctionId(auctionId)
    expect(afterFirst?.inventoryReleaseStatus).toBe(AuctionCancellationEffectStatus.TerminalError)

    inventory.releaseCalls.length = 0
    const second = await reconciler.runBatch()
    expect(second.claimed).toBe(0)
    expect(inventory.releaseCalls).toHaveLength(0)
  })

  // 7/12 (parcial). mismo operationId en el reintento, nunca un UUID nuevo.
  it('reutiliza el mismo operationId de Wallet en el reintento del reconciler', async () => {
    const auctionId = 'reconciler-same-operation-id-1'
    await seedCommittedCancellation(auctionId)
    const fees = new StubPublicationFeePort()
    fees.behavior = 'unavailable'
    const inventory = new StubProductInventoryPort()
    await buildReconciler(fees, inventory, 'worker-a').runBatch()
    fees.behavior = 'success'
    await buildReconciler(fees, inventory, 'worker-a').runBatch()

    expect(fees.refundCalls.map((call) => call.operationId)).toEqual([
      `auction:${auctionId}:cancellation:wallet-refund`,
      `auction:${auctionId}:cancellation:wallet-refund`,
    ])
  })

  // 2/9. crash recovery real: el commit local YA ocurrio, Wallet/Inventory
  // nunca se intentaron (ningun CancelAuction.execute corrio), y el
  // reconciler es la UNICA via que los completa.
  it('completa Wallet e Inventory para una cancelacion committed-local-only, sin que el cliente repita la peticion', async () => {
    const auctionId = 'reconciler-crash-recovery-1'
    await seedCommittedCancellation(auctionId)
    const beforeRecovery = await cancellations.getByAuctionId(auctionId)
    expect(beforeRecovery?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Pending)
    expect(beforeRecovery?.inventoryReleaseStatus).toBe(AuctionCancellationEffectStatus.Pending)

    const fees = new StubPublicationFeePort()
    const inventory = new StubProductInventoryPort()
    const result = await buildReconciler(fees, inventory, 'worker-a').runBatch()

    expect(result.confirmed).toBe(1)
    expect(fees.refundCalls).toHaveLength(1)
    expect(inventory.releaseCalls).toHaveLength(1)
    const after = await cancellations.getByAuctionId(auctionId)
    expect(after?.walletRefundStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
    expect(after?.inventoryReleaseStatus).toBe(AuctionCancellationEffectStatus.Confirmed)
  })

  // 10. query solo retorna PENDING/RETRYABLE.
  it('claimPendingCancellations solo devuelve filas con PENDING/RETRYABLE', async () => {
    const pendingId = 'reconciler-claim-filter-pending-1'
    const confirmedId = 'reconciler-claim-filter-confirmed-1'
    await seedCommittedCancellation(pendingId)
    await seedCommittedCancellation(confirmedId)
    await cancellations.markWalletRefundConfirmed(confirmedId, now)
    await cancellations.markInventoryReleaseConfirmed(confirmedId, now)

    const claimed = await cancellations.claimPendingCancellations({
      now,
      workerId: 'worker-a',
      leaseUntil: new Date(now.getTime() + 60_000),
      limit: 50,
    })
    const claimedIds = claimed.map((cancellation) => cancellation.auctionId)
    expect(claimedIds).toContain(pendingId)
    expect(claimedIds).not.toContain(confirmedId)
  })

  // 11. limite/batch del worker.
  it('respeta el limite del batch', async () => {
    const ids = ['reconciler-batch-limit-1', 'reconciler-batch-limit-2', 'reconciler-batch-limit-3']
    for (const id of ids) await seedCommittedCancellation(id)

    const claimed = await cancellations.claimPendingCancellations({
      now,
      workerId: 'worker-a',
      leaseUntil: new Date(now.getTime() + 60_000),
      limit: 2,
    })
    expect(claimed).toHaveLength(2)
  })

  // Proteccion de lease: una segunda instancia no reclama lo que la primera
  // ya tiene en lease vigente, y SI puede reclamarlo una vez vencido.
  it('no reclama una fila con lease vigente de otro worker, y si una vez vencido', async () => {
    const auctionId = 'reconciler-lease-protection-1'
    await seedCommittedCancellation(auctionId)

    const firstClaim = await cancellations.claimPendingCancellations({
      now,
      workerId: 'worker-a',
      leaseUntil: new Date(now.getTime() + 60_000),
      limit: 50,
    })
    expect(firstClaim.map((c) => c.auctionId)).toContain(auctionId)

    const secondClaimWithinLease = await cancellations.claimPendingCancellations({
      now: new Date(now.getTime() + 1_000),
      workerId: 'worker-b',
      leaseUntil: new Date(now.getTime() + 61_000),
      limit: 50,
    })
    expect(secondClaimWithinLease.map((c) => c.auctionId)).not.toContain(auctionId)

    const thirdClaimAfterLeaseExpired = await cancellations.claimPendingCancellations({
      now: new Date(now.getTime() + 61_000),
      workerId: 'worker-b',
      leaseUntil: new Date(now.getTime() + 121_000),
      limit: 50,
    })
    expect(thirdClaimAfterLeaseExpired.map((c) => c.auctionId)).toContain(auctionId)
  })

  // 12 (real). concurrencia de dos workers: FOR UPDATE SKIP LOCKED garantiza
  // que ninguna fila aparece en ambos resultados.
  it('dos reclamos concurrentes nunca devuelven la misma fila', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `reconciler-concurrent-${String(index)}`)
    for (const id of ids) await seedCommittedCancellation(id)

    const [claimA, claimB] = await Promise.all([
      cancellations.claimPendingCancellations({
        now,
        workerId: 'worker-a',
        leaseUntil: new Date(now.getTime() + 60_000),
        limit: 10,
      }),
      cancellations.claimPendingCancellations({
        now,
        workerId: 'worker-b',
        leaseUntil: new Date(now.getTime() + 60_000),
        limit: 10,
      }),
    ])

    const idsA = new Set(claimA.map((c) => c.auctionId))
    const idsB = claimB.map((c) => c.auctionId)
    for (const id of idsB) expect(idsA.has(id)).toBe(false)
    expect(claimA.length + claimB.length).toBeLessThanOrEqual(ids.length)
    expect(claimA.length + claimB.length).toBeGreaterThan(0)
  })
})
