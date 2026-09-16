# Arquitectura de Auction

Fuente de la decisión: [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md).
Este documento describe lo **previsto**; los contratos exactos se publican como OpenAPI en `Nexus-Battle-Infrastructure/docs/contracts` antes de implementarse.

## Responsabilidad

Implementa el mercado de subastas entre jugadores: publicación, pujas, compra inmediata, puja automática, seguimiento, liquidación al vencer y reclamo de lo ganado.

## Datos que posee

- Subastas: vendedor, producto, duración, precio mínimo, compra inmediata, estado y vencimiento.
- Pujas y pujas automáticas con su límite.
- Listas de seguimiento.
- Liquidaciones y productos pendientes de reclamo (plazo de siete días).

Motor: **PostgreSQL**, base lógica `auction` con usuario y credenciales propios en el nodo de datos.

## Invariantes que debe imponer el motor

- Control de concurrencia de pujas con `SELECT ... FOR UPDATE` sobre la subasta.
- `CHECK` sobre importes (`bigint`, positivos) y sobre la relación compra inmediata > precio mínimo.
- Una subasta se liquida una sola vez: la liquidación es idempotente por subasta.
- La hora de vencimiento la fija el servidor; ningún contrato acepta una fecha calculada por el cliente.

## Integraciones

- **Wallet** (síncrono, `operationId`): comisión de publicación, reserva por puja, captura al liquidar, liberación al ser superada.
- **Player/Inventory** (síncrono, `operationId`): comprometer el producto al publicar, consumirlo al liquidar, liberarlo sin pujas y entregarlo al reclamar.
- **Catalog** (síncrono): condición de comercialización del producto (premium restringido).
- **Notifications** (ingesta HTTP): puja superada, cierre próximo, liquidación, vencimiento del reclamo.

Todas las llamadas salientes que mueven créditos o productos siguen el patrón de ADR-019:

1. Persistir la intención con un `operationId` antes de llamar.
2. Reservar en el dueño del recurso con ese `operationId`.
3. Capturar o liberar según el resultado del propio agregado.
4. Toda reserva nace con caducidad; `409` y `503` no autorizan a suponer que la operación no ocurrió: se reintenta con el mismo `operationId`.

## Contrato previsto

- `POST /api/v1/auctions` — publicar.
- `GET /api/v1/auctions` y `GET /api/v1/auctions/{auctionId}` — listado y detalle.
- `POST /api/v1/auctions/{auctionId}/bids` — pujar.
- `POST /api/v1/auctions/{auctionId}/purchase` — compra inmediata.
- `GET /api/v1/auctions/me/winnings` y `POST /api/v1/auctions/me/winnings/claims` — reclamo.

## Temporizadores

Los vencimientos usan un intervalo dentro del proceso, apagado por defecto, con reclamación durable en el almacén (`FOR UPDATE SKIP LOCKED`). El estado vive en la base: un reinicio retrasa un vencimiento, no lo pierde. Mismo patrón que `AccountDeletionProcessingScheduler` en Account.

## Decisiones abiertas

- Las Tasks HU-65.x de Management nombran `Nexus-Battle-Commerce`; deben realinearse a este repositorio si se acepta ADR-019.
- El rol «Maestro de Juego» (HU-66) no existe en el vocabulario de roles de Cognito; hay que definirlo en Account antes de proteger esas rutas.
- El incremento mínimo de puja es configurable según HU-63, pero su valor por defecto no está fijado.
