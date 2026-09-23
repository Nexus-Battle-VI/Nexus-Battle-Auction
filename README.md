# Nexus-Battle-Auction

Servicio de Nexus Battles VI para el bounded context **Auction**: subastas, pujas, liquidación y reclamo.

Implementa el mercado de subastas entre jugadores: publicación, pujas, compra inmediata, puja automática, seguimiento, liquidación al vencer y reclamo de lo ganado.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Decisión que lo crea:** [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (`Accepted`)
- **Épicas:** [EPIC-07 Subasta](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/7)
- **Team propietario:** Team Gama
- **Arquitectura interna:** Clean + Hexagonal ([ADR-002](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-002-backend-stack.md))
- **Base de datos:** PostgreSQL, propia y exclusiva ([ADR-005](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-005-data-strategy.md))
- **Puerto:** 3008

## Estado

**Andamiaje desplegado.** Desde el 2026-09-16 corre en producción en el nodo `app` y Caddy le envía `https://nexus.simuladorupbbga.app/api/v1/auctions*`. Arranca, verifica identidad, firma y comprueba el contrato interno, expone sus sondas y conecta con su base, que ya existe con usuario propio.

**No tiene todavía ninguna ruta de negocio ni ninguna tabla o colección**: las añade cada Historia de Usuario. Mientras tanto, cualquier ruta bajo ese prefijo responde `404` desde NestJS.

## Qué posee este contexto

- Subastas: vendedor, producto, duración, precio mínimo, compra inmediata, estado y vencimiento.
- Pujas y pujas automáticas con su límite.
- Listas de seguimiento.
- Liquidaciones y productos pendientes de reclamo (plazo de siete días).

Ningún otro servicio accede a este almacén, ni directamente ni con claves foráneas.

## Historias de Usuario que viven aquí

| HU    | Historia                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| HU-62 | [Publicación de producto en subasta](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/47)              |
| HU-63 | [Registro de puja](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/48)                                |
| HU-64 | [Compra inmediata](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/49)                                |
| HU-65 | [Finalización y liquidación de subasta](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/50)           |
| HU-66 | [Publicación de producto por el Maestro de Juego](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/51) |
| HU-67 | [Configuración de puja automática](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/52)                |
| HU-68 | [Lista de seguimiento de subastas](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/53)                |
| HU-69 | [Reclamo de productos ganados en subasta](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/54)         |

## Integraciones previstas

- **Wallet** (síncrono, `operationId`): comisión de publicación, reserva por puja, captura al liquidar, liberación al ser superada.
- **Player/Inventory** (síncrono, `operationId`): comprometer el producto al publicar, consumirlo al liquidar, liberarlo sin pujas y entregarlo al reclamar.
- **Catalog** (síncrono): condición de comercialización del producto (premium restringido).
- **Notifications** (ingesta HTTP): puja superada, cierre próximo, liquidación, vencimiento del reclamo.

Detalle en [docs/architecture.md](docs/architecture.md).

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, políticas y eventos
  application/       Casos de uso, puertos, DTO y errores
  adapters/
    inbound/http/    Controladores, DTO HTTP y guards
    outbound/        Persistencia, identidad, clientes de otros servicios
  infrastructure/    config, observabilidad, salud, persistencia y composición
```

El dominio no importa NestJS, drivers ni adaptadores, y la aplicación depende solo de sus puertos: lo impide ESLint en CI. Los casos de uso son clases sin decoradores registradas con fábricas en `src/infrastructure/bootstrap/app.module.ts`.

## Verificación local

La matriz y los resultados reproducibles de HU-62 están en [docs/hu-62-acceptance-evidence.md](docs/hu-62-acceptance-evidence.md).
La identidad dedicada de UPB-COMPANY para HU-66 está definida en [docs/hu-66-game-master-identity.md](docs/hu-66-game-master-identity.md).

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run test:db        # requiere Docker: levanta PostgreSQL con Testcontainers
npm run build
```

Cobertura mínima del **80 %** en ambas suites; por debajo, el comando falla.

## Configuración

Ver [.env.example](.env.example). Las reglas que hacen fallar el arranque son deliberadas:

| Situación                                             | Resultado                |
| ----------------------------------------------------- | ------------------------ |
| `NODE_ENV=production` con `AUTH_MODE=disabled`        | **No arranca** (ADR-004) |
| `NODE_ENV=production` con `PERSISTENCE_DRIVER=memory` | **No arranca** (ADR-019) |
| `PERSISTENCE_DRIVER=postgres` sin `DATABASE_URL`      | **No arranca**           |
| `AUTH_MODE=jwt` sin pool o cliente                    | **No arranca**           |

El scheduler de settlement está deshabilitado por defecto
(`AUCTION_SETTLEMENT_SCHEDULER_ENABLED=false`). Al habilitarlo, espera el primer
intervalo (`AUCTION_SETTLEMENT_POLL_INTERVAL_MS=5000`) antes de procesar. Usa
lotes de 25, concurrencia 4, un lease durable de cinco minutos y 30 segundos
entre reintentos. El lease y `SKIP LOCKED` protegen múltiples instancias; el
scheduler evita solapamientos locales y `SettleAuction` conserva la idempotencia
como segunda barrera.

## Identidad y autorización

- **Toda ruta nace protegida.** El guard es global; abrir una ruta exige `@Public()`.
- La identidad sale del token de acceso verificado contra el JWKS del pool (`aws-jwt-verify`), nunca del cuerpo ni de la URL.
- `@Roles(...)` restringe por rol; `SUPER_ADMINISTRATOR` satisface lo que se exige a `ADMINISTRATOR`, y no al revés.
- Las rutas `@InternalOnly()` exigen firma HMAC-SHA256 (`x-internal-service`, `x-internal-timestamp`, `x-internal-signature`) de un servicio de la lista `INTERNAL_CALLERS`. Sin secreto configurado responden `503`. Caddy bloquea `/api/internal*` desde fuera.

## Sondas

| Ruta                    | Semántica                                     |
| ----------------------- | --------------------------------------------- |
| `GET /api/health/live`  | El proceso responde. No consulta dependencias |
| `GET /api/health/ready` | Hace ping a PostgreSQL. `503` si no responde  |
| `GET /api/version`      | Servicio, versión y entorno                   |

## Ramas

`main` y `develop` están protegidas. Todo Pull Request va a **`develop`**; `main` solo recibe la promoción completa de `develop`, y el workflow `Flujo de ramas` lo hace cumplir. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

Licensing pending project governance.
