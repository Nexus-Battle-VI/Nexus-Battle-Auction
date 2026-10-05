import type {
  AuctionActivityRepositoryPort,
  PersonalPageInput,
  PersonalTransactionPage,
} from '../ports/AuctionActivityRepositoryPort'

/** Recupera operaciones autoritativas de Auction sin reconstruirlas en Web. */
export class GetMyAuctionTransactions {
  constructor(private readonly repository: AuctionActivityRepositoryPort) {}

  execute(input: PersonalPageInput): Promise<PersonalTransactionPage> {
    return this.repository.listTransactions(input)
  }
}
