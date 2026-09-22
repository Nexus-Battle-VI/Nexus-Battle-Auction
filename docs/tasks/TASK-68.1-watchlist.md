# TASK 68.1 — Modelo y persistencia de seguimiento

- Historia: HU-68, lista de seguimiento de subastas.
- Trazabilidad: Refs Nexus-Battle-VI/Nexus-Battle-Management#53.
- Fecha de validación local: 2026-09-21.
- Base: `8bb83a3`, rama existente `feature/TASK-68-1-watchlist-model`, alineada con `develop` al iniciar.
- Estado: implementación y validación local terminadas; pendiente revisión/CI del PR. No cierra HU-68 ni acredita despliegue productivo.

## Alcance y decisiones

La relación se identifica por `(playerId, auctionId)` y conserva `followedAt`. No necesita un ID artificial. Auction es su propietario; no hay tablas ni claves foráneas en Account o Player-Inventory.

`WatchlistEntry.create` valida el identificador del jugador con la convención existente de Auction (1–128 caracteres ASCII, extremos alfanuméricos), reutiliza `AuctionId`, normaliza espacios exteriores y rechaza una fecha inválida. La fecha es explícita: TASK 68.2 deberá obtenerla de `ClockPort`; no se consulta el reloj del sistema en el dominio. Las instantáneas copian la fecha para evitar mutaciones externas.

`WatchlistRepositoryPort` define:

| Operación                     | Semántica                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `create(entry)`               | Inserta una relación; un duplicado produce `WatchlistAlreadyExistsError`, incluso concurrentemente. |
| `find(playerId, auctionId)`   | Recupera la pareja exacta o `null`.                                                                 |
| `listByPlayer(playerId)`      | Devuelve solo ese jugador, fecha descendente y `auctionId` ascendente para empates.                 |
| `delete(playerId, auctionId)` | Elimina la pareja y devuelve si existía; repetir la eliminación devuelve `false`.                   |

Las identidades recibidas por las consultas del puerto deben ser canónicas. El puerto no autentica: obtener el jugador desde JWT y aplicar autorización pertenece a TASK 68.2. La lista aún no pagina; una API posterior deberá decidir límites/paginación si su volumen lo requiere.

Los adaptadores conservan integridad referencial local. Memoria consulta `AuctionRepositoryPort.findById`; PostgreSQL usa FK a `auctions.id` con `ON DELETE RESTRICT`. Ambos traducen ausencia de subasta a `PersistedAuctionNotFoundError`. No se valida estado ACTIVE aquí: esa elegibilidad corresponde a los casos de uso de TASK 68.2.

La migración `003-create-auction-watchlist` crea:

- Tabla `auction_watchlist` con `player_id`, `auction_id` y `followed_at`, todos obligatorios.
- Clave primaria compuesta `auction_watchlist_pkey`, que arbitra concurrencia en el motor, sin un vulnerable read-before-write.
- FK `auction_watchlist_auction_fk` dentro del contexto Auction.
- Restricciones de formato de jugador y fecha finita; la fecha se almacena como `timestamptz`.
- Índice por `auction_id` para búsquedas/integridad por subasta.

El adaptador PostgreSQL traduce únicamente los SQLSTATE y nombres de restricciones conocidos. Una caída de conexión conserva su error de infraestructura. El adaptador en memoria usa una clave serializada como pareja para evitar colisiones con separadores válidos de IDs; tras comprobar existencia no intercala `await` entre verificar duplicado y escribir. PostgreSQL fija collation `C` para hacer coincidir el orden de IDs con memoria.

`AppModule` registra `WATCHLIST_REPOSITORY` usando el mismo `DATABASE` del servicio. La migración se incorpora al registro explícito y se ejecuta con `npm run migrate`; no se migra automáticamente al arrancar.

## Evidencia TDD: Red → Green → Refactor

1. **Red:** se escribieron primero las pruebas de dominio, contrato compartido de repositorios, PostgreSQL y composición, sin archivos de implementación. `npm test -- --runInBand --testPathPatterns=watchlist` terminó con código 1: **3 suites fallidas, 0 casos ejecutados**, por TS2307 (módulos nuevos todavía inexistentes). La prueba DB también falló por las referencias ausentes. Fue un rojo de compilación, no fallos de aserciones de negocio.
2. **Green:** se implementaron entidad, puerto, error, adaptadores, migración y registro. Pasaron inicialmente **22 pruebas** de dominio/memoria/composición. La prueba del rollback detectó incompatibilidad entre `Kysely<Database>` y `Kysely<unknown>`; las funciones de migración se hicieron genéricas para aceptar ambos sin casts inseguros. PostgreSQL pasó a verde con restricciones reales y concurrencia.
3. **Refactor/verificación:** el contrato de comportamiento es compartido por memoria/PostgreSQL; se añadió una regresión de orden independiente del orden de inserción. Se formatearon únicamente los archivos de la tarea y se incluyó el DDL nuevo en la medición de cobertura DB. No se redujeron umbrales ni se deshabilitaron pruebas.

La preparación utilizó una copia del árbol base en `C:/Users/sasto/Nexus-Battle-Catalog/task-68-1-auction/work` por el límite de escritura del workspace; las dependencias se instalaron con `npm ci` desde el lockfile existente. No cambian `package.json` ni `package-lock.json`. Docker Desktop ejecutó PostgreSQL 17 Alpine mediante Testcontainers; los contenedores se destruyen al terminar. Ninguna prueba usa una base de negocio ni credenciales productivas.

### Resultado final

`typecheck`, `lint`, `format:check` y `build` finalizaron con código 0. El formato se volvió a verificar después de añadir este documento.

| Conjunto                                    | Suites |   Pasan | Fallan | Omitidas |
| ------------------------------------------- | -----: | ------: | -----: | -------: |
| Unitarias + integración de composición/HTTP |     15 |     204 |      0 |        0 |
| PostgreSQL real                             |      2 |      36 |      0 |        0 |
| Total                                       |     17 | **240** |  **0** |    **0** |

Hay **42 casos nuevos**: 11 de dominio, 10 del contrato en memoria, 2 de composición y 19 contra PostgreSQL. Los demás son regresiones existentes de Auction.

| Cobertura RNF-16                     | Sentencias |   Ramas | Funciones |  Líneas |
| ------------------------------------ | ---------: | ------: | --------: | ------: |
| General                              |    96,75 % | 91,83 % |   92,85 % | 96,81 % |
| PostgreSQL, incluyendo migración 003 |    97,65 % | 86,04 % |     100 % | 97,52 % |

Las pruebas demuestran: duplicidad secuencial sin sobrescribir fecha, ocho altas concurrentes con exactamente una exitosa y siete conflictos, aislamiento entre jugadores, eliminación/reseguimiento, copias defensivas, orden estable, persistencia tras recrear conexión/repositorio, rechazo SQL directo de duplicados/IDs inválidos/fechas infinitas, ausencia de subasta, propagación de fallo de conexión y rollback/reaplicación de la migración conservando subastas. El migrador vuelve a ejecutarse sin repetir migraciones registradas.

Comandos de reproducción (Node 24, npm >=11 y Docker disponible):

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage -- --runInBand
npm run test:db -- --runInBand
npm run build
```

La auditoría generó además JSON de cobertura DB mediante `--coverageReporters=json-summary`; ese artefacto se guardó fuera de la copia del repo para no incorporarlo a fuentes ni interferir con Prettier. Logs locales: `task-68-1-auction/red.log`, `red-db.log`, `green.log`, `coverage.log`, `db.log`; reporte adicional `coverage-db-summary.json`. El reporte general queda en `work/coverage/coverage-summary.json`.

### Operación y rollback

Aplicar el artefacto compilado con `DATABASE_URL` de Auction y `PERSISTENCE_DRIVER=postgres` usando `npm run migrate`. La migración fue aplicada y revertida **solo en PostgreSQL desechable de pruebas**. El `down` elimina la tabla y por tanto sus seguimientos; requiere respaldo/decisión operativa antes de usarlo sobre datos reales. No elimina subastas ni pujas. La tarea no despliega ni aplica migraciones productivas.

## Changelog / Registro de Cambios

### Archivos creados

| Archivo                                                                        | Cambio                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `src/domain/entities/WatchlistEntry.ts`                                        | Relación con invariantes, fecha explícita e instantáneas defensivas. |
| `src/application/ports/WatchlistRepositoryPort.ts`                             | Puerto y token de composición; semántica documentada por operación.  |
| `src/application/errors/WatchlistAlreadyExistsError.ts`                        | Conflicto de duplicidad independiente de SQL/HTTP.                   |
| `src/adapters/outbound/persistence/InMemoryWatchlistRepository.ts`             | Doble en memoria con unicidad e integridad local.                    |
| `src/adapters/outbound/persistence/PostgresWatchlistRepository.ts`             | Persistencia Kysely y traducción controlada de errores.              |
| `src/adapters/outbound/persistence/migrations/003-create-auction-watchlist.ts` | Tabla, PK, FK, checks e índice; up/down documentados.                |
| `test/unit/watchlist-domain.spec.ts`                                           | Invariantes, frontera y mutabilidad de fecha.                        |
| `test/unit/watchlist-memory.spec.ts`                                           | Contrato aplicado al doble en memoria.                               |
| `test/support/watchlist-contract.ts`                                           | Casos observables comunes para ambos adaptadores.                    |
| `test/support/watchlist-auction.ts`                                            | Publicaciones válidas de HU-62 usadas por las pruebas.               |
| `test/db/postgres-watchlist.spec.ts`                                           | Motor real, concurrencia, restricciones y rollback.                  |
| `test/integration/watchlist-composition.spec.ts`                               | Selección real de proveedores de AppModule.                          |
| `docs/tasks/TASK-68.1-watchlist.md`                                            | Este registro, decisiones y evidencia.                               |

### Archivos modificados

| Archivo                                       | Cambio                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `src/adapters/outbound/persistence/schema.ts` | Tipado `AuctionWatchlistTable` y alta en `Database`.                    |
| `src/infrastructure/persistence/database.ts`  | Registro explícito de migración 003.                                    |
| `src/infrastructure/bootstrap/app.module.ts`  | Factory del puerto watchlist para memoria/PostgreSQL.                   |
| `jest.db.config.ts`                           | Medición del DDL nuevo además de adaptadores y persistencia existentes. |

**Eliminados:** ninguno. No se añadieron endpoints, lógica de recordatorios, consumidores de notificaciones ni interfaz Web.

### Mensajes de commit preparados

Se generan los mensajes solicitados; no se han creado commits ni publicado cambios remotos:

```text
test(auction): [HU-68.1] definir pruebas del modelo y persistencia de seguimiento
feat(auction): [HU-68.1] persistir seguimiento unico por jugador y subasta
docs(auction): [HU-68.1] registrar decisiones y evidencia TDD
```

Referencia para el cuerpo: `Refs Nexus-Battle-VI/Nexus-Battle-Management#53`. No se conoce un número de issue independiente para TASK 68.1; no se inventa `Closes` ni se cierra la HU padre.

### Descripción preparada para PR hacia develop

Implementa el modelo y persistencia de la lista de seguimiento de HU-68. Las altas repetidas o concurrentes para una misma pareja jugador/subasta producen un conflicto controlado y conservan un único registro; consultar y eliminar siempre acota al jugador correspondiente. Incluye memoria, PostgreSQL, migración reversible e integración en AppModule.

Validación: 240 pruebas aprobadas, cobertura superior a 80 % en las cuatro métricas de ambas suites, migración probada contra PostgreSQL real. Requiere aplicar migración 003 antes de utilizar el repositorio en un ambiente desplegado. Los casos de uso/API y la aceptación funcional completa de HU-68 corresponden a tareas posteriores.
