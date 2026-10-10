# Verificación manual del realtime de Subasta (EN-034.5)

Scripts para comprobar dos cosas que las pruebas automáticas no cubren, contra la composición real
y con el límite de memoria de producción (`mem_limit: 160m`, ADR-011):

1. Una conexión WebSocket de **más de 60 s** sobrevive a Caddy y recibe una señal después.
2. El consumo de **memoria** con los límites del contrato (3 conexiones por usuario, 20
   suscripciones por conexión).

Resultados y conclusiones: `docs/evidence/EN-034-realtime-verificacion.md` en
`Nexus-Battle-Infrastructure`.

## Requisitos

Docker y los repositorios `Nexus-Battle-Auction` y `Nexus-Battle-Infrastructure` clonados. Los
comandos están escritos para Git Bash en Windows; `MSYS_NO_PATHCONV=1` evita que reescriba las rutas
de los volúmenes.

## 1. Conexión larga a través de Caddy (`verify-through-caddy.mjs`)

```bash
docker build -t auction-rt:test .
docker network create rt-net
docker run -d --name rt-pg --network rt-net -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=auction postgres:17-alpine
docker run --rm --network rt-net -e DATABASE_URL=postgres://postgres:pw@rt-pg:5432/auction \
  -e PERSISTENCE_DRIVER=postgres -e NODE_ENV=development auction-rt:test node dist/infrastructure/persistence/migrate.js
docker run -d --name auction --network rt-net --memory 160m --memory-swap 160m \
  -e NODE_ENV=development -e PORT=3008 -e PERSISTENCE_DRIVER=postgres \
  -e DATABASE_URL=postgres://postgres:pw@rt-pg:5432/auction \
  -e AUTH_MODE=disabled -e AUCTION_REALTIME_ENABLED=true auction-rt:test
# El Caddyfile REAL del repo de Infrastructure (sitio interno :8080, sin TLS).
docker run -d --name caddy --network rt-net --memory 64m -p 18080:8080 \
  -v "<ruta>/Nexus-Battle-Infrastructure/compose/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine

node scripts/realtime/verify-through-caddy.mjs --hold=75 --burst=300
```

El contenedor debe llamarse `auction` (el `Caddyfile` enruta a `auction:3008`) y la base `rt-pg`
(el script siembra una subasta con `docker exec`).

Con `AUTH_MODE=disabled` todas las conexiones tienen el mismo usuario, así que el límite de 3
conexiones por usuario impide abrir más: por eso existe el segundo script.

## 2. Memoria con 90 conexiones (`load-server.cjs` + `load-client.mjs`)

`load-server.cjs` monta el gateway, el hub y los tickets **reales** de la imagen (`dist/`) sobre un
servidor HTTP propio, y emite tickets para usuarios distintos. Así se puede probar la carga de la
demostración (30 usuarios × 3 conexiones × 20 suscripciones) con el límite de 160 MiB.

```bash
MSYS_NO_PATHCONV=1 docker run -d --name lsrv --memory 160m --memory-swap 160m -p 19090:9090 \
  -e NODE_PATH=/app/node_modules -v "<ruta>/Nexus-Battle-Auction/scripts/realtime:/scripts:ro" \
  auction-rt:test node /scripts/load-server.cjs

node scripts/realtime/load-client.mjs --users=30 --conns=3 --subs=20 --burst=1000
docker inspect lsrv --format 'OOMKilled={{.State.OOMKilled}}'
```

## Limpieza

```bash
docker rm -f lsrv auction caddy rt-pg; docker network rm rt-net; docker rmi auction-rt:test
```
