import {
  AuctionPublisherType,
  OfficialAuction,
  OfficialAuctionMark,
  type OfficialAuctionSnapshot,
} from '../../domain/entities/OfficialAuction'
import { AuctionPriceKind } from '../../domain/value-objects/AuctionPublicationPricing'
import { ProductNotEligibleForOfficialAuctionError } from '../errors/AuctionPersistenceError'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdentifierGeneratorPort } from '../ports/IdentifierGeneratorPort'
import type {
  OfficialAuctionEligibilityPort,
  OfficialAuctionMark as CatalogOfficialAuctionMark,
} from '../ports/OfficialAuctionEligibilityPort'

export interface PublishOfficialAuctionCommand {
  readonly operationId: string
  readonly publisherId: string
  readonly productId: string
  readonly durationHours: number
  readonly currency: string
  readonly minimumBidAmountMinor: number
  readonly buyNowAmountMinor?: number | null
}

const toDomainMark = (mark: CatalogOfficialAuctionMark): OfficialAuctionMark =>
  mark === 'OFFICIAL' ? OfficialAuctionMark.Official : OfficialAuctionMark.Premium

export class PublishOfficialAuction {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly eligibility: OfficialAuctionEligibilityPort,
    private readonly clock: ClockPort,
    private readonly identifiers: IdentifierGeneratorPort,
  ) {}

  async execute(command: PublishOfficialAuctionCommand): Promise<OfficialAuctionSnapshot> {
    const policy = await this.eligibility.getEligibility(command.productId)

    // Catalog es la unica autoridad: un producto ordinario o suspendido no se
    // publica, y una marca ausente pese a `publishable: true` es un contrato
    // que no se puede confiar (fail-closed, igual que el cliente HTTP).
    if (!policy.publishable || policy.officialMark === null) {
      throw new ProductNotEligibleForOfficialAuctionError(command.productId)
    }

    const auction = OfficialAuction.publish({
      auctionId: this.identifiers.generate(),
      publisherId: command.publisherId,
      publisherType: AuctionPublisherType.GameMaster,
      productId: command.productId,
      durationHours: command.durationHours,
      pricing: {
        kind: AuctionPriceKind.RealMoney,
        minimumBid: { amountMinor: command.minimumBidAmountMinor, currency: command.currency },
        buyNow:
          command.buyNowAmountMinor === undefined || command.buyNowAmountMinor === null
            ? null
            : { amountMinor: command.buyNowAmountMinor, currency: command.currency },
      },
      mark: toDomainMark(policy.officialMark),
      publishedAt: this.clock.now(),
    })

    return (await this.repository.publishOfficial({ operationId: command.operationId, auction }))
      .auction
  }
}
