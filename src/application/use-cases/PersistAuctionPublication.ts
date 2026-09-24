import type {
  AuctionRepositoryPort,
  PersistAuctionPublicationResult,
} from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import {
  inventoryCommitOperationId,
  type ProductInventoryPort,
} from '../ports/ProductInventoryPort'
import type { AuctionPublicationIntentRepositoryPort } from '../ports/AuctionPublicationIntentRepositoryPort'
import type { PublicationFeePort } from '../ports/PublicationFeePort'
import type { Auction } from '../../domain/entities/Auction'

export interface PersistPublicationCommand {
  readonly operationId: string
  readonly auction: Auction
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

export class PersistAuctionPublication {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly inventory: ProductInventoryPort,
    private readonly fees: PublicationFeePort,
    private readonly clock: ClockPort,
    private readonly intents: AuctionPublicationIntentRepositoryPort,
  ) {}

  async execute(command: PersistPublicationCommand): Promise<PersistAuctionPublicationResult> {
    const auction = command.auction.snapshot()
    let stage = 'CHARGING_FEE'
    const intent = await this.intents.getByOperationId(command.operationId)
    if (intent === null) throw new Error(`La intencion ${command.operationId} no existe.`)
    if (intent.publicationStatus === 'COMPLETED') {
      const published = await this.repository.findById(intent.auctionId)
      if (published === null) throw new Error(`La publicacion ${intent.auctionId} no existe.`)
      return { auction: published, replayed: true }
    }
    let feeChargeId: string | null = null
    let inventoryCommitmentId = intent.inventoryCommitmentId

    try {
      feeChargeId = (
        await this.fees.charge({
          operationId: command.operationId,
          sellerId: auction.sellerId,
          amount: auction.publicationFeeCredits,
        })
      ).chargeId
      stage = 'COMMITTING_INVENTORY'
      if (intent.inventoryStatus !== 'COMMITTED') {
        inventoryCommitmentId = (
          await this.inventory.commit({
            operationId: inventoryCommitOperationId(auction.id),
            auctionId: auction.id,
            ownerId: auction.sellerId,
            productId: auction.productId,
            expiresAt: auction.closesAt,
          })
        ).commitmentId
        await this.intents.persistInventoryCommitment(
          command.operationId,
          inventoryCommitmentId,
          this.clock.now(),
        )
      }
      if (inventoryCommitmentId === null)
        throw new Error('El commitment Inventory durable no existe.')
      stage = 'PERSISTING_AUCTION'

      const result = await this.repository.publish({
        operationId: command.operationId,
        auction: command.auction,
        inventoryCommitmentId,
        feeChargeId,
      })
      await this.intents.markPublicationCompleted(command.operationId, this.clock.now())
      return result
    } catch (error: unknown) {
      await this.intents.recordFailure(command.operationId, reasonOf(error), this.clock.now())

      await this.repository.recordFailure({
        operationId: command.operationId,
        auctionId: auction.id,
        sellerId: auction.sellerId,
        stage,
        reason: reasonOf(error),
        feeChargeId,
        inventoryCommitmentId,
        feeRefunded: false,
        inventoryReleased: inventoryCommitmentId === null,
        occurredAt: this.clock.now(),
      })
      throw error
    }
  }
}
