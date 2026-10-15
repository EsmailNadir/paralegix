/**
 * The firm's practice areas: create, read, rename, delete, and what a delete
 * does to the matters and tasks filed under one.
 *
 * The only coverage this module had was `tests/live/practiceAreas`, which drives
 * one real, fully permissioned account against a deployed server. It therefore
 * cannot ask the two questions that matter here: what a member holding only the
 * baseline can do, and what a SECOND firm can reach.
 *
 * The permission split is the part worth pinning. `practiceAreas.view` sits in
 * DEFAULT_PERMISSIONS and `practiceAreas.manage` does not, so every member reads
 * the list and only some may change it. Collapsing the two in either direction
 * is invisible on screen: one way a paralegal loses the matter-intake dropdown,
 * the other way anyone can rename the firm's practice groups.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const P = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/practice-areas${suffix}`;

async function seedPracticeArea(
  lawFirmId: string,
  options: { name?: string; order?: number | null } = {},
) {
  const id = randomUUID();
  await testPool.query(
    'insert into practice_areas (id, law_firm_id, name, sort_order) values ($1, $2, $3, $4)',
    [id, lawFirmId, options.name ?? `Practice Area ${id.slice(0, 8)}`, options.order ?? null],
  );
  return { id };
}

async function seedMatter(lawFirmId: string, practiceAreaId: string | null) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, practice_area_id)
     values ($1, $2, 'Smith v. Jones', $3, $4)`,
    [id, lawFirmId, `REF-${id.slice(0, 8)}`, practiceAreaId],
  );
  return { id };
}

const areaRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, law_firm_id, sort_order from practice_areas where id = $1',
    [id],
  );
  return rows[0];
};

const areaCount = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int n from practice_areas where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
});

describe('creating a practice area', () => {
  it('writes it into the caller firm and nowhere else', async () => {
    const res = await owner.api.post(P(firm.id)).send({ name: 'Family Law' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Practice area created successfully');
    expect(await areaRow(res.body.practiceAreaId)).toMatchObject({
      name: 'Family Law',
      law_firm_id: firm.id,
    });
    expect(await areaCount(otherFirm.id)).toBe(0);
  });

  it('refuses an empty name and writes nothing', async () => {
    const res = await owner.api.post(P(firm.id)).send({ name: '' });

    expect(res.status).toBe(400);
    expect(await areaCount(firm.id)).toBe(0);
  });

  it('refuses a request with no name at all', async () => {
    const res = await owner.api.post(P(firm.id)).send({});

    expect(res.status).toBe(400);
    expect(await areaCount(firm.id)).toBe(0);
  });

  it('CHARACTERISATION: accepts a second practice area with the same name', async () => {
    await owner.api.post(P(firm.id)).send({ name: 'Family Law' });

    const res = await owner.api.post(P(firm.id)).send({ name: 'Family Law' });

    // No unique index on (law_firm_id, name) and no service-level check, so the
    // intake dropdown can show "Family Law" twice with different ids behind it.
    // Pinned rather than endorsed: adding the constraint is a deliberate change
    // and this is the case that moves with it.
    expect(res.status).toBe(201);
    expect(await areaCount(firm.id)).toBe(2);
  });

  it('lets two different firms each hold a practice area of the same name', async () => {
    await owner.api.post(P(firm.id)).send({ name: 'Family Law' });

    const res = await otherOwner.api.post(P(otherFirm.id)).send({ name: 'Family Law' });

    expect(res.status).toBe(201);
    expect(await areaCount(otherFirm.id)).toBe(1);
  });

  it('refuses a member holding only the view permission', async () => {
    const viewer = await memberWith(firm.id, ['practiceAreas.view']);

    const res = await viewer.api.post(P(firm.id)).send({ name: 'Family Law' });

    expect(res.status).toBe(403);
    expect(await areaCount(firm.id)).toBe(0);
  });

  it('refuses a member of another firm creating under this firm', async () => {
    const res = await otherOwner.api.post(P(firm.id)).send({ name: 'Family Law' });

    expect(res.status).toBe(403);
    expect(await areaCount(firm.id)).toBe(0);
  });
});

describe('reading practice areas', () => {
  it('lists the firm practice areas ordered by sort order then name', async () => {
    await seedPracticeArea(firm.id, { name: 'Zoning', order: 1 });
    await seedPracticeArea(firm.id, { name: 'Appeals', order: 2 });
    await seedPracticeArea(firm.id, { name: 'Unplaced', order: null });

    const res = await owner.api.get(P(firm.id));

    expect(res.status).toBe(200);
    // Hand-placed areas first, unplaced ones last. Reversed, every firm's
    // dropdown is led by whatever nobody has ordered yet.
    expect(res.body.practiceAreas.map((row: any) => row.name)).toEqual([
      'Zoning', 'Appeals', 'Unplaced',
    ]);
    expect(res.body.totalItems).toBe(3);
  });

  it('does NOT list another firm practice areas', async () => {
    await seedPracticeArea(otherFirm.id, { name: 'Confidential Practice' });
    await seedPracticeArea(firm.id, { name: 'Our Own Practice' });

    const res = await owner.api.get(P(firm.id));

    expect(res.body.practiceAreas.map((row: any) => row.name)).toEqual(['Our Own Practice']);
    expect(res.body.totalItems).toBe(1);
  });

  it('CHARACTERISATION: returns a single practice area unwrapped', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Family Law' });

    const res = await owner.api.get(P(firm.id, `/${id}`));

    // The entity sits at the root rather than in an envelope, unlike the list
    // beside it. The detail form reads `res.data.name`, so wrapping it breaks
    // that screen.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: 'Family Law' });
  });

  it('refuses to read ANOTHER firm practice area by id', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Confidential Practice' });
    expect((await owner.api.get(P(firm.id, `/${id}`))).status).toBe(200);

    const res = await otherOwner.api.get(P(otherFirm.id, `/${id}`));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Practice');
  });

  it('answers not-found for a malformed practice area id', async () => {
    const res = await owner.api.get(P(firm.id, '/not-a-uuid'));

    // uuid column: without the repository id guard this is a Postgres cast
    // error and a 500 rather than an ordinary refusal.
    expect(res.status).toBe(404);
  });

  it('CHARACTERISATION: a member with an empty role can still READ the list', async () => {
    await seedPracticeArea(firm.id, { name: 'Family Law' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(P(firm.id));

    // `practiceAreas.view` is in DEFAULT_PERMISSIONS, the baseline no role can
    // remove: the practice area is on the matter form every member fills in, so
    // withholding it produced a denial screen rather than confidentiality.
    // Moving it out of the baseline has to be a deliberate change.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Family Law');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedPracticeArea(firm.id, { name: 'Confidential Practice' });

    const res = await otherOwner.api.get(P(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Practice');
  });
});

describe('updating a practice area', () => {
  it('renames it', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Old Name' });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Practice area updated successfully');
    expect((await areaRow(id)).name).toBe('New Name');
  });

  it('leaves the matters filed under it pointing at the same row', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Family Law' });
    const matter = await seedMatter(firm.id, id);

    await owner.api.put(P(firm.id, `/${id}`)).send({ name: 'Matrimonial' });

    // The name is no longer denormalised onto matters: they join. A rename must
    // therefore touch nothing but this row, and every matter must keep its link.
    const { rows } = await testPool.query(
      'select practice_area_id from matters where id = $1',
      [matter.id],
    );
    expect(rows[0].practice_area_id).toBe(id);
  });

  it('refuses to update ANOTHER firm practice area and leaves it untouched', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Confidential Practice' });

    const res = await otherOwner.api.put(P(otherFirm.id, `/${id}`)).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await areaRow(id)).name).toBe('Confidential Practice');
  });

  it('refuses an empty name and leaves the row as it was', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Family Law' });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({ name: '' });

    expect(res.status).toBe(400);
    expect((await areaRow(id)).name).toBe('Family Law');
  });

  it('answers not-found for a practice area that does not exist', async () => {
    const res = await owner.api.put(P(firm.id, `/${randomUUID()}`)).send({ name: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('refuses a member holding only the view permission', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Family Law' });
    const viewer = await memberWith(firm.id, ['practiceAreas.view']);

    // Both halves, because a gate that refused everything would satisfy the
    // rename assertion on its own while quietly breaking the read-only role.
    expect((await viewer.api.get(P(firm.id, `/${id}`))).status).toBe(200);
    const res = await viewer.api.put(P(firm.id, `/${id}`)).send({ name: 'Renamed' });

    expect(res.status).toBe(403);
    expect((await areaRow(id)).name).toBe('Family Law');
  });
});

describe('deleting a practice area', () => {
  it('removes the row', async () => {
    const { id } = await seedPracticeArea(firm.id);

    const res = await owner.api.delete(P(firm.id, `/${id}`));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Practice area deleted successfully');
    expect(await areaCount(firm.id)).toBe(0);
  });

  it('unlinks it from a matter that referenced it, keeping the matter', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Family Law' });
    const matter = await seedMatter(firm.id, id);

    const res = await owner.api.delete(P(firm.id, `/${id}`));

    // `matters.practice_area_id` is a single-column FK with ON DELETE SET NULL,
    // chosen over the composite form so the tenant id is not nulled with it.
    // Retiring a practice group must never delete the matters filed under it.
    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select practice_area_id, law_firm_id from matters where id = $1',
      [matter.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ practice_area_id: null, law_firm_id: firm.id });
  });

  it('refuses to delete ANOTHER firm practice area', async () => {
    const { id } = await seedPracticeArea(firm.id, { name: 'Confidential Practice' });
    const matter = await seedMatter(firm.id, id);

    const res = await otherOwner.api.delete(P(otherFirm.id, `/${id}`));

    expect(res.status).toBe(404);
    expect(await areaCount(firm.id)).toBe(1);
    const { rows } = await testPool.query(
      'select practice_area_id from matters where id = $1',
      [matter.id],
    );
    expect(rows[0].practice_area_id).toBe(id);
  });

  it('answers not-found for a practice area that is already gone', async () => {
    const { id } = await seedPracticeArea(firm.id);
    expect((await owner.api.delete(P(firm.id, `/${id}`))).status).toBe(200);

    const res = await owner.api.delete(P(firm.id, `/${id}`));

    expect(res.status).toBe(404);
  });

  it('refuses a member holding only the view permission and keeps the row', async () => {
    const { id } = await seedPracticeArea(firm.id);
    const viewer = await memberWith(firm.id, ['practiceAreas.view']);

    const res = await viewer.api.delete(P(firm.id, `/${id}`));

    expect(res.status).toBe(403);
    expect(await areaCount(firm.id)).toBe(1);
  });
});
