# TASK 68.2 — Casos de uso y API de seguimiento

Historia: HU-68 — Lista de seguimiento de subastas.<br>
Referencia: `Refs Nexus-Battle-VI/Nexus-Battle-Management#53`.

## Resultado funcional

El jugador autenticado puede seguir una subasta activa, consultar su lista enriquecida con el estado actual de cada subasta y retirar un seguimiento. La identidad procede exclusivamente del `subject` validado por JWT; el contrato no acepta `playerId` en cuerpo, ruta ni query.

| Operación                                       | Resultado                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `POST /api/v1/auctions/watchlist`               | Crea el seguimiento y responde `201`.                            |
| `GET /api/v1/auctions/watchlist`                | Devuelve exclusivamente la lista del jugador autenticado.        |
| `DELETE /api/v1/auctions/watchlist/{auctionId}` | Retira la relación propia de forma idempotente y responde `204`. |

Solo pueden agregarse subastas existentes, `ACTIVE` y con `now < closesAt`. La igualdad exacta con el cierre se rechaza. Los seguimientos ya creados permanecen consultables y eliminables después del cierre.

## Respuestas verificadas

Alta exitosa:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{"auctionId":"auction-1","followedAt":"2026-09-21T12:00:00.000Z"}
```

Duplicado concurrente:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{"statusCode":409,"code":"WATCHLIST_ALREADY_EXISTS","message":"Ya sigues esta subasta."}
```

Subasta en el instante de cierre:

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{"statusCode":422,"code":"AUCTION_NOT_FOLLOWABLE","message":"Solo se pueden seguir subastas activas cuyo plazo no haya vencido."}
```

Un error de persistencia responde `503 WATCHLIST_UNAVAILABLE` sin exponer mensajes internos. Las solicitudes sin token reciben `401`, y una identidad sin rol `PLAYER` recibe `403`.

## TDD y validación

La fase Red se ejecutó antes de crear los casos de uso y el adaptador HTTP: fallaron las suites por módulos ausentes y los 26 escenarios HTTP. Una prueba adicional reprodujo una carrera temporal en la que la subasta vencía durante la consulta; el caso de uso se corrigió para consultar `ClockPort` después de leer la subasta.

Resultado Green/Refactor:

| Verificación                     |                 Resultado |
| -------------------------------- | ------------------------: |
| Pruebas específicas de TASK 68.2 |  46 aprobadas, 0 fallidas |
| Suite completa sin PostgreSQL    | 331 aprobadas, 0 fallidas |
| Sentencias                       |                   95,04 % |
| Ramas                            |                   89,59 % |
| Funciones                        |                   92,37 % |
| Líneas                           |                   95,04 % |
| ESLint                           |                  Aprobado |
| TypeScript                       |                  Aprobado |

Las pruebas cubren autenticación, roles, aislamiento entre jugadores, DTOs estrictos, inexistencia, estados no elegibles, frontera temporal, duplicidad concurrente, baja idempotente, errores sanitizados y contrato OpenAPI.

## Changelog / Registro de cambios

### Creados

| Archivo                                               | Cambio                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `src/domain/value-objects/WatchlistPlayerId.ts`       | Identificador validado para la identidad propietaria.            |
| `src/domain/services/watchlist-eligibility.ts`        | Regla pura de estado y cierre para nuevos seguimientos.          |
| `src/application/dto/WatchlistDto.ts`                 | Contratos de salida de aplicación.                               |
| `src/application/use-cases/FollowAuction.ts`          | Alta con existencia, elegibilidad, reloj y unicidad persistente. |
| `src/application/use-cases/ListFollowedAuctions.ts`   | Consulta privada y enriquecida con snapshots actuales.           |
| `src/application/use-cases/UnfollowAuction.ts`        | Baja privada e idempotente.                                      |
| `src/adapters/inbound/http/watchlist.dto.ts`          | DTOs HTTP estrictos y documentación Swagger.                     |
| `src/adapters/inbound/http/watchlist-error.mapper.ts` | Traducción estable y sanitizada de errores.                      |
| `src/adapters/inbound/http/watchlist.controller.ts`   | Endpoints REST protegidos para el jugador.                       |
| `test/unit/watchlist-use-cases.spec.ts`               | Reglas, fronteras, aislamiento y errores de aplicación.          |
| `test/integration/watchlist-http.spec.ts`             | Seguridad, HTTP, concurrencia y OpenAPI con Nest/Supertest.      |
| `docs/tasks/TASK-68.2-watchlist-api.md`               | Evidencia y decisiones de esta tarea.                            |

### Modificados

| Archivo                                             | Cambio                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/domain/entities/WatchlistEntry.ts`             | Reutiliza el value object de jugador para una única regla de validación.                                     |
| `src/adapters/inbound/http/auth/decorators.ts`      | Metadato para rutas que requieren identidad aun en modo local.                                               |
| `src/adapters/inbound/http/auth/anonymous.guard.ts` | Cierre seguro de rutas privadas con autenticación deshabilitada.                                             |
| `src/infrastructure/bootstrap/app.module.ts`        | Controlador y fábricas explícitas de los tres casos de uso; ruta estática registrada antes de `/:auctionId`. |
| `src/main.ts`                                       | Esquema Bearer registrado en OpenAPI.                                                                        |

No se añadieron eventos, recordatorios, consumidores de Notifications ni interfaz Web; pertenecen a TASK 68.3–68.5.

## Decisiones

- `DELETE` es idempotente y no revela si existía una relación de otro jugador.
- La lista conserva subastas vencidas y consulta su snapshot actual; esta tarea no incorpora borrado automático.
- La API no permite identidad anónima aunque `AUTH_MODE=disabled` se use durante desarrollo.
- La elegibilidad se valida en el instante posterior a la lectura de la subasta para evitar aceptar una que venció durante una consulta lenta.
- Los errores internos se convierten en una respuesta estable sin filtrar SQL, credenciales ni mensajes de infraestructura.

## Commit preparado

```text
feat(auction): add authenticated watchlist use cases and API #TASK-68.2
```
