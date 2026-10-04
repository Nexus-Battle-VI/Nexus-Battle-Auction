# TASK 89.2 — Historial personal de transacciones

## Resultado

`GET /v1/auctions/me/transactions` presenta registros persistidos por Auction con identificador estable, tipo, referencia, fecha, estado y valor original en créditos. La consulta es de solo lectura y se filtra por la identidad autenticada.

## Changelog / Registro de cambios

- Creado `GetMyAuctionTransactions.ts`.
- Implementada una proyección paginada sobre las tablas autoritativas de publicación, puja, compra inmediata, liquidación, cancelación y reclamo.
- Conservada la unidad `CREDITS`; los valores ausentes se representan como `null`.
- Añadido contrato HTTP/OpenAPI y pruebas de historial vacío, múltiples fuentes y aislamiento.

Commit propuesto: `feat(auction): expose personal transaction history #545`
