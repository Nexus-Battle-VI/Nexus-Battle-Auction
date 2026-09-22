import { ExternalDependencyUnavailableError } from '../../../application/errors/ExternalDependencyError'
import type {
  OutbidNotification,
  OutbidNotificationPort,
} from '../../../application/ports/OutbidNotificationPort'

/**
 * Adaptador fail-closed utilizado cuando Auction no tiene
 * configurado el contrato con Notifications.
 *
 * RegisterBid trata Notifications como una reaccion posterior:
 * este error nunca revierte una puja ya confirmada.
 */
export class UnavailableOutbidNotification implements OutbidNotificationPort {
  publish(notification: OutbidNotification): Promise<void> {
    void notification

    return Promise.reject(new ExternalDependencyUnavailableError('notifications'))
  }
}
