# TASK HU-92.3 — Confirmaciones de acreditación, compra y reclamo

## Eventos durables

Auction reutiliza el dispatcher HTTP firmado de HU-92.2. Los eventos quedan en
`outbox_events` y solo se marcan publicados después de la respuesta completa
de Notifications; un fallo de entrega no revierte Wallet ni Inventory.

| Evento                         | Cuándo se registra                                                                            | Identidad estable                     | Destinatarios                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `auction.settled.v1`           | El settlement terminó con la captura Wallet confirmada.                                       | `auction:<auctionId>:settled`         | Vendedor acreditado, ganador y perdedores existentes. |
| `auction.buy-now.completed.v1` | Wallet confirmó la transferencia y el cierre de buy-now se persistió en la misma transacción. | `<operationId>:buy-now-completed`     | Vendedor acreditado y comprador.                      |
| `auction.product.claimed.v1`   | Inventory confirmó la entrega y el pending claim cambió a `CLAIMED` en el mismo commit.       | `auction:<auctionId>:product-claimed` | Ganador.                                              |

El settlement con ganador añade `captureOperationId`, referencia de la
operación de Wallet que acreditó al vendedor. La entrega de producto usa como
correlación `auction:<auctionId>:inventory:claim`.

## Límites

- Los avisos de cierre anticipado de HU-64.5 a otros postores permanecen en
  su circuito existente; no se duplican aquí.
- Un rechazo, timeout o estado pendiente de Wallet/Inventory no crea estos
  eventos de éxito.
- Notifications deduplica por el identificador determinista de cada aviso.
