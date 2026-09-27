import { InMemoryAuctionRepository } from '../../src/adapters/outbound/persistence/InMemoryAuctionRepository'
import {
  IdempotencyConflictError,
  ProductNotEligibleForOfficialAuctionError,
} from '../../src/application/errors/AuctionPersistenceError'
import { ExternalDependencyUnavailableError } from '../../src/application/errors/ExternalDependencyError'
import type {
  OfficialAuctionEligibility,
  OfficialAuctionEligibilityPort,
} from '../../src/application/ports/OfficialAuctionEligibilityPort'
import {
  PublishOfficialAuction,
  type PublishOfficialAuctionCommand,
} from '../../src/application/use-cases/PublishOfficialAuction'
import { AuctionPublisherType } from '../../src/domain/entities/OfficialAuction'
import { AuctionRuleCode } from '../../src/domain/errors/AuctionRuleViolation'

const NOW = new Date('2026-09-23T12:00:00.000Z')

const eligibleOfficial = (productId: string): OfficialAuctionEligibility => ({
  productId,
  exclusive: true,
  officialMark: 'OFFICIAL',
  publishable: true,
})

const fixture = () => {
  const repository = new InMemoryAuctionRepository()
  const eligibility: OfficialAuctionEligibilityPort = {
    getEligibility: (productId: string) => Promise.resolve(eligibleOfficial(productId)),
  }
  const clock = { now: () => new Date(NOW) }
  let sequence = 0
  const useCase = new PublishOfficialAuction(repository, eligibility, clock, {
    generate: () => `official-${String(++sequence)}`,
  })

  return { repository, eligibility, useCase }
}

const command = (
  overrides: Partial<PublishOfficialAuctionCommand> = {},
): PublishOfficialAuctionCommand => ({
  operationId: 'operation-1',
  publisherId: 'upb-company-subject',
  productId: 'exclusive-product-1',
  durationHours: 48,
  currency: 'COP',
  minimumBidAmountMinor: 150_000,
  buyNowAmountMinor: 300_000,
  ...overrides,
})

const expectRule = async (promise: Promise<unknown>, code: AuctionRuleCode): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('HU-66.5 - aceptacion de publicacion oficial', () => {
  it.each([
    ['OFFICIAL' as const, 24, '2026-09-24T12:00:00.000Z'],
    ['PREMIUM' as const, 48, '2026-09-25T12:00:00.000Z'],
  ])(
    'publica %s en dinero real sin comision ni limite de subastas activas',
    async (mark, hours, closesAt) => {
      const { repository, eligibility, useCase } = fixture()
      eligibility.getEligibility = (productId: string) =>
        Promise.resolve({ ...eligibleOfficial(productId), officialMark: mark })

      const result = await useCase.execute(command({ durationHours: hours }))

      expect(result).toMatchObject({
        publisherId: 'upb-company-subject',
        publisherType: AuctionPublisherType.GameMaster,
        publicationFeeCredits: 0,
        currency: 'COP',
        minimumBidAmountMinor: 150_000,
        buyNowAmountMinor: 300_000,
        mark,
        status: 'ACTIVE',
        closesAt: new Date(closesAt),
      })
      await expect(repository.findOfficialById(result.id)).resolves.toEqual(result)
    },
  )

  it('publica sin precio de compra inmediata cuando no se envia', async () => {
    const { useCase } = fixture()

    const result = await useCase.execute(command({ buyNowAmountMinor: null }))

    expect(result.buyNowAmountMinor).toBeNull()
  })

  it('rechaza un producto ordinario o suspendido sin publicar', async () => {
    const { repository, eligibility, useCase } = fixture()
    eligibility.getEligibility = (productId: string) =>
      Promise.resolve({ productId, exclusive: false, officialMark: null, publishable: false })

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(
      ProductNotEligibleForOfficialAuctionError,
    )
    await expect(repository.findOfficialById('official-1')).resolves.toBeNull()
  })

  it('falla de forma cerrada si Catalog no esta disponible', async () => {
    const { repository, eligibility, useCase } = fixture()
    eligibility.getEligibility = () =>
      Promise.reject(new ExternalDependencyUnavailableError('catalog'))

    await expect(useCase.execute(command())).rejects.toBeInstanceOf(
      ExternalDependencyUnavailableError,
    )
    await expect(repository.findOfficialById('official-1')).resolves.toBeNull()
  })

  it('rechaza precios invalidos sin llegar a persistir', async () => {
    const { useCase } = fixture()

    await expectRule(
      useCase.execute(command({ minimumBidAmountMinor: 0 })),
      AuctionRuleCode.InvalidMoney,
    )
    await expectRule(
      useCase.execute(command({ buyNowAmountMinor: 100 })),
      AuctionRuleCode.InvalidBuyNowPrice,
    )
  })

  it('un reintento idempotente devuelve la misma publicacion sin duplicarla', async () => {
    const { repository, useCase } = fixture()

    const first = await useCase.execute(command())
    const retry = await useCase.execute(command())

    expect(retry.id).toBe(first.id)
    const audit = await repository.findOfficialById(first.id)
    expect(audit).toEqual(first)
  })

  it('rechaza reutilizar la operacion con otra intencion funcional', async () => {
    const { useCase } = fixture()
    await useCase.execute(command())

    await expect(useCase.execute(command({ durationHours: 24 }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    )
  })
})
