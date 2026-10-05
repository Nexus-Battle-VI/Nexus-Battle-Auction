# TASK 89.5 — QA / Security backend de HU-89

## Objetivo

Validar que los contratos personales creados en TASK 89.1, TASK 89.2 y TASK 89.3 mantienen autorización, aislamiento e integridad. Esta tarea solo añade evidencia automatizada y documentación; no modifica casos de uso, controladores ni adaptadores productivos.

## Escenarios de seguridad

| Escenario                                             | Evidencia automatizada                                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usuario A y Usuario B reciben únicamente su actividad | Pruebas HTTP con ambos tokens y pruebas de repositorio con registros mezclados.                                                                                  |
| Solicitud sin autenticación                           | Los cuatro endpoints responden `401`.                                                                                                                            |
| Token inválido                                        | La consulta privada responde `401`.                                                                                                                              |
| Rol distinto de `PLAYER`                              | Los cuatro endpoints responden `403`.                                                                                                                            |
| Intento de seleccionar otra identidad                 | `userId`, `playerId`, `sellerId` y `bidderId` reciben `400` en las consultas paginadas. Estadísticas ignora esos parámetros y conserva el resultado no personal. |
| Paginación aislada                                    | El filtro por identidad ocurre antes de `limit` y `offset`; se comprueban dos páginas del Usuario A junto con datos del Usuario B.                               |
| Privacidad de terceros                                | Las respuestas no contienen `sellerId`, `bidderId` ni `leaderBidderId`.                                                                                          |
| Integridad del historial                              | Solo aparecen operaciones persistidas cuyo vendedor, pujador, comprador, ganador o reclamante coincide con el sujeto consultado.                                 |
| Estadísticas sin fuente                               | Responde `UNAVAILABLE / AUTHORITATIVE_SOURCE_NOT_CONFIGURED` y `metrics: []`, sin convertir ausencia en cero.                                                    |
| Regresiones                                           | Se ejecutan las suites completas unitarias y de integración, además de lint, tipos, formato, cobertura y build.                                                  |

## Arquitectura y límites

- La frontera HTTP toma la identidad exclusivamente de `VerifiedIdentity.subject`.
- `PersonalAuctionActivityQueryDto` solo admite `page` y `pageSize`; el `ValidationPipe` rechaza propiedades externas.
- Los adaptadores en memoria y PostgreSQL filtran por identidad antes de paginar.
- Se reutilizan los contratos y casos de uso de TASK 89.1–89.3.
- No se modifican Watchlist (HU-68), Pending Claims (HU-69) ni cancelación (HU-90).
- No se incorporan datos simulados al código productivo.

## Archivos de prueba

- `test/integration/personal-auction-activity-http.spec.ts`: autenticación, autorización, suplantación por query string y selección por `subject`.
- `test/unit/in-memory-auction-activity.spec.ts`: aislamiento, paginación, historial y privacidad en el adaptador de desarrollo.
- `test/db/personal-auction-activity-postgres.spec.ts`: las mismas garantías esenciales contra PostgreSQL real.

## Resultados y cobertura

| Control                    | Resultado local                                                         |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run test:unit`        | 75 suites y 1006 pruebas aprobadas                                      |
| `npm run test:integration` | 22 suites y 341 pruebas aprobadas                                       |
| `npm run test:coverage`    | 97 suites y 1347 pruebas aprobadas                                      |
| Cobertura global           | 93.44 % statements, 86.94 % branches, 90.92 % functions y 94.17 % lines |
| `npm run typecheck`        | Aprobado, sin errores                                                   |
| `npm run lint`             | Aprobado, sin hallazgos                                                 |
| `npm run format:check`     | Aprobado, sin diferencias                                               |
| `npm run build`            | Aprobado                                                                |

La suite PostgreSQL requiere Docker/Testcontainers. En el entorno local sin runtime de contenedores, `npm run test:db -- --runInBand test/db/personal-auction-activity-postgres.spec.ts` falla al iniciar infraestructura con `Could not find a working container runtime strategy`, antes de ejecutar una aserción. El workflow de GitHub ejecuta `npm run test:db` en Ubuntu con Docker y constituye la validación autoritativa de estos escenarios.

Jest también informa que un worker de la suite completa debe cerrarse de forma forzada por un temporizador ya existente. El proceso finaliza con código `0`, las 1347 pruebas pasan y este cambio no añade timers ni recursos en ejecución.

## Changelog / Registro de cambios

- Ampliada la matriz HTTP para ambos usuarios, cuatro parámetros de suplantación y todos los endpoints privados.
- Añadidas pruebas de token inválido y autorización por endpoint.
- Añadidas pruebas de paginación aislada e historial autoritativo en memoria.
- Ampliadas las pruebas PostgreSQL para Usuario A y Usuario B, paginación y ausencia de identificadores de terceros.
- Actualizada la trazabilidad técnica de HU-89.

Commit propuesto: `test(auction): validate HU-89 personal activity security`

Trazabilidad: `Refs Nexus-Battle-VI/Nexus-Battle-Management#520` y `Closes Nexus-Battle-VI/Nexus-Battle-Management#548`.
