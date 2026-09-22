import type { AutoBidConfigSnapshot } from '../../domain/entities/AutoBidConfig'
import { Bid, type BidSnapshot } from '../../domain/entities/Bid'
import { AutoBidLimit } from '../../domain/value-objects/AutoBidLimit'
import { ConcurrentBidConflictError } from '../errors/AuctionPersistenceError'
import type { AuctionRepositoryPort, PersistBidResult } from '../ports/AuctionRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { IdentifierGeneratorPort } from '../ports/IdentifierGeneratorPort'
import type { OutbidNotificationPort } from '../ports/OutbidNotificationPort'
import type { PersistBidWithCredits } from './PersistBidWithCredits'

export interface ReactToRivalBidCommand {
  readonly operationId: string
  readonly leadingBid: BidSnapshot
}

/**
 * Cota defensiva contra un bucle sin fin.
 *
 * En el camino normal la cadena termina sola: cada ronda exitosa aumenta
 * estrictamente la oferta, y cada candidato que falla se excluye para el
 * resto de esta cadena (`excludedThisChain`). Esta cota solo protege contra
 * un bug futuro que reintroduzca un ciclo.
 */
const MAX_REACTION_ROUNDS = 200

/**
 * HU-67.2: ante una puja que desplaza a un lider, reacciona en nombre de
 * cualquier otro jugador con puja automatica activa cuyo limite alcance
 * para volver a liderar, de forma encadenada, hasta que ya nadie pueda
 * superar la oferta sin excederse.
 *
 * Se ejecuta despues de que la puja original ya quedo confirmada
 * (ver RegisterBid). Por eso nunca propaga un error: una reaccion
 * automatica que falla no debe invalidar una puja humana ya aceptada.
 */
export class ReactToRivalBid {
  constructor(
    private readonly repository: AuctionRepositoryPort,
    private readonly persistence: PersistBidWithCredits,
    private readonly clock: ClockPort,
    private readonly identifiers: IdentifierGeneratorPort,
    private readonly notifications: OutbidNotificationPort,
  ) {}

  async execute(command: ReactToRivalBidCommand): Promise<void> {
    try {
      await this.react(command)
    } catch {
      /*
       * Best-effort: la puja que origino la reaccion ya fue confirmada.
       * Un fallo aqui no debe propagarse hasta RegisterBid.
       */
    }
  }

  private async react(command: ReactToRivalBidCommand): Promise<void> {
    const auction = await this.repository.findById(command.leadingBid.auctionId)

    if (auction === null) {
      return
    }

    let currentLeader = command.leadingBid

    const excludedThisChain = new Set<string>()

    for (let round = 0; round < MAX_REACTION_ROUNDS;) {
      const now = this.clock.now()

      if (now.getTime() >= auction.closesAt.getTime()) {
        return
      }

      const candidates = (
        await this.repository.findActiveAutoBidsForAuction(auction.id, currentLeader.bidderId)
      ).filter((candidate) => !excludedThisChain.has(candidate.bidderId))

      if (candidates.length === 0) {
        return
      }

      const nextAmount = currentLeader.amountCredits + auction.minimumBidCredits

      const affordable: AutoBidConfigSnapshot[] = []

      /*
       * HU-67.3: un candidato cuyo limite ya no alcanza para el siguiente
       * incremento minimo nunca podra alcanzar uno mayor mas adelante en
       * esta misma cadena (nextAmount solo crece), asi que se notifica una
       * unica vez y se excluye del resto de la cadena.
       */
      for (const candidate of candidates) {
        if (AutoBidLimit.positive(candidate.maxAmountCredits).canAfford(nextAmount)) {
          affordable.push(candidate)
        } else {
          excludedThisChain.add(candidate.bidderId)

          await this.notifyLimitReached(
            command.operationId,
            candidate,
            currentLeader,
            nextAmount,
            now,
          )
        }
      }

      affordable.sort(
        (left, right) =>
          right.maxAmountCredits - left.maxAmountCredits ||
          left.configuredAt.getTime() - right.configuredAt.getTime() ||
          left.bidderId.localeCompare(right.bidderId),
      )

      if (affordable.length === 0) {
        return
      }

      let placed: BidSnapshot | null = null

      for (const candidate of affordable) {
        round += 1

        const roundOperationId = `${command.operationId}:auto:${String(round)}`

        try {
          const [lastBidByBidder, activeBidCount] = await Promise.all([
            this.repository.findLastBidByBidder(candidate.bidderId),
            this.repository.countActiveBidsByBidder(candidate.bidderId),
          ])

          const bid = Bid.register({
            bidId: this.identifiers.generate(),

            auctionId: auction.id,

            bidderId: candidate.bidderId,

            amountCredits: nextAmount,

            placedAt: now,

            eligibility: {
              auctionStatus: auction.status,

              sellerId: auction.sellerId,

              currentBidCredits: currentLeader.amountCredits,

              minimumIncrementCredits: auction.minimumBidCredits,

              lastBidAtByBidder: lastBidByBidder?.placedAt ?? null,

              activeBidCount,
            },
          })

          const result = await this.persistence.execute({
            operationId: roundOperationId,

            bid,

            expiresAt: auction.closesAt,
          })

          await this.notifyDisplacedLeader(roundOperationId, result)

          placed = result.bid

          break
        } catch (error: unknown) {
          if (error instanceof ConcurrentBidConflictError) {
            const refreshed = await this.repository.findLeadingBid(auction.id)

            if (refreshed !== null) {
              currentLeader = refreshed
            }

            break
          }

          /*
           * Regla de dominio incumplida (cooldown, limite de pujas activas,
           * etc.) o creditos insuficientes: este candidato no puede
           * reaccionar en esta cadena. Se prueba con el siguiente.
           */
          excludedThisChain.add(candidate.bidderId)
        }
      }

      if (placed !== null) {
        currentLeader = placed
      }

      /*
       * Sin puja nueva: o hubo conflicto de concurrencia (el lider real
       * cambio mientras se evaluaba) o ningun candidato pudo reaccionar.
       * En ambos casos la siguiente vuelta recalcula con el estado real.
       */
    }
  }

  private async notifyDisplacedLeader(
    operationId: string,
    result: PersistBidResult,
  ): Promise<void> {
    const previousLeader = result.previousLeader

    if (previousLeader === null) {
      return
    }

    if (previousLeader.bidderId === result.bid.bidderId) {
      return
    }

    try {
      await this.notifications.publish({
        notificationId: `${operationId}:outbid`,

        operationId,

        recipientPlayerId: previousLeader.bidderId,

        auctionId: result.bid.auctionId,

        outbidBidId: previousLeader.id,

        winningBidId: result.bid.id,

        winningBidderId: result.bid.bidderId,

        winningAmountCredits: result.bid.amountCredits,

        occurredAt: result.bid.placedAt,
      })
    } catch {
      /*
       * Igual que RegisterBid.notifyPreviousLeader: un fallo temporal de
       * Notifications no debe deshacer una puja automatica ya confirmada.
       */
    }
  }

  /**
   * HU-67.3 / CA-02: el jugador tiene una puja automatica activa pero su
   * limite ya no alcanza para seguir liderando. Best-effort: nunca debe
   * afectar el resultado de la puja rival que origino la cadena.
   */
  private async notifyLimitReached(
    operationId: string,
    candidate: AutoBidConfigSnapshot,
    leadingBid: BidSnapshot,
    requiredAmountCredits: number,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await this.notifications.publishAutoBidLimitReached({
        notificationId: `${operationId}:auto:limit:${candidate.bidderId}`,

        operationId,

        recipientPlayerId: candidate.bidderId,

        auctionId: candidate.auctionId,

        autoBidLimitCredits: candidate.maxAmountCredits,

        requiredAmountCredits,

        leadingBidderId: leadingBid.bidderId,

        occurredAt,
      })
    } catch {
      /*
       * Notificar el limite alcanzado es best-effort: un fallo temporal de
       * Notifications no debe interrumpir la evaluacion del resto de la
       * cadena ni la puja rival ya confirmada.
       */
    }
  }
}
