# HU-63 — Evidencia de aceptación de pujas

Referencia: [HU-63](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/48) · [Task 63.7](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/321)

## Matriz de trazabilidad

| Criterio     | Escenario comprobado                                                                     | Prueba principal                                                   | Estado                                            |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| CA-01        | Puja válida queda líder y se solicita reserva de créditos                                | `test/integration/register-bid-acceptance.spec.ts` — CP-01         | Pasa con repositorio en memoria y doble de Wallet |
| CA-02        | Monto igual al líder y monto inferior al incremento mínimo se rechazan sin nueva reserva | `test/integration/register-bid-acceptance.spec.ts` — CA-02 y CA-03 | Pasa con repositorio en memoria                   |
| CA-03        | El vendedor no puede pujar en su propia subasta; no se reserva crédito                   | `test/integration/register-bid-acceptance.spec.ts` — CA-02 y CA-03 | Pasa con repositorio en memoria                   |
| CA-04        | Dos pujas del mismo jugador: rechazo a 4,999 s y aceptación a 5,000 s                    | `test/integration/register-bid-acceptance.spec.ts` — CP-02         | Pasa con reloj controlado                         |
| CA-05        | Al ser superado, se libera la reserva anterior antes de emitir la notificación           | `test/integration/register-bid-acceptance.spec.ts` — CP-01         | Pasa con dobles de Wallet y Notifications         |
| CA-06        | Acepta la puja activa número 50; rechaza la número 51 sin reservar                       | `test/integration/register-bid-acceptance.spec.ts` — CA-06         | Pasa con repositorio en memoria                   |
| Concurrencia | Dos pujas simultáneas dejan un líder y una reserva activa; la otra se libera             | `test/db/postgres-database.spec.ts` — concurrencia y créditos      | Pasa con PostgreSQL real y doble de Wallet        |

Pruebas complementarias: `test/unit/bid-domain.spec.ts`, `test/unit/register-bid.spec.ts`, `test/unit/persist-bid-with-credits.spec.ts`, `test/integration/service-http.spec.ts`. Los casos de fallo parcial y reintento duradero están en `persist-bid-with-credits.spec.ts` y `postgres-database.spec.ts`.

## Ejecución local

Fecha: 2026-09-22. Rama: `hu63.7`. Comandos comunicados desde el entorno local de desarrollo:

| Comando                                   | Resultado                                                          |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `npm run test:unit -- --runInBand`        | 14 suites; 193 pruebas aprobadas                                   |
| `npm run test:integration -- --runInBand` | 4 suites; 70 pruebas aprobadas                                     |
| `npm run test:db -- --runInBand`          | 1 suite; 32 pruebas aprobadas contra PostgreSQL                    |
| `npm run test:coverage -- --runInBand`    | 18 suites; 263 pruebas aprobadas; líneas 94,35 %; ramas 88,91 %    |
| `npm run typecheck`                       | Aprobado                                                           |
| `npm run lint`                            | Aprobado                                                           |
| `npm run format:check`                    | Aprobado después de aplicar Prettier a los dos archivos de pruebas |
| `npm run build`                           | Aprobado                                                           |

## Evidencia pendiente antes del cierre

- Medir latencia de `POST /api/v1/auctions/:auctionId/bids` con solicitudes válidas, tokens de jugadores y subastas preparadas en un entorno aislado con PostgreSQL y dependencias funcionales. Registrar tamaño de muestra, concurrencia, p95, tasas de éxito y configuración de hardware. Criterio: p95 menor a 500 ms. Los tiempos de Jest no miden este indicador.
- Confirmar que la suite completa y el pipeline del PR pasan en CI. Adjuntar enlaces del run y del reporte de cobertura.
- Verificar, si se dispone del entorno integrado, el estado final de Wallet y la entrega de Notifications. Las pruebas locales usan dobles de esos servicios.
