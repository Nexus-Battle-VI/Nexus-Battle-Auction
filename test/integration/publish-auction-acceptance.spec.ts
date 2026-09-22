import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import { InsufficientPublicationFundsError } from '../../src/application/errors/AuctionPersistenceError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import type { CatalogProductPolicyPort } from '../../src/application/ports/CatalogProductPolicyPort'
import type {
  CommitInventoryProductCommand,
  InventoryProductEligibility,
  ProductInventoryPort,
} from '../../src/application/ports/ProductInventoryPort'
import type {
  ChargePublicationFeeCommand,
  PublicationFeePort,
} from '../../src/application/ports/PublicationFeePort'
import type { SellerSanctionPort } from '../../src/application/ports/SellerSanctionPort'
import { PersistAuctionPublication } from '../../src/application/use-cases/PersistAuctionPublication'
import {
  PublishAuction,
  type PublishAuctionCommand,
} from '../../src/application/use-cases/PublishAuction'
import { AuctionRuleCode } from '../../src/domain/errors/AuctionRuleViolation'

const NOW = new Date('2026-09-21T12:00:00.000Z')

class StatefulWallet implements PublicationFeePort {
  readonly charges = new Map<string, { chargeId: string; amount: number; refunded: boolean }>()
  failure: Error | null = null

  constructor(public balance = 20) {}

  charge(command: ChargePublicationFeeCommand): Promise<{ chargeId: string }> {
    if (this.failure !== null) return Promise.reject(this.failure)
    const previous = this.charges.get(command.operationId)
    if (previous !== undefined) return Promise.resolve({ chargeId: previous.chargeId })
    if (this.balance < command.amount)
      return Promise.reject(new InsufficientPublicationFundsError())

    const chargeId = `charge-${command.operationId}`
    this.balance -= command.amount
    this.charges.set(command.operationId, { chargeId, amount: command.amount, refunded: false })
    return Promise.resolve({ chargeId })
  }

  refund(operationId: string, chargeId: string): Promise<void> {
    const charge = this.charges.get(operationId)
    if (charge?.chargeId === chargeId && !charge.refunded) {
      charge.refunded = true
      this.balance += charge.amount
    }
    return Promise.resolve()
  }
}

class StatefulInventory implements ProductInventoryPort {
  eligibility: InventoryProductEligibility = { ownedByPlayer: true, inUse: false }
  commitFailure: Error | null = null
  readonly commitments = new Map<
    string,
    { commitmentId: string; productId: string; released: boolean }
  >()

  inspect(): Promise<InventoryProductEligibility> {
    return Promise.resolve(this.eligibility)
  }

  commit(command: CommitInventoryProductCommand): Promise<{ commitmentId: string }> {
    if (this.commitFailure !== null) return Promise.reject(this.commitFailure)
    const previous = this.commitments.get(command.operationId)
    if (previous !== undefined) return Promise.resolve({ commitmentId: previous.commitmentId })

    const commitmentId = `commitment-${command.operationId}`
    this.commitments.set(command.operationId, {
      commitmentId,
      productId: command.productId,
      released: false,
    })
    return Promise.resolve({ commitmentId })
  }

  release(operationId: string, commitmentId: string): Promise<void> {
    const commitment = this.commitments.get(operationId)
    if (commitment?.commitmentId === commitmentId) {
      commitment.released = true
    }
    return Promise.resolve()
  }
}

const fixture = (balance = 20) => {
  const repository = new InMemoryAuctionRepository()
  const inventory = new StatefulInventory()
  const wallet = new StatefulWallet(balance)
  const catalog: CatalogProductPolicyPort = {
    getPolicy: () => Promise.resolve({ tradableInAuction: true }),
  }
  const sanctions: SellerSanctionPort = { hasActiveSanctions: () => Promise.resolve(false) }
  const clock = { now: () => new Date(NOW) }
  let sequence = 0
  const persistence = new PersistAuctionPublication(repository, inventory, wallet, clock)
  const useCase = new PublishAuction(
    repository,
    catalog,
    inventory,
    sanctions,
    persistence,
    clock,
    {
      generate: () => `auction-${String(++sequence)}`,
    },
  )

  return { repository, inventory, wallet, catalog, sanctions, useCase }
}

const command = (overrides: Partial<PublishAuctionCommand> = {}): PublishAuctionCommand => ({
  operationId: 'operation-1',
  sellerId: 'seller-1',
  productId: 'product-1',
  durationHours: 24,
  minimumBidCredits: 10,
  buyNowCredits: 20,
  ...overrides,
})

const expectRule = async (promise: Promise<unknown>, code: AuctionRuleCode): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('HU-62 - aceptacion de publicacion de subasta', () => {
  it.each([
    { durationHours: 24, fee: 1, closesAt: '2026-09-22T12:00:00.000Z' },
    { durationHours: 48, fee: 3, closesAt: '2026-09-23T12:00:00.000Z' },
  ])(
    'publica por $durationHours horas, cobra $fee credito(s) y bloquea el producto',
    async (testCase) => {
      const { repository, inventory, wallet, useCase } = fixture()

      const result = await useCase.execute(command({ durationHours: testCase.durationHours }))

      expect(result).toMatchObject({
        status: 'ACTIVE',
        durationHours: testCase.durationHours,
        publicationFeeCredits: testCase.fee,
        closesAt: new Date(testCase.closesAt),
      })
      expect(wallet.balance).toBe(20 - testCase.fee)
      expect(wallet.charges.size).toBe(1)
      expect(inventory.commitments.get('operation-1')).toMatchObject({
        productId: 'product-1',
        released: false,
      })
      await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(1)
    },
  )

  it.each([
    {
      name: 'producto ajeno',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.inventory.eligibility = { ownedByPlayer: false, inUse: false }
      },
      code: AuctionRuleCode.ProductNotOwned,
    },
    {
      name: 'producto en uso',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.inventory.eligibility = { ownedByPlayer: true, inUse: true }
      },
      code: AuctionRuleCode.ProductInUse,
    },
    {
      name: 'producto no comerciable',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.catalog.getPolicy = () => Promise.resolve({ tradableInAuction: false })
      },
      code: AuctionRuleCode.ProductNotTradable,
    },
    {
      name: 'vendedor sancionado',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.sanctions.hasActiveSanctions = () => Promise.resolve(true)
      },
      code: AuctionRuleCode.SellerSanctioned,
    },
    {
      name: 'compra inmediata igual a la puja minima',
      configure: (): void => undefined,
      code: AuctionRuleCode.InvalidBuyNowPrice,
      request: { buyNowCredits: 10 },
    },
  ])(
    'rechaza $name sin cobrar, bloquear ni crear subasta',
    async ({ configure, code, request }) => {
      const state = fixture()
      configure(state)

      await expectRule(state.useCase.execute(command(request)), code)

      expect(state.wallet.balance).toBe(20)
      expect(state.wallet.charges.size).toBe(0)
      expect(state.inventory.commitments.size).toBe(0)
      await expect(state.repository.countActiveBySeller('seller-1')).resolves.toBe(0)
    },
  )

  it('rechaza saldo insuficiente sin alterar saldo, inventario ni subastas', async () => {
    const { repository, inventory, wallet, useCase } = fixture(0)

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(
      InsufficientPublicationFundsError,
    )

    expect(wallet.balance).toBe(0)
    expect(wallet.charges.size).toBe(0)
    expect(inventory.commitments.size).toBe(0)
    await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(0)
  })

  it.each([
    {
      dependency: 'Catalog',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.catalog.getPolicy = () =>
          Promise.reject(new ExternalDependencyUnavailableError('catalog'))
      },
    },
    {
      dependency: 'Account',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.sanctions.hasActiveSanctions = () =>
          Promise.reject(new ExternalDependencyUnavailableError('account'))
      },
    },
    {
      dependency: 'Inventory',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.inventory.inspect = () =>
          Promise.reject(new ExternalDependencyUnavailableError('inventory'))
      },
    },
    {
      dependency: 'Wallet',
      configure: (state: ReturnType<typeof fixture>): void => {
        state.wallet.failure = new ExternalDependencyUnavailableError('wallet')
      },
    },
  ])('falla de forma cerrada si $dependency no esta disponible', async ({ configure }) => {
    const state = fixture()
    configure(state)

    await expect(state.useCase.execute(command())).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
    expect(state.wallet.balance).toBe(20)
    expect(state.wallet.charges.size).toBe(0)
    expect(state.inventory.commitments.size).toBe(0)
    await expect(state.repository.countActiveBySeller('seller-1')).resolves.toBe(0)
  })

  it('rechaza la subasta numero once sin cobrar ni bloquear de nuevo', async () => {
    const { repository, inventory, wallet, useCase } = fixture()

    for (let index = 1; index <= 10; index += 1) {
      await useCase.execute(
        command({
          operationId: `operation-${String(index)}`,
          productId: `product-${String(index)}`,
        }),
      )
    }

    await expectRule(
      useCase.execute(command({ operationId: 'operation-11', productId: 'product-11' })),
      AuctionRuleCode.ActiveAuctionLimitReached,
    )
    expect(wallet.balance).toBe(10)
    expect(wallet.charges.size).toBe(10)
    expect(inventory.commitments.size).toBe(10)
    await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(10)
  })

  it('compensa el cobro y no crea la subasta si falla el bloqueo de inventario', async () => {
    const { repository, inventory, wallet, useCase } = fixture()
    inventory.commitFailure = new ExternalDependencyUnavailableError('inventory')

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )

    expect(wallet.balance).toBe(20)
    expect(wallet.charges.get('operation-1')).toMatchObject({ refunded: true })
    expect(inventory.commitments.size).toBe(0)
    await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(0)
  })

  it('un reintento idempotente no duplica cobros, bloqueos ni subastas', async () => {
    const { repository, inventory, wallet, useCase } = fixture()

    const first = await useCase.execute(command())
    const retry = await useCase.execute(command())

    expect(retry.id).toBe(first.id)
    expect(wallet.balance).toBe(19)
    expect(wallet.charges.size).toBe(1)
    expect(inventory.commitments.size).toBe(1)
    await expect(repository.countActiveBySeller('seller-1')).resolves.toBe(1)
  })
})
