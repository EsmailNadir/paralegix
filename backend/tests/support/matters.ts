/**
 * Matter fixtures, straight into the tables.
 *
 * Seeded through SQL rather than the matters routes so a spec about some other
 * module does not depend on the create route, and so a broken matters module
 * cannot produce both the row and the expectation.
 *
 * Every insert asserts its row count. A seed rejected by the status CHECK or by
 * the `(law_firm_id, matter_reference_id)` unique constraint would otherwise
 * surface several lines later as a missing row in a list assertion, and the
 * failure would name the read rather than the seed.
 */
import { randomUUID } from 'crypto';

import { testPool } from './db';

export interface MatterSeed {
  name?: string;
  matterNumber?: string | null;
  description?: string | null;
  status?: string;
  category?: string | null;
  practiceAreaId?: string | null;
  courtId?: string | null;
  leadUserId?: string | null;
  createdAt?: string;
  /** Added to `matter_members` with the role `lead`. */
  memberUids?: string[];
  /** Added to `matter_clients`. */
  clientIds?: string[];
}

/** A matter row, plus any members and clients named in the seed. Returns its id. */
export async function seedMatter(lawFirmId: string, seed: MatterSeed = {}): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters
       (id, law_firm_id, name, matter_number, matter_reference_id, description,
        status, category, practice_area_id, court_id, lead_user_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))
     returning id`,
    [
      id, lawFirmId,
      seed.name ?? `Matter ${id.slice(0, 8)}`,
      seed.matterNumber ?? null,
      `REF-${id.slice(0, 8)}`,
      seed.description ?? null,
      seed.status ?? 'active',
      seed.category ?? null,
      seed.practiceAreaId ?? null,
      seed.courtId ?? null,
      seed.leadUserId ?? null,
      seed.createdAt ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  for (const uid of seed.memberUids ?? []) await seedMatterMember(lawFirmId, id, uid);
  for (const clientId of seed.clientIds ?? []) await seedMatterClient(lawFirmId, id, clientId);
  return id;
}

/**
 * A `matter_members` row. The membership is what `assertMatterMembership`
 * checks, and it refuses even a firm owner who is not on the matter.
 */
export async function seedMatterMember(
  lawFirmId: string, matterId: string, userId: string, role = 'lead', joinedAt?: string,
): Promise<void> {
  const res = await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1,$2,$3,$4, coalesce($5::timestamptz, now()))`,
    [lawFirmId, matterId, userId, role, joinedAt ?? null],
  );
  expect(res.rowCount).toBe(1);
}

/** A `matter_clients` row. */
export async function seedMatterClient(lawFirmId: string, matterId: string, clientId: string): Promise<void> {
  const res = await testPool.query(
    `insert into matter_clients (law_firm_id, matter_id, client_id) values ($1,$2,$3)`,
    [lawFirmId, matterId, clientId],
  );
  expect(res.rowCount).toBe(1);
}
