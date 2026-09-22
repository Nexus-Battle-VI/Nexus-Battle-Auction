import { AutoBidConfig, type AutoBidConfigSnapshot } from '../../domain/entities/AutoBidConfig'
import { PersistedAuctionNotFoundError } from '../errors/AuctionPersistenceError'
import type { AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

export interface ConfigureAutoBidCommand {
  readonly auctionId: string
  readonly bidderId: string
  readonly maxAmountCredits: number
}

/**
 * HU-67.5: expone HU-67.1 (validacion de dominio) y HU-67.4 (persistencia)
 * al flujo HTTP. Reconfigurar (mismo jugador, misma subasta) reemplaza el
 * limite anterior via el upsert de AuctionRepositoryPort.saveAutoBidConfig.
 */
export class ConfigureAutoBid {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: ConfigureAutoBidCommand): Promise<AutoBidConfigSnapshot> {
    const auction = await this.repository.findById(command.auctionId)

    if (auction === null) {
      throw new PersistedAuctionNotFoundError(command.auctionId)
    }

    const now = this.clock.now()

    /*
     * Misma regla que RegisterBid.registerNewBid: el estado ACTIVE
     * persistido puede haber quedado obsoleto si la subasta ya vencio.
     */
    const effectiveAuctionStatus =
      now.getTime() < auction.closesAt.getTime() ? auction.status : 'CLOSED'

    const config = AutoBidConfig.configure({
      auctionId: command.auctionId,

      bidderId: command.bidderId,

      maxAmountCredits: command.maxAmountCredits,

      configuredAt: now,

      eligibility: {
        auctionStatus: effectiveAuctionStatus,

        sellerId: auction.sellerId,
      },
    })

    return await this.repository.saveAutoBidConfig(config)
  }
}
