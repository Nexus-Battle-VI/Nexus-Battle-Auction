# HU-89 — Actividad e historial personal de subastas

## Alcance de esta PR

Esta PR implementa exclusivamente TASK 89.1, TASK 89.2 y TASK 89.3 en Auction. Las consultas toman el propietario desde `VerifiedIdentity.subject`; no aceptan un identificador de usuario del cliente.

| Endpoint                                              | Resultado                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /v1/auctions/me/owned?page=1&pageSize=16`        | Publicaciones propias, estados, precios, cierre, pujas agregadas y acciones informativas.                        |
| `GET /v1/auctions/me/bids?page=1&pageSize=16`         | Una participación por subasta con estado `LEADING`, `OUTBID`, `WON` o `LOST`; no expone identidades de terceros. |
| `GET /v1/auctions/me/transactions?page=1&pageSize=16` | Operaciones autoritativas de publicación, puja, compra inmediata, liquidación, cancelación y reclamo.            |
| `GET /v1/auctions/me/view-statistics`                 | `UNAVAILABLE / AUTHORITATIVE_SOURCE_NOT_CONFIGURED`; no devuelve un contador ficticio.                           |

La acción `cancel` de “Mis subastas” es informativa y reutiliza las condiciones persistidas de HU-90. La autorización y validación definitiva siguen en el endpoint de cancelación de HU-90.

## Fuentes autoritativas

- Publicaciones: `auction_publication_operations` y `auctions`.
- Pujas: `auction_bids` y `auction_bid_credit_operations`.
- Compra inmediata: `auction_buy_now_operations`.
- Liquidaciones: `auction_settlements`.
- Reembolsos de cancelación: `auction_cancellations`.
- Reclamos: `auction_pending_claims`.
- Visualizaciones: no existe tabla, evento, puerto o contrato aprobado en Auction al realizar el discovery. Por ello el contrato comunica indisponibilidad.

## Registro de cambios

- Se creó un puerto de lectura hexagonal independiente, sus casos de uso y el adaptador PostgreSQL.
- El adaptador en memoria implementa el mismo contrato para desarrollo y pruebas.
- Se añadieron cuatro rutas privadas al controlador existente y sus contratos OpenAPI.
- Se añadieron pruebas unitarias, HTTP y PostgreSQL con dos identidades distintas.
- No se modificaron Watchlist (HU-68), Pending Claims (HU-69) ni la operación de cancelación (HU-90).
