import type {
  AuctionRepositoryPort,
  PersistAuctionPublicationResult,
} from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { ProductInventoryPort } from '../ports/ProductInventoryPort'
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
  ) {}

  async execute(command: PersistPublicationCommand): Promise<PersistAuctionPublicationResult> {
    const auction = command.auction.snapshot()
    let stage = 'CHARGING_FEE'
    let feeChargeId: string | null = null
    let inventoryCommitmentId: string | null = null

    try {
      feeChargeId = (
        await this.fees.charge({
          operationId: command.operationId,
          sellerId: auction.sellerId,
          amount: auction.publicationFeeCredits,
        })
      ).chargeId
      stage = 'COMMITTING_INVENTORY'
      inventoryCommitmentId = (
        await this.inventory.commit({
          operationId: command.operationId,
          ownerId: auction.sellerId,
          productId: auction.productId,
          expiresAt: auction.closesAt,
        })
      ).commitmentId
      stage = 'PERSISTING_AUCTION'

      return await this.repository.publish({
        operationId: command.operationId,
        auction: command.auction,
        inventoryCommitmentId,
        feeChargeId,
      })
    } catch (error: unknown) {
      let inventoryReleased = inventoryCommitmentId === null
      let feeRefunded = feeChargeId === null

      if (inventoryCommitmentId !== null) {
        try {
          await this.inventory.release(command.operationId, inventoryCommitmentId)
          inventoryReleased = true
        } catch {
          inventoryReleased = false
        }
      }
      if (feeChargeId !== null) {
        try {
          await this.fees.refund(command.operationId, feeChargeId)
          feeRefunded = true
        } catch {
          feeRefunded = false
        }
      }

      await this.repository.recordFailure({
        operationId: command.operationId,
        auctionId: auction.id,
        sellerId: auction.sellerId,
        stage,
        reason: reasonOf(error),
        feeChargeId,
        inventoryCommitmentId,
        feeRefunded,
        inventoryReleased,
        occurredAt: this.clock.now(),
      })
      throw error
    }
  }
}
