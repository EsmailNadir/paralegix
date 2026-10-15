/**
 * A matter may only carry a practice area its OWN firm owns.
 *
 * `matters.practice_area_id` is a SINGLE-column FK to `practice_areas(id)`,
 * deliberately: a composite key carrying `law_firm_id` would make ON DELETE SET
 * NULL try to null the tenant column, which is the defect fixed in migration
 * 0184 for the leads table. The cost of that choice is that the database will
 * never reject a cross-firm practice area, so the check has to live in the
 * application, and AGENTS.md is explicit that tenant scoping is the app's job.
 *
 * `updatePracticeArea` does that check. `bulkUpdatePracticeArea`, twelve lines
 * above it, did not: it authorized the MATTER through assertMatterWriteAccess
 * and then wrote whatever `practiceAreaId` the body carried. The schema was
 * `z.string().min(1)`, not even a uuid, and the repository's only filter is an
 * `isUuid` syntax check. `scopedUpdate` scopes the rows being written, not the
 * value being written into them.
 *
 * So a member holding `matters.update` in their OWN firm could stamp another
 * firm's practice area onto their matters. Two things follow, and the second
 * does not need the first:
 *
 *   THE READ. Four joins hydrate the name back without a firm predicate: the
 *   matter detail and list reads, the practice-area sort subquery, and the
 *   billing by-matter report. An attacker who already holds a victim uuid gets
 *   the name behind it. Narrow, because the uuid is not guessable or exposed
 *   across firms, but a tenant boundary either holds or it does not.
 *
 *   THE WRITE, which is the worse half. The FK is ON DELETE SET NULL, so the
 *   VICTIM firm deleting their own practice area silently nulls the practice
 *   area on a different tenant's matters. One firm's ordinary housekeeping
 *   mutates another firm's data.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firmA: Firm;
let firmB: Firm;
let alice: Actor;  // owner at firm A
let bob: Actor;    // owner at firm B

const bulkPath = () => `/api/lawfirms/${firmA.id}/matters/bulk-update-practice-area`;

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into practice_areas (id, law_firm_id, name) values ($1, $2, $3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** A matter in firm A with alice on it, so assertMatterWriteAccess passes. */
async function seedMatter(practiceAreaId: string | null = null): Promise<string> {
  const id = randomUUID();
  const m = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, practice_area_id)
     values ($1, $2, 'Bulk matter', $3, 'active', $4) returning id`,
    [id, firmA.id, `REF-${id.slice(0, 8)}`, practiceAreaId],
  );
  expect(m.rowCount).toBe(1);
  const mm = await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [firmA.id, id, alice.uid],
  );
  expect(mm.rowCount).toBe(1);
  return id;
}

const practiceAreaOf = async (matterId: string) => (await testPool.query(
  'select practice_area_id from matters where id = $1', [matterId],
)).rows[0].practice_area_id;

beforeEach(async () => {
  firmA = await createFirm({ name: 'Alpha Legal' });
  firmB = await createFirm({ name: 'Bravo Legal' });
  alice = await ownerOf(firmA.id);
  bob = await ownerOf(firmB.id);
  await drainEvents();
});

describe('bulk practice-area update refuses another firm\'s practice area', () => {
  it('refuses the write, and the matter keeps what it had', async () => {
    const theirs = await seedPracticeArea(firmB.id, 'Bravo Immigration');
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const matterId = await seedMatter(mine);

    const res = await alice.api.post(bulkPath())
      .send({ matterIds: [matterId], practiceAreaId: theirs });

    expect(res.status).toBe(400);
    // The row, not the status. A route that answered 400 after writing has
    // already put another tenant's id on this firm's matter, and the victim
    // deleting that practice area would then null a column in this firm.
    expect(await practiceAreaOf(matterId)).toBe(mine);
  });

  it('refuses before writing ANY matter in the batch', async () => {
    const theirs = await seedPracticeArea(firmB.id, 'Bravo Immigration');
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const first = await seedMatter(mine);
    const second = await seedMatter(mine);

    await alice.api.post(bulkPath())
      .send({ matterIds: [first, second], practiceAreaId: theirs });

    // The practice area is one loop-invariant value, so the check belongs above
    // the loop. Checked per matter, the batch could half-apply before failing.
    expect(await practiceAreaOf(first)).toBe(mine);
    expect(await practiceAreaOf(second)).toBe(mine);
  });

  it('still ACCEPTS a practice area this firm owns', async () => {
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const other = await seedPracticeArea(firmA.id, 'Alpha Probate');
    const matterId = await seedMatter(other);

    const res = await alice.api.post(bulkPath())
      .send({ matterIds: [matterId], practiceAreaId: mine });

    // The half that keeps the fix honest. A guard that refused everything would
    // satisfy both cases above and break the feature.
    expect(res.status).toBe(200);
    expect(await practiceAreaOf(matterId)).toBe(mine);
  });

  it('refuses a practice area id that exists nowhere', async () => {
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const matterId = await seedMatter(mine);

    const res = await alice.api.post(bulkPath())
      .send({ matterIds: [matterId], practiceAreaId: randomUUID() });

    expect(res.status).toBe(400);
    expect(await practiceAreaOf(matterId)).toBe(mine);
  });

  it('refuses a practice area id that is not a uuid', async () => {
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const matterId = await seedMatter(mine);

    const res = await alice.api.post(bulkPath())
      .send({ matterIds: [matterId], practiceAreaId: 'not-a-uuid' });

    // The schema took `z.string().min(1)`, so a non-uuid reached the repository,
    // where an isUuid filter silently coerced it to null and CLEARED the
    // matter's practice area instead of refusing.
    expect(res.status).toBe(400);
    expect(await practiceAreaOf(matterId)).toBe(mine);
  });
});

describe('the single-matter route already refused, and still does', () => {
  it('refuses another firm\'s practice area', async () => {
    const theirs = await seedPracticeArea(firmB.id, 'Bravo Immigration');
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const matterId = await seedMatter(mine);

    const res = await alice.api.post(`/api/lawfirms/${firmA.id}/matters/${matterId}/update-practice-area`)
      .send({ practiceAreaId: theirs });

    // The sibling this fix was copied from. Kept so the two cannot drift apart
    // again, which is how the bulk one came to be missing the check.
    expect(res.status).toBe(400);
    expect(await practiceAreaOf(matterId)).toBe(mine);
  });
});

describe('firm B is unaffected throughout', () => {
  it('keeps its own practice area usable after firm A is refused', async () => {
    const theirs = await seedPracticeArea(firmB.id, 'Bravo Immigration');
    const mine = await seedPracticeArea(firmA.id, 'Alpha Family');
    const matterId = await seedMatter(mine);
    await alice.api.post(bulkPath()).send({ matterIds: [matterId], practiceAreaId: theirs });

    const { rows } = await testPool.query(
      'select law_firm_id, name from practice_areas where id = $1', [theirs],
    );

    // Proves the refusal did not damage the victim either, and that firm B's
    // row really did exist, so the cases above refused something real.
    expect(rows[0]).toMatchObject({ law_firm_id: firmB.id, name: 'Bravo Immigration' });
  });
});
