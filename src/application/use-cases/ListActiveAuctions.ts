import type { ActiveAuctionList, AuctionRepositoryPort } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'

export interface ListActiveAuctionsInput {
  readonly page: number
  readonly pageSize: number
}

/** Consulta del marketplace; el limite temporal procede del reloj inyectado. */
export class ListActiveAuctions {
  constructor(
    private readonly auctions: Pick<AuctionRepositoryPort, 'listActive'>,
    private readonly clock: ClockPort,
  ) {}

  execute(input: ListActiveAuctionsInput): Promise<ActiveAuctionList> {
    return this.auctions.listActive({ ...input, now: this.clock.now() })
  }
}
