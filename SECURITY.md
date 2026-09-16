# Política de seguridad

## Alcance

Código de `Nexus-Battle-Auction`. Nexus Battles VI es un producto académico en desarrollo.

## Reporte de vulnerabilidades

Las vulnerabilidades **no se reportan mediante Issues públicas ni Pull Requests**. Se usa el reporte privado de vulnerabilidades de GitHub (pestaña _Security_), con componente, impacto, pasos reproducibles y configuración necesaria.

## Controles del servicio

- Verificación del token de acceso de Cognito en toda ruta no marcada como pública. Un binario de producción sin verificación **no arranca**.
- Autorización por rol a partir de `cognito:groups`; los grupos desconocidos se descartan.
- Contrato interno firmado con HMAC-SHA256, ventana de 30 segundos, comparación en tiempo constante y lista cerrada de servicios. Sin secreto configurado, niega con `503`.
- Validación de entrada que rechaza propiedades no declaradas.
- Imagen de contenedor sin privilegios (`USER node`), sin ficheros de entorno ni credenciales.
- OpenAPI interactivo deshabilitado en producción salvo decisión explícita.

## Consideraciones específicas

- El vendedor, el postor y el ganador salen siempre del `sub` del testimonio, nunca del cuerpo.
- Un cliente no puede fijar el precio de liquidación, el ganador ni la hora de cierre.
- Los límites de HU-62 y HU-63 (10 subastas activas, 50 pujas, 5 segundos entre pujas) se aplican en el servidor.

## Manejo de secretos

- `INTERNAL_SERVICE_AUTH_SECRET` y la contraseña de la base de datos llegan por variables de entorno; nunca se registran ni se incluyen en respuestas.
- Ningún guion de prueba debe imprimir tokens de acceso.
