# Evidencia de aceptación — HU-62

Fecha de ejecución local: 2026-09-21.

## Trazabilidad

| Criterio | Evidencia automatizada                                                                  | Resultado comprobado                                                                                  |
| -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| CA-01    | `publish-auction-acceptance.spec.ts`: casos 24 h y 48 h; `AuctionPage.test.tsx` en Web  | Estado `ACTIVE`, comisión de 1/3 créditos, producto comprometido, cierre calculado y contador visible |
| CA-02    | `publish-auction-acceptance.spec.ts`: saldo cero; `service-http.spec.ts`                | Rechazo `INSUFFICIENT_FUNDS` (422), sin cambio de saldo, bloqueo ni subasta                           |
| CA-03    | `publish-auction-acceptance.spec.ts`, `auction-domain.spec.ts` y `AuctionPage.test.tsx` | Compra inmediata menor o igual a la puja mínima rechazada sin efectos                                 |
| CA-04    | `publish-auction-acceptance.spec.ts`                                                    | Producto ajeno o en uso rechazado sin cobro, bloqueo ni subasta                                       |
| CA-05    | `publish-auction-acceptance.spec.ts` y `service-http.spec.ts`                           | Vendedor sancionado rechazado con `SELLER_SANCTIONED` (403)                                           |
| CA-06    | `publish-auction-acceptance.spec.ts` y `postgres-database.spec.ts`                      | La subasta 11 se rechaza y dos publicaciones concurrentes en el límite dejan exactamente 10 activas   |
| CA-07    | `auction-domain.spec.ts` y `service-http.spec.ts`                                       | El dominio rechaza moneda real y el contrato del jugador no admite el campo `currency`                |

Los casos CP-01 y CP-02 quedan cubiertos respectivamente por la publicación de 48 horas y por el escenario con saldo cero.

## Consistencia e integraciones

- Un reintento con el mismo `Idempotency-Key` conserva una sola subasta, un solo cobro y un solo compromiso de inventario.
- PostgreSQL real comprueba atomicidad de subasta, auditoría y outbox, además de idempotencia y serialización concurrente del límite.
- Los fallos de Catalog, Account, Inventory y Wallet se cierran de forma segura y no crean una subasta.
- Si Inventory falla después del cobro, Wallet recibe la devolución. Si la persistencia falla, se liberan inventario y cobro y se registra el estado de la compensación.
- La ruta exige JWT, rol `PLAYER`, identidad tomada de `sub` y una clave de idempotencia; también cubre 401, 403, 409, 422 y 503.

Auction cuenta con clientes HTTP HMAC contractuales para Catalog, Account (`HttpSellerSanctionClient`), Wallet (`HttpPublicationFeeClient`) e Inventory (`HttpAuctionInventoryClient`). Cada uno se activa solo si están configuradas su URL base (`CATALOG_BASE_URL`, `ACCOUNT_BASE_URL`, `WALLET_BASE_URL`, `INVENTORY_BASE_URL`) y `INTERNAL_SERVICE_AUTH_SECRET`; sin ellas el servicio falla de forma cerrada.

Los escenarios de esta matriz se prueban con dobles fieles a los puertos y con pruebas unitarias de cada cliente contra su contrato. Esta suite no levanta los cuatro servicios reales a la vez, por lo que no equivale a una prueba desplegada entre ellos, pero tampoco deja efectos parciales silenciosos.

## Ejecución reproducible

Desde `Nexus-Battle-Auction`:

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage -- --runInBand
npm run test:db -- --runInBand
npm run build
```

Resultado local:

- suite de dominio, aplicación y HTTP: 11 suites, 155 pruebas aprobadas;
- cobertura: 96.91 % statements, 91.46 % branches, 92.74 % functions y 97.01 % lines;
- PostgreSQL 17 real: 1 suite, 12 pruebas aprobadas;
- cobertura PostgreSQL: 96.92 % statements, 80 % branches, 100 % functions y 100 % lines;
- lint, formato, tipos y compilación: aprobados.

Desde `Nexus-Battle-Web`:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test -- --run
npm run build
```

La evidencia remota de CI debe consultarse en los checks de los PR; este archivo solo registra resultados reproducidos localmente.
