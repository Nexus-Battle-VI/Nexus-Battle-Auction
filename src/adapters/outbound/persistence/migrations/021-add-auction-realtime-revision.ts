import { sql, type Kysely } from 'kysely'

/**
 * EN-034 (TASK 34.2). Revision por subasta y senal de cambio al confirmar.
 *
 * `auctions.revision` crece en 1 con cada cambio observable de la subasta:
 * una puja nueva y cualquier cambio de `status` (cierre, compra inmediata,
 * cancelacion). Una subasta recien publicada nace en 0.
 *
 * Se resuelve en triggers y no en el codigo del repositorio por dos razones:
 * 1. Todos los caminos de escritura -puja, compra inmediata, las dos
 *    cancelaciones, el cierre- pasan por estas dos tablas, y un trigger no se
 *    puede olvidar en un camino nuevo. La revision se incrementa DENTRO de la
 *    misma transaccion que el cambio.
 * 2. `pg_notify` encola la notificacion y PostgreSQL la entrega SOLO si la
 *    transaccion confirma. Es exactamente "difundir despues del commit": una
 *    transaccion revertida no emite nada, y no hay que mantener un registro de
 *    lo emitido.
 *
 * Canal: `auction_realtime`. La carga es JSON con `auctionId`, `revision`,
 * `reason`, `occurredAt` y `summary` (`status`, `currentBidCredits`,
 * `bidCount`). No lleva ningun dato personal.
 *
 * La carga util de NOTIFY admite 8000 bytes; la de esta senal ronda los 250.
 *
 * Correspondencia con `reason` del contrato (auction-realtime-v1):
 * - INSERT en `auctions`                -> PUBLISHED (revision 0)
 * - INSERT en `auction_bids`            -> BID_ACCEPTED
 * - status -> FINISHED                  -> SETTLED (cierre de la subasta)
 * - status -> SOLD                      -> BOUGHT_NOW
 * - status -> CANCELLED                 -> CANCELLED
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`
    alter table auctions add column revision bigint not null default 0
  `.execute(db)

  await sql`
    create function auction_realtime_notify(
      p_auction_id text,
      p_revision bigint,
      p_reason text
    ) returns void
    language plpgsql
    as $$
    declare
      v_status text;
      v_bid_count integer;
      v_current_bid integer;
    begin
      select status into v_status from auctions where id = p_auction_id;

      select count(*)::integer into v_bid_count
      from auction_bids
      where auction_id = p_auction_id;

      select amount_credits into v_current_bid
      from auction_bids
      where auction_id = p_auction_id and is_leader = true;

      perform pg_notify(
        'auction_realtime',
        json_build_object(
          'auctionId', p_auction_id,
          'revision', p_revision,
          'reason', p_reason,
          'occurredAt', to_char(
            clock_timestamp() at time zone 'utc',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'summary', json_build_object(
            'status', v_status,
            'currentBidCredits', v_current_bid,
            'bidCount', v_bid_count
          )
        )::text
      );
    end;
    $$
  `.execute(db)

  // Puja nueva. La fila de `auctions` ya esta bloqueada por la transaccion de
  // la puja (FOR UPDATE), asi que el incremento no compite con otra puja.
  // `update ... set revision` no toca `status`, por lo que no dispara el
  // trigger de cambio de estado.
  await sql`
    create function auction_bid_realtime() returns trigger
    language plpgsql
    as $$
    declare
      v_revision bigint;
    begin
      update auctions
      set revision = revision + 1
      where id = new.auction_id
      returning revision into v_revision;

      perform auction_realtime_notify(new.auction_id, v_revision, 'BID_ACCEPTED');
      return new;
    end;
    $$
  `.execute(db)

  await sql`
    create trigger auction_bids_realtime
    after insert on auction_bids
    for each row execute function auction_bid_realtime()
  `.execute(db)

  // Cambio de estado: BEFORE para fijar `revision` en la misma escritura.
  await sql`
    create function auction_status_realtime() returns trigger
    language plpgsql
    as $$
    begin
      new.revision := old.revision + 1;
      return new;
    end;
    $$
  `.execute(db)

  await sql`
    create trigger auctions_status_revision
    before update of status on auctions
    for each row
    when (old.status is distinct from new.status)
    execute function auction_status_realtime()
  `.execute(db)

  // El aviso va AFTER, para que el resumen lea ya el estado nuevo.
  await sql`
    create function auction_status_realtime_notify() returns trigger
    language plpgsql
    as $$
    declare
      v_reason text;
    begin
      v_reason := case new.status
        when 'FINISHED' then 'SETTLED'
        when 'SOLD' then 'BOUGHT_NOW'
        when 'CANCELLED' then 'CANCELLED'
        else null
      end;

      if v_reason is not null then
        perform auction_realtime_notify(new.id, new.revision, v_reason);
      end if;
      return new;
    end;
    $$
  `.execute(db)

  await sql`
    create trigger auctions_status_realtime_notify
    after update of status on auctions
    for each row
    when (old.status is distinct from new.status)
    execute function auction_status_realtime_notify()
  `.execute(db)

  await sql`
    create function auction_published_realtime() returns trigger
    language plpgsql
    as $$
    begin
      perform auction_realtime_notify(new.id, new.revision, 'PUBLISHED');
      return new;
    end;
    $$
  `.execute(db)

  await sql`
    create trigger auctions_published_realtime
    after insert on auctions
    for each row execute function auction_published_realtime()
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`drop trigger if exists auctions_published_realtime on auctions`.execute(db)
  await sql`drop trigger if exists auctions_status_realtime_notify on auctions`.execute(db)
  await sql`drop trigger if exists auctions_status_revision on auctions`.execute(db)
  await sql`drop trigger if exists auction_bids_realtime on auction_bids`.execute(db)
  await sql`drop function if exists auction_published_realtime()`.execute(db)
  await sql`drop function if exists auction_status_realtime_notify()`.execute(db)
  await sql`drop function if exists auction_status_realtime()`.execute(db)
  await sql`drop function if exists auction_bid_realtime()`.execute(db)
  await sql`drop function if exists auction_realtime_notify(text, bigint, text)`.execute(db)
  await sql`alter table auctions drop column revision`.execute(db)
}
