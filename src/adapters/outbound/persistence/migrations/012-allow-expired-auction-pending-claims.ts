import { sql, type Kysely } from 'kysely'
import type { Database } from '../schema'

/**
 * HU-69.1 amplia el ciclo de vida de la tabla creada por HU-65.3.
 * La migracion 008 ya fue aplicada y por eso sus constraints no se editan.
 */
export const up = async (db: Kysely<Database>): Promise<void> => {
  await sql`
    alter table auction_pending_claims
      drop constraint auction_pending_claims_status_valid,
      drop constraint auction_pending_claims_claimed_at_valid
  `.execute(db)

  await sql`
    alter table auction_pending_claims
      add constraint auction_pending_claims_status_valid
        check (claim_status in ('PENDING', 'CLAIMED', 'EXPIRED')),
      add constraint auction_pending_claims_claimed_at_valid
        check (
          (claim_status = 'PENDING' and claimed_at is null)
          or (claim_status = 'CLAIMED' and claimed_at is not null)
          or (claim_status = 'EXPIRED' and claimed_at is null)
        )
  `.execute(db)
}

export const down = async (db: Kysely<Database>): Promise<void> => {
  await sql`
    alter table auction_pending_claims
      drop constraint auction_pending_claims_status_valid,
      drop constraint auction_pending_claims_claimed_at_valid
  `.execute(db)

  await sql`
    alter table auction_pending_claims
      add constraint auction_pending_claims_status_valid
        check (claim_status in ('PENDING', 'CLAIMED')),
      add constraint auction_pending_claims_claimed_at_valid
        check (
          (claim_status = 'PENDING' and claimed_at is null)
          or (claim_status = 'CLAIMED' and claimed_at is not null)
        )
  `.execute(db)
}
