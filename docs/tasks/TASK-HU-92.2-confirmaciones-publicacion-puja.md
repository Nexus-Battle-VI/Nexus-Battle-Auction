# TASK HU-92.2 — Confirmaciones de publicación y puja

Auction conserva los eventos confirmados en `outbox_events` y los entrega por
HTTP interno firmado a Notifications. El despacho sólo se activa con
`AUCTION_CONFIRMATION_DISPATCH_ENABLED=true`, PostgreSQL, `NOTIFICATIONS_BASE_URL`
y `INTERNAL_SERVICE_AUTH_SECRET`.

## Contratos

- `auction.published` v1: una notificación `AUCTION_PUBLISHED` dirigida al vendedor.
- `auction.bid.accepted` v1: `AUCTION_NEW_BID` para el vendedor y
  `AUCTION_BID_ACCEPTED` para el postor.

La identidad del evento es durable: publicación por operación y puja por
`<operationId>:bid-accepted`. Un fallo de Notifications deja el evento sin
`published_at`; el scheduler lo reintenta sin revertir la operación de negocio.

El receptor es `POST /api/internal/v1/notifications/auction/confirmations`.
La firma HMAC enlaza servicio, método, ruta, timestamp y cuerpo.
