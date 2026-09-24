# TASK 68.3 — Eventos de cambios y recordatorios

Historia: HU-68 — Lista de seguimiento de subastas.  
Referencia: `Refs Nexus-Battle-VI/Nexus-Battle-Management#53`.

## Resultado funcional

Auction informa a Notifications cuando cambia la puja líder de una subasta seguida y cuando falta una hora para el cierre. Los destinatarios se calculan en Auction, propietario de la subasta, la watchlist y el historial de pujas.

| Evento                         | Disparador                                                        | Destinatarios                                       |
| ------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------- |
| `auction.watchlist.changed.v1` | Una puja nueva o reanudada queda confirmada como líder.           | Seguidores únicos de la subasta.                    |
| `auction.closing-soon.v1`      | Una subasta activa entra en la ventana `(ahora, ahora + 1 hora]`. | Unión sin duplicados de seguidores y participantes. |

El identificador del recordatorio se deriva de la subasta y su fecha de cierre. Por ello, las ejecuciones sucesivas del scheduler producen el mismo `eventId` y Notifications puede tratar los reintentos de forma idempotente.

## Arquitectura

- `WatchlistEventPublisherPort` mantiene el caso de uso independiente del transporte.
- `HttpWatchlistEventPublisher` implementa el puerto mediante HTTP interno firmado con HMAC SHA-256.
- `NotifyWatchlistChange` obtiene y normaliza seguidores antes de publicar.
- `DispatchClosingSoonReminders` consulta la ventana de cierre y combina seguidores y pujadores.
- `AuctionReminderScheduler` ejecuta la búsqueda cada minuto y se detiene con el ciclo de vida de NestJS.
- `RegisterBid` publica únicamente después de persistir la puja. Un fallo posterior de Notifications se registra, pero no revierte una puja ya confirmada.

Si faltan `NOTIFICATIONS_BASE_URL` o `INTERNAL_SERVICE_AUTH_SECRET`, la composición instala `UnavailableWatchlistEventPublisher` y falla de forma explícita cuando una operación intenta publicar.

## TDD: Red → Green → Refactor

1. **Red:** se creó `test/unit/watchlist-events.spec.ts` antes de los puertos y casos de uso. Jest falló porque los módulos todavía no existían.
2. **Green:** se implementaron el puerto, los dos casos de uso, las consultas de repositorio, el adaptador HTTP y el scheduler.
3. **Refactor:** se estabilizaron los identificadores, se eliminaron destinatarios repetidos y se mantuvo la publicación fuera de la transacción de puja.

Los escenarios específicos verifican publicación con seguidores únicos, ausencia de evento sin seguidores, recordatorio en la frontera exacta de una hora y ventana sin subastas.

## Validación final

La rama se rebasó sobre el `develop` actual después de integrar TASK 68.1.

| Verificación                  |                 Resultado |
| ----------------------------- | ------------------------: |
| Suite completa                | 345 aprobadas, 0 fallidas |
| Sentencias                    |                   93,06 % |
| Ramas                         |                   86,84 % |
| Funciones                     |                   90,33 % |
| Líneas                        |                   93,30 % |
| TypeScript, ESLint y Prettier |                 Aprobados |

Todas las métricas superan RNF-16 (80 %).

## Changelog / Registro de cambios

### Archivos creados

- `src/application/ports/WatchlistEventPublisherPort.ts`
- `src/application/use-cases/NotifyWatchlistChange.ts`
- `src/application/use-cases/DispatchClosingSoonReminders.ts`
- `src/adapters/outbound/http/HttpWatchlistEventPublisher.ts`
- `src/adapters/outbound/http/UnavailableWatchlistEventPublisher.ts`
- `src/infrastructure/scheduling/AuctionReminderScheduler.ts`
- `test/unit/watchlist-events.spec.ts`

### Archivos modificados

- Puertos y adaptadores de Auction y Watchlist para consultar cierres, seguidores y pujas.
- `RegisterBid.ts` para disparar avisos tras la confirmación.
- `app.module.ts` para seleccionar adaptadores y registrar scheduler/casos de uso.

Commit: `feat(auction): publish watchlist changes and closing reminders #TASK-68.3`.  
PR: https://github.com/Nexus-Battle-VI/Nexus-Battle-Auction/pull/24
