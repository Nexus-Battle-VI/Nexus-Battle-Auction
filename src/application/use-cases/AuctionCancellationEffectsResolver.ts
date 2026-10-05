import { AuctionCancellationOrigin } from '../../domain/events/AuctionCancelledEventV1'
import type { AuctionCancellationSnapshot } from '../ports/AuctionCancellationRepositoryPort'
import type { CancelAuction } from './CancelAuction'
import type { CancelAuctionAutomatically } from './CancelAuctionAutomatically'

/**
 * HU-90, CA-05. Enruta la resolucion de efectos pendientes de una cancelacion
 * al caso de uso que la creo, segun su `origin`. Permite que
 * `AuctionCancellationReconciler` reconcilie cancelaciones manuales y
 * automaticas sin conocer las reglas de ninguna de las dos: la manual
 * reembolsa media comision; la automatica no reembolsa y libera reservas.
 */
export class AuctionCancellationEffectsResolver {
  constructor(
    private readonly manual: Pick<CancelAuction, 'resolvePendingEffects'>,
    private readonly automatic: Pick<CancelAuctionAutomatically, 'resolvePendingEffects'>,
  ) {}

  resolvePendingEffects(cancellation: AuctionCancellationSnapshot): Promise<void> {
    return cancellation.origin === AuctionCancellationOrigin.TermsViolation
      ? this.automatic.resolvePendingEffects(cancellation)
      : this.manual.resolvePendingEffects(cancellation)
  }
}
