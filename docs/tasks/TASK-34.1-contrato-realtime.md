# TASK-34.1 — Contrato de eventos realtime de Subasta (EN-034)

**Estado:** BORRADOR para revisión del equipo. Nada de lo descrito aquí está implementado.
**Base arquitectónica:** [ADR-020](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-020-realtime-combat.md) (aceptado), que ya fija el transporte y la autenticación de tiempo real en Nexus y prevé este caso: «si una Historia de Usuario exige empuje en tiempo real para pujas, se reutiliza este mismo esquema con un ADR que lo extienda».
**Enabler:** EN-034 — Actualización en tiempo real y sincronización de Subasta (Management #523).
**Cubre:** CA-01 a CA-06 del Enabler, a nivel de contrato. La implementación va en TASK-34.2 en adelante.

## 1. Principio

El backend es la fuente de verdad. El canal realtime transporta **señales de invalidación**, no estado
autoritativo: dice *qué subasta cambió y en qué revisión*, y el cliente recupera el estado con las
consultas HTTP existentes (`GET /v1/auctions`, `GET /v1/auctions/:auctionId`). Consecuencias:

- Un evento perdido, tardío o duplicado no puede dejar un valor imposible: la siguiente lectura HTTP manda (CA-06).
- La reconexión es un refetch de lo observado (CA-03), sin protocolo de replay.
- Pujar, comprar y cancelar siguen siendo comandos HTTP transaccionales; el canal es solo de lectura.

## 2. Transporte y autenticación (decididos: D-1, D-2)

Se **reutiliza ADR-020** en lugar de abrir un segundo mecanismo realtime en la plataforma:

- **WebSocket (RFC 6455)** en `wss://nexus.simuladorupbbga.app/api/v1/auctions/realtime`, con `@nestjs/websockets` y el adaptador `@nestjs/platform-ws`, en la misma versión menor de NestJS que Auction.
- **Caddy no requiere cambios:** `handle /api/v1/auctions*` ya enruta a `auction:3008` y `reverse_proxy` atiende la actualización a WebSocket sin configuración adicional.
- **Autenticación por ticket de un solo uso**, nunca el JWT en la URL:
  1. `POST /api/v1/auctions/realtime/tickets` con `Authorization: Bearer <JWT>` (mismos roles que las lecturas: `Player`, `GameMaster`).
  2. Devuelve un ticket opaco, ligado al `sub`, de un solo uso y con caducidad de 30 s; solo se guarda su hash.
  3. El cliente abre el WebSocket y su primer mensaje es `{"type":"auth","ticket":"..."}`. Sin ticket válido en 5 s, el servidor cierra con `4401`.
- Sin Socket.IO, API Gateway WebSocket ni ALB (ADR-007, ADR-020).

**Cambio respecto al primer borrador:** se había recomendado SSE. Se descarta porque ADR-020 ya aceptó WebSocket, resolvió la autenticación (el problema de `EventSource` sin cabecera `Authorization`) y descartó expresamente SSE; mantener dos transportes en la plataforma costaría más que lo que SSE ahorra.

**Qué se reutiliza y qué no de ADR-020:** el transporte, el ticket y el latido (25 s). No se reutiliza la parte de *comandos*: aquí el canal es de **solo lectura**; pujar, comprar y cancelar siguen siendo HTTP transaccional. El cliente puede enviar únicamente `auth`, `subscribe` y `unsubscribe`.

**Obligación formal:** ADR-020 pide un ADR que extienda el esquema a Auction. Hay que redactarlo en `Nexus-Battle-Infrastructure` (ver §8, seguimiento S-1). Este contrato es independiente del transporte, así que no se bloquea por ello.

## 3. Mensaje

Un solo tipo de mensaje de aplicación, con envoltura mínima:

```ts
interface AuctionRealtimeSignalV1 {
  readonly signalVersion: 1
  readonly signalId: string          // `auction:{auctionId}:r{revision}` — idempotente y deduplicable
  readonly auctionId: string
  readonly revision: number          // entero creciente por subasta (ver D-3)
  readonly reason: 'BID_ACCEPTED' | 'BOUGHT_NOW' | 'SETTLED' | 'CANCELLED' | 'PUBLISHED'
  readonly occurredAt: string        // ISO-8601, informativo; NUNCA se usa para ordenar
  readonly summary?: {               // opcional: pista para pintar antes del refetch
    readonly status: 'ACTIVE' | 'FINISHED' | 'SOLD' | 'CANCELLED'
    readonly currentBidCredits: number | null
    readonly bidCount: number
  }
}
```

Reglas:

1. `auctionId` es la única clave de ruteo. El cliente aplica el mensaje solo a las claves de caché de ese id (CA-02).
2. Orden y deduplicación por `(auctionId, revision)`: se descarta cualquier mensaje con `revision <=` la última vista para esa subasta (CA-06).
3. `summary` es solo una pista. Si existe, la UI puede pintarlo de inmediato, pero siempre se dispara el refetch y prevalece su resultado.
4. No se incluyen datos personales ni de otros postores: ni `bidderId`, ni `sellerId`, ni `winnerId`. Los eventos `auction.*` v1 inter-servicio sí los llevan, por eso **no se reutilizan tal cual** hacia el navegador.
5. Tamaño máximo por mensaje: 1 KiB.

### Mapeo desde lo que ya existe

| `reason` | Origen en Auction | Estado |
|---|---|---|
| `PUBLISHED` | `AuctionPublishedEventV1` | existe |
| `BID_ACCEPTED` | `AuctionBidAcceptedEventV1` (tras completar créditos) | existe; no trae `bidCount` |
| `SETTLED` | `AuctionSettledEventV1` | existe |
| `CANCELLED` | `AuctionCancelledEventV1` | existe |
| `BOUGHT_NOW` | — | **no existe**: hay endpoint `buy-now` pero no evento de dominio (TASK-34.2) |

La señal se emite **después del commit** de la transacción que cambia la subasta, nunca antes.
El mecanismo de emisión (outbox o hook post-commit) queda para TASK-34.2.

## 4. Canales y suscripción

| Canal | Quién se suscribe | Recibe |
|---|---|---|
| `auctions/{auctionId}` | Detalle de una subasta, panel de puja | señales de esa subasta |
| `auctions` (agregado) | Marketplace | señales de cualquier subasta, solo con `reason`, `auctionId`, `revision` (sin `summary`) |

- El cliente se suscribe con `{"type":"subscribe","channel":"auctions/{auctionId}"}` o `"auctions"`, y se baja con `unsubscribe`. Máximo 20 suscripciones por conexión.
- Roles: los mismos que ya exigen las lecturas HTTP (`Player`, `GameMaster`). Quien no pueda hacer `GET :auctionId` no puede suscribirse a su canal.
- Suscribirse a una subasta inexistente o no visible responde igual que el `GET` equivalente.
- Marketplace **invalida** sus listas; no intenta parchearlas, porque las claves de caché incluyen filtros y paginación y un parche puede mezclarlas (CA-05).

## 5. Reconexión (CA-03)

1. El cliente detecta la caída (cierre del stream o ausencia de *heartbeat*).
2. Reconecta con backoff exponencial con jitter, tope sugerido 30 s, y repite el flujo de ticket (cada conexión necesita uno nuevo).
3. Al reabrir, **invalida todas las consultas de subasta actualmente observadas** (no todo el marketplace guardado).
4. Mientras está desconectado, la UI no presenta el valor como «en vivo»: debe indicarlo (estado de conexión visible).
5. Latido del servidor cada 25 s (mismo valor que ADR-020); una conexión sin respuesta se cierra.
6. Un reinicio de Caddy o de Auction cierra todas las conexiones. Es esperado: la reconexión es obligatoria en el cliente y el estado sobrevive porque vive en PostgreSQL, no en el proceso.

A diferencia de Combat, **no hay `resume` con `lastSeq` ni bitácora de eventos**: las señales son de invalidación, así que el refetch cumple esa función y se evita persistir historial.

## 6. Cambios de estado (CA-04)

`BOUGHT_NOW`, `SETTLED` y `CANCELLED` son terminales. Al recibirlas, la vista refetchea y debe dejar de ofrecer pujar, comprar y cancelar según el estado que devuelva el backend, no según la señal.

## 7. Reversión

Un interruptor de configuración del servidor (`AUCTION_REALTIME_ENABLED`, por defecto apagado hasta validar) desactiva el endpoint de suscripción. El cliente, ante fallo de conexión permanente, cae a sondeo HTTP con intervalo largo. Ninguno de los dos caminos toca reglas de puja, créditos ni estados persistidos.

## 8. Decisiones

Resueltas por recomendación, tras revisar `Nexus-Battle-Infrastructure` (`origin/develop`):

| Id | Decisión | Resolución | Fundamento |
|---|---|---|---|
| D-1 | Transporte | **WebSocket** (`@nestjs/platform-ws`), no SSE | ADR-020 aceptado; un solo mecanismo en la plataforma |
| D-2 | Autenticación | **Ticket de un solo uso** (30 s) + mensaje `auth` | ADR-020; JWT nunca en la URL |
| D-3 | Origen de `revision` | Columna **`revision bigint`** en la subasta, incrementada en la misma transacción que cualquier cambio observable | Se difunde **después** de persistir (patrón de ADR-020). Derivarla de `bidCount` no cubre cancelación ni compra inmediata. **Requiere migración 021** |
| D-4 | Timeouts de proxy | **Sin trabajo de infraestructura** | La entrada es Caddy en la propia EC2, sin ALB ni API Gateway (ADR-007, ADR-010). El `Caddyfile` no define timeouts de lectura ni de transporte que corten conexiones largas, y el latido de 25 s cubre cualquier intermediario. Verificar en TASK-34.5 con una conexión de más de 60 s |
| D-5 | Réplicas y *fan-out* | **Difusión en memoria del proceso**, una sola réplica | `compose/nodes/app.yml` no declara réplicas ni escalado: `auction` es un único contenedor (`mem_limit: 160m`) en el nodo `app` (ADR-011, topología T2). Mismo coste que acepta ADR-020 para Combat |
| D-6 | Panel personal (HU-89) | Fuera de este contrato | Se evalúa en TASK-34.4 |

### Consecuencias asumidas

- **Escalar Auction a más de una réplica rompería la difusión:** un cambio confirmado en una réplica no llegaría a los clientes conectados a otra. Exigiría un bus (por ejemplo `LISTEN/NOTIFY` de PostgreSQL) y un ADR nuevo. El estado nunca queda incorrecto, solo tarda en actualizarse hasta el siguiente refetch.
- **Memoria:** el contenedor tiene `mem_limit: 160m`. Con la carga de la demo (≤ 30 usuarios concurrentes según `docs/costs/assumptions.md` de Infrastructure) las conexiones caben, pero el límite de 20 suscripciones por conexión y uno de conexiones por usuario (propuesto: 3) son obligatorios. TASK-34.2 debe medir el consumo.
- **Reinicio:** cada despliegue de Auction desconecta a todos los observadores; los clientes lo recuperan solos por §5.

### Seguimiento

| Id | Acción | Dónde |
|---|---|---|
| S-1 | Redactar el ADR que extiende ADR-020 a Auction (WebSocket de solo lectura, señales de invalidación, una réplica) | `Nexus-Battle-Infrastructure/docs/adr/` |
| S-2 | Migración 021: `revision bigint not null default 0` en la tabla de subastas | TASK-34.2 |
| S-3 | Evento de dominio para compra inmediata (`BOUGHT_NOW`) | TASK-34.2 |
| S-4 | Documentar `/api/v1/auctions/realtime` en `docs/contracts` de Infrastructure | TASK-34.2 |

## 9. Trazabilidad con los criterios de aceptación

| CA | Dónde se cubre |
|---|---|
| CA-01 puja entre sesiones | §3 `BID_ACCEPTED` + §4 canal por subasta |
| CA-02 aislamiento | §3 regla 1, §4 |
| CA-03 reconexión | §5 |
| CA-04 cambio de estado | §3 `reason` terminales, §6 |
| CA-05 caché consistente | §4 (invalidar, no parchear) |
| CA-06 autoridad del backend | §1, §3 reglas 2 y 3 |
