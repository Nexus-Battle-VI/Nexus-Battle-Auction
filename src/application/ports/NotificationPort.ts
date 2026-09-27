/**
 * Puerto hacia el bounded context Notifications (HU-64.5).
 *
 * Avisa a un participante de que la subasta en la que tenia una puja se cerro
 * de forma anticipada por una compra inmediata. El contenido y canal exactos
 * son responsabilidad de Notifications; Auction solo entrega los datos.
 */
export interface NotifyAuctionClosedEarlyCommand {
  readonly operationId: string
  readonly auctionId: string
  readonly recipientId: string
  readonly transactionId: string
  readonly closedAt: Date
}

export interface NotificationDispatch {
  readonly notificationId: string
}

export interface NotificationPort {
  notifyAuctionClosedEarly(command: NotifyAuctionClosedEarlyCommand): Promise<NotificationDispatch>
}

export const NOTIFICATION = Symbol('NotificationPort')
