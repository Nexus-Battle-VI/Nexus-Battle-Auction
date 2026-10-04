# TASK 89.3 — Disponibilidad de estadísticas de visualización

## Resultado del discovery

No existe una fuente autoritativa aprobada para visualizaciones: no se encontró tabla, migración, evento, puerto ni integración que registre visitas a una publicación.

El endpoint `GET /v1/auctions/me/view-statistics` responde:

```json
{
  "availability": "UNAVAILABLE",
  "reason": "AUTHORITATIVE_SOURCE_NOT_CONFIGURED",
  "metrics": []
}
```

`metrics` vacío significa ausencia de fuente, no cero visualizaciones. Una integración futura debe reemplazar este caso de uso por un puerto autoritativo y conservar el contrato explícito de disponibilidad.

## Changelog / Registro de cambios

- Creado `GetMyAuctionViewStatistics.ts` con resultado indisponible explícito.
- Añadido endpoint privado y contrato OpenAPI.
- Añadidas pruebas que impiden introducir contadores simulados.
- No se creó persistencia ni evento ficticio.

Commit propuesto: `feat(auction): report view statistics availability #546`
