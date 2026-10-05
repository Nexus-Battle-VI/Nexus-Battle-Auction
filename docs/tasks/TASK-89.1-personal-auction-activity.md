# TASK 89.1 — Consultas personales de actividad

## Resultado

Se añadieron “Mis subastas” y “Mis pujas” con paginación estable. El controlador construye siempre `playerId` desde `identity.subject`; `playerId` en query es rechazado por validación.

“Mis subastas” incluye estado, producto, precios, puja vigente, cantidad de pujas, fechas y acciones permitidas. “Mis pujas” devuelve solamente la oferta propia más reciente y el importe líder, sin identificadores de otros jugadores.

## Changelog / Registro de cambios

- Creado `AuctionActivityRepositoryPort.ts` como puerto de lectura.
- Creado `GetMyAuctionActivity.ts` para las dos consultas personales.
- Añadidas proyecciones PostgreSQL y memoria con aislamiento por vendedor/pujador.
- Añadidos endpoints `me/owned` y `me/bids`, DTO de paginación y documentación Swagger.
- Añadidas pruebas positivas, vacías, negativas, de roles, paginación y aislamiento.

Commit propuesto: `feat(auction): add personal auction activity queries #544`
