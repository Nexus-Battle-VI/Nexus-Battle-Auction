# TASK HU-92.1 — Auditoría de notificaciones de Subasta

## Trazabilidad

- Task: Nexus-Battle-VI/Nexus-Battle-Management#549.
- Historia: Nexus-Battle-VI/Nexus-Battle-Management#524.
- Épica: EPIC-07 — Subasta.
- Fuente funcional: sección 7.7.8.
- Fecha: 2026-10-03.

## Versiones inspeccionadas

| Repositorio   | Commit base                              |
| ------------- | ---------------------------------------- |
| Auction       | c6ec0f309bbb6a4c65ccbe9e364ac4cbfd453e85 |
| Notifications | e3ec910d2bc5ccc24e13f27c7ec2cbce4b95e741 |

Rama de trabajo en ambos repositorios:
`docs/hu-92.1-auditoria-notificaciones`.

## Método y límites

Inspección de código versionado, búsquedas de referencias y ejecución
de pruebas unitarias existentes en Windows, con Node 24.18.0 y npm 11.16.0.

No se verificó despliegue, integración real entre servicios, entrega
observable en Web ni persistencia real PostgreSQL/MongoDB durante esta
auditoría. La ausencia de coincidencias en una búsqueda no constituye
por sí sola prueba absoluta de ausencia de una capacidad.

## Matriz de avisos requeridos

| Aviso / CA                            | Productor y confirmación                                                                                                                                          | Consumidor / canal encontrado                                                                              | Estado y brecha                                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Publicación al vendedor / CA-01       | PublishAuction delega en PersistAuctionPublication. PostgresAuctionRepository registra auction.published.v1 en el outbox dentro de la transacción de publicación. | No se encontró referencia a ese evento en src, tests ni docs de Notifications.                             | Parcial: evento persistido; despacho y confirmación al vendedor pendientes.                                                                   |
| Nueva puja al vendedor / CA-02        | RegisterBid notifica después de completar PersistBidWithCredits.                                                                                                  | Outbid se dirige al líder anterior; watchlist se dirige a seguidores.                                      | Aviso específico al vendedor no encontrado. Ser seguidor no garantiza cobertura del criterio.                                                 |
| Puja aceptada al postor / CA-02       | RegisterBid devuelve el BidSnapshot de la operación confirmada.                                                                                                   | No se encontró consumidor específico de confirmación al nuevo postor en los flujos revisados.              | Confirmación transaccional mediante Notifications no encontrada. Verificar canal aprobado y experiencia Web.                                  |
| Acreditación al vendedor / CA-03      | SettleAuction requiere captura Wallet confirmada antes de completar settlement. Buy-now transfiere créditos antes de persistir el cierre.                         | HandleAuctionSettledEvent genera aviso al vendedor de venta finalizada.                                    | Parcial: reutilizar settlement; el mensaje no comunica explícitamente acreditación. En buy-now no se encontró aviso específico al vendedor.   |
| Compra inmediata al comprador / CA-04 | TransactionProcessingService devuelve confirmación tras transferencia y cierre persistido.                                                                        | EarlyClosureNotificationService avisa a otros postores y excluye al comprador.                             | Existe respuesta de compra y avisos de cierre; aviso persistente específico al comprador no encontrado. Confirmar alcance del canal aprobado. |
| Producto recibido al ganador / CA-05  | ClaimPendingProduct confirma Inventory antes de markClaimed; un reclamo ya CLAIMED retorna sin repetir Inventory.                                                 | No se encontró emisión de aviso en el caso de uso ni consumidor por los nombres buscados en Notifications. | Brecha probable de confirmación de recepción; verificar otros servicios antes de implementar.                                                 |

## Capacidades reutilizables

| Capacidad          | Identidad / destinatarios                                                                                                    | Recuperación y límite observado                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbid             | notificationId = operationId + ":outbid"; líder anterior distinto del nuevo postor.                                          | RegisterBid captura el fallo; repetir la operación vuelve a intentar con la misma identidad. No se demostró recuperación automática durable.         |
| Watchlist          | eventId estable por operación; destinatarios únicos obtenidos de seguidores. Notifications deriva el ID de evento + jugador. | Fallos no revierten la puja; recuperación automática del productor no demostrada.                                                                    |
| Settlement         | Avisos deterministas por subasta, rol y jugador; vendedor, ganador y perdedores únicos.                                      | Outbox reintentable; consumidor hace ack después del handler. Fallos antes del ack permiten nueva entrega según configuración del transporte.        |
| Cierre por buy-now | operationId = transactionId + ":" + bidderId; comprador excluido.                                                            | Registro de estado e intentos en Auction; retryFailed permite reintentar hasta el límite configurado en código. Activación desplegada no verificada. |

El canal encontrado para los consumidores inspeccionados es la
persistencia de notificaciones in-app mediante CatalogNotification.
No se demostró envío por correo ni aprobación del canal para los
avisos nuevos de HU-92.

## Despacho y configuración

- PostgresAuctionSettlementOutboxRepository selecciona exclusivamente
  `auction.settled.v1`; no despacha `auction.published.v1`.
- AuctionSettlementOutboxDispatcher está registrado en AppModule.
- La búsqueda en package.json, scripts, .github, docs y README.md tampoco encontró referencias de activación del dispatcher. No se inspeccionaron mecanismos externos de Infrastructure.
- No se encontró invocación del dispatcher dentro de `src` mediante
  las búsquedas realizadas. Revisar scripts y mecanismos externos.
- Auction requiere revisar:
  `AUCTION_SETTLEMENT_EVENT_DISPATCH_ENABLED`,
  `AUCTION_SETTLEMENT_QUEUE_URL` y
  `AUCTION_SETTLEMENT_EVENT_DISPATCH_BATCH_SIZE`.
- Notifications invoca
  `auctionSettlementEventsConsumer.processBatch()` desde `worker.ts`.
- Notifications contempla `AUCTION_SETTLEMENT_QUEUE_DRIVER`,
  `AUCTION_SETTLEMENT_QUEUE_URL` y `AWS_REGION`.
- Tener código y configuración declarados no demuestra ejecución
  ni entrega en un ambiente desplegado.

  ## Persistencia e idempotencia verificadas

Notifications dispone de MongoCatalogNotificationRepository, que persiste
las notificaciones en catalog_notifications. El identificador de la
notificación se utiliza como _id y se consulta mediante findById.
Los índices adicionales de sourceEventId y sourceEventType no son únicos.

El bootstrap crea un InMemoryIdempotencyStore. Sus reservas tienen TTL,
no sobreviven a reinicios y no se comparten entre instancias.

CreateAuctionClosedByBuyNowNotification consulta primero la notificación
por operationId y verifica su contenido antes de devolver un resultado
duplicado. Si el documento está persistido en Mongo, esa comprobación
permite reconocer reintentos después de un reinicio.

La unicidad de _id impide documentos duplicados, pero no demuestra por sí
sola que dos solicitudes concurrentes reciban una respuesta satisfactoria.
Queda pendiente validar concurrencia entre instancias y recuperación
ante fallos en HU-92.4.

El contrato de liquidación utiliza eventType: auction.settled y
eventVersion: 1. La identificación auction.settled.v1 se utiliza en
el outbox y como sourceEventType de las notificaciones.

El contrato incluye finalAmountCredits y correlationId, pero no una
referencia explícita de la operación de Wallet. El contrato de cierre
por compra inmediata incluye transactionId.

Esta revisión verifica código y contratos. No se ejecutaron pruebas
con Mongo real, reinicios ni múltiples instancias.

## Evidencia de pruebas ejecutadas

| Repositorio   | Verificación                     | Resultado            |
| ------------- | -------------------------------- | -------------------- |
| Auction       | npm ci y typecheck               | Correctos            |
| Notifications | npm ci y typecheck               | Correctos            |
| Auction       | 6 suites unitarias seleccionadas | 61 pruebas aprobadas |
| Notifications | 4 suites unitarias seleccionadas | 13 pruebas aprobadas |

### Suites Auction

- test/unit/register-bid.spec.ts
- test/unit/claim-pending-product.spec.ts
- test/unit/execute-buy-now.spec.ts
- test/unit/early-closure-notification.spec.ts
- test/unit/auction-settlement-outbox-dispatcher.spec.ts
- test/unit/settlement-completion.spec.ts

### Suites Notifications

- tests/unit/application/HandleAuctionSettledEvent.test.ts
- tests/unit/application/CreateAuctionClosedByBuyNowNotification.test.ts
- tests/unit/application/AuctionClosedByBuyNowVisibility.test.ts
- tests/unit/adapters/auction-settlement-events-consumer.test.ts

Total: 10 suites y 74 pruebas aprobadas.
Estas pruebas respaldan capacidades existentes; no acreditan
aceptación integral de HU-92 ni integración real entre servicios.

## Trabajo derivado

### HU-92.2 — Management#550

- Completar despacho y consumidor de publicación al vendedor.
- Completar aviso de nueva puja al vendedor.
- Completar confirmación de puja al postor.
- Reutilizar contratos y mecanismos existentes donde correspondan.

### HU-92.3 — Management#551

- Verificar y completar semántica de acreditación al vendedor.
- Completar confirmación al comprador de buy-now según canal aprobado.
- Completar confirmación de producto recibido tras reclamo.
- Revisar la activación del despacho de settlement sin duplicar
  el productor y consumidor existentes.

### HU-92.4 — Management#552

- Verificar integración real, recuperación, concurrencia e idempotencia.
- Verificar privacidad y experiencia observable del destinatario.
- Consolidar evidencia de CA-01 a CA-06.

## Pendientes para finalizar la auditoría

- Revisar posibles invocaciones externas del dispatcher.
- Confirmar canal y contenido aprobados para cada aviso.
- Revisar persistencia e identificadores de los contratos reutilizados.
- Completar referencias de código y PR.
- Registrar explícitamente las verificaciones bloqueadas o no ejecutadas.

## Conclusión preliminar

HU-92 dispone de capacidades reutilizables, pero no está demostrada
la cobertura completa de los seis avisos requeridos. Esta auditoría
no recomienda cerrar la historia padre.
