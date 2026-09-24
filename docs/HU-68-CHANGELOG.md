# Changelog / Registro de Cambios — HU-68

## TASK 68.2 — Casos de uso y API de seguimiento

- Se añadieron los casos de uso para seguir, dejar de seguir y listar subastas.
- Se expusieron endpoints autenticados que derivan el jugador del JWT.
- Se ampliaron los adaptadores PostgreSQL y en memoria y su migración idempotente.
- Se documentaron los errores de subasta inexistente, cerrada y seguimiento duplicado.

## TASK 68.3 — Eventos y recordatorios

- Se publica un evento versionado cuando cambia la puja líder de una subasta seguida.
- Se añadió el proceso periódico para avisar una hora antes del cierre a seguidores y participantes.
- La publicación HTTP usa HMAC, sello temporal y confirmación del `eventId`.
- Los fallos de Notifications no revierten una puja que ya fue confirmada.
- Se añadieron pruebas unitarias de destinatarios únicos, ventanas de cierre y listas vacías.
