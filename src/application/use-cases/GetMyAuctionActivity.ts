import type { ClockPort } from '../ports/ClockPort'
import type {
  AuctionActivityRepositoryPort,
  PersonalAuctionPage,
  PersonalBidPage,
  PersonalPageInput,
} from '../ports/AuctionActivityRepositoryPort'

/** Consultas privadas de publicaciones y participaciones del jugador autenticado. */
export class GetMyAuctionActivity {
  constructor(
    private readonly repository: AuctionActivityRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  listOwned(input: PersonalPageInput): Promise<PersonalAuctionPage> {
    return this.repository.listOwnedAuctions({ ...input, now: this.clock.now() })
  }

  listBids(input: PersonalPageInput): Promise<PersonalBidPage> {
    return this.repository.listBidParticipations(input)
  }
}
