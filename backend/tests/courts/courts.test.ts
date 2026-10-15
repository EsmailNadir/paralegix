/**
 * The firm's court list: create, read, rename, delete, and what happens to a
 * matter that points at a court somebody removes.
 *
 * The only coverage this module had was `tests/live/courts`, which drives one
 * real account against a deployed server. That suite has exactly one firm, so
 * it can neither express a member with a partial role nor ask what a SECOND firm
 * sees. Both of those are where the interesting failures are: the court list is
 * small and boring, but `courts.id` is referenced by `matters.court_id`, so a
 * delete that ignored the tenant scope would blank the court on another firm's
 * matters, and nothing on either firm's screen would look wrong.
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

const C = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/courts${suffix}`;

interface CourtOptions {
  name?: string;
  abbreviation?: string | null;
  city?: string | null;
  state?: string | null;
  courtType?: string | null;
  order?: number | null;
}

async function seedCourt(lawFirmId: string, options: CourtOptions = {}) {
  const id = randomUUID();
  await testPool.query(
    `insert into courts (id, law_firm_id, name, abbreviation, city, state, court_type, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      lawFirmId,
      options.name ?? `Court ${id.slice(0, 8)}`,
      options.abbreviation ?? null,
      options.city ?? null,
      options.state ?? null,
      options.courtType ?? null,
      options.order ?? null,
    ],
  );
  return { id };
}

/** A matter that points at a court, so the delete path has something to break. */
async function seedMatter(lawFirmId: string, courtId: string | null, name = 'Smith v. Jones') {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, court_id)
     values ($1, $2, $3, $4, $5)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`, courtId],
  );
  return { id };
}

const courtRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, abbreviation, city, state, court_type, law_firm_id from courts where id = $1',
    [id],
  );
  return rows[0];
};

const courtCount = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int n from courts where law_firm_id = $1',
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

describe('creating a court', () => {
  it('writes the court into the caller firm and nowhere else', async () => {
    const res = await owner.api.post(C(firm.id)).send({
      name: 'Kings County Supreme Court',
      abbreviation: 'KCSC',
      city: 'Brooklyn',
      state: 'NY',
      courtType: 'trial',
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Court created successfully');
    expect(await courtRow(res.body.courtId)).toMatchObject({
      name: 'Kings County Supreme Court',
      abbreviation: 'KCSC',
      city: 'Brooklyn',
      state: 'NY',
      court_type: 'trial',
      law_firm_id: firm.id,
    });
    expect(await courtCount(otherFirm.id)).toBe(0);
  });

  it('stores the optional fields as null when they are omitted', async () => {
    const res = await owner.api.post(C(firm.id)).send({ name: 'Bare Court' });

    // The service coalesces '' and undefined to null rather than passing them
    // through. An empty string would render as a blank abbreviation chip on the
    // matter header instead of the field being absent.
    expect(await courtRow(res.body.courtId)).toMatchObject({
      abbreviation: null,
      city: null,
      state: null,
      court_type: null,
    });
  });

  it('refuses an empty name and writes nothing', async () => {
    const res = await owner.api.post(C(firm.id)).send({ name: '' });

    expect(res.status).toBe(400);
    expect(await courtCount(firm.id)).toBe(0);
  });

  it('refuses a name past the length ceiling', async () => {
    const res = await owner.api.post(C(firm.id)).send({ name: 'x'.repeat(201) });

    expect(res.status).toBe(400);
    expect(await courtCount(firm.id)).toBe(0);
  });

  it('CHARACTERISATION: accepts a second court with the same name', async () => {
    await owner.api.post(C(firm.id)).send({ name: 'Kings County Supreme Court' });

    const res = await owner.api.post(C(firm.id)).send({ name: 'Kings County Supreme Court' });

    // There is no unique index on (law_firm_id, name) and no service-level
    // check, so duplicates are accepted and the dropdown shows the name twice.
    // Recorded rather than asserted as correct: adding the constraint is a
    // deliberate change, and this is the case that would have to move with it.
    expect(res.status).toBe(201);
    expect(await courtCount(firm.id)).toBe(2);
  });

  it('lets two different firms each hold a court of the same name', async () => {
    await owner.api.post(C(firm.id)).send({ name: 'Kings County Supreme Court' });

    const res = await otherOwner.api.post(C(otherFirm.id)).send({ name: 'Kings County Supreme Court' });

    // Any uniqueness added later must be per firm. A global one would let the
    // first firm to name a court reserve that name for the whole platform.
    expect(res.status).toBe(201);
    expect(await courtCount(otherFirm.id)).toBe(1);
  });

  it('refuses a member without courts.manage and writes nothing', async () => {
    const narrow = await memberWith(firm.id, ['practiceAreas.manage']);

    const res = await narrow.api.post(C(firm.id)).send({ name: 'Kings County Supreme Court' });

    expect(res.status).toBe(403);
    expect(await courtCount(firm.id)).toBe(0);
  });
});

describe('reading courts', () => {
  it('lists the firm courts ordered by sort order then name', async () => {
    await seedCourt(firm.id, { name: 'Zulu Court', order: 1 });
    await seedCourt(firm.id, { name: 'Alpha Court', order: 2 });
    await seedCourt(firm.id, { name: 'Unordered Court', order: null });

    const res = await owner.api.get(C(firm.id));

    expect(res.status).toBe(200);
    // sort_order first, and a court with no order sorts last rather than first.
    // Reverse that and every hand-ordered dropdown is led by the courts nobody
    // has placed.
    expect(res.body.courts.map((row: any) => row.name)).toEqual([
      'Zulu Court',
      'Alpha Court',
      'Unordered Court',
    ]);
    expect(res.body.totalItems).toBe(3);
  });

  it('does NOT list another firm courts', async () => {
    await seedCourt(otherFirm.id, { name: 'Confidential Tribunal' });
    await seedCourt(firm.id, { name: 'Our Own Court' });

    const res = await owner.api.get(C(firm.id));

    expect(res.body.courts.map((row: any) => row.name)).toEqual(['Our Own Court']);
    expect(res.body.totalItems).toBe(1);
  });

  it('CHARACTERISATION: returns a single court unwrapped, not in an envelope', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Kings County Supreme Court', state: 'NY' });

    const res = await owner.api.get(C(firm.id, `/${id}`));

    // Every other read in this module answers with an envelope. This one hands
    // back the entity at the root, and the frontend reads `res.data.name`
    // directly, so wrapping it would break the court detail form.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: 'Kings County Supreme Court', state: 'NY' });
  });

  it('refuses to read ANOTHER firm court by id', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Confidential Tribunal' });
    expect((await owner.api.get(C(firm.id, `/${id}`))).status).toBe(200);

    const res = await otherOwner.api.get(C(otherFirm.id, `/${id}`));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Tribunal');
  });

  it('answers not-found for a malformed court id rather than a database error', async () => {
    const res = await owner.api.get(C(firm.id, '/not-a-uuid'));

    // `courts.id` is uuid. Without the repository id guard this reaches Postgres
    // as a cast error and surfaces as a 500 on a mistyped or probed URL.
    expect(res.status).toBe(404);
  });

  it('refuses a member without courts.manage, which also gates the READ', async () => {
    await seedCourt(firm.id, { name: 'Confidential Tribunal' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(C(firm.id));

    // Unlike practice areas, courts has no separate view permission: the same
    // `courts.manage` code gates reading and writing. Recorded because a
    // narrow role therefore cannot see the court list at all.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Tribunal');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedCourt(firm.id, { name: 'Confidential Tribunal' });

    const res = await otherOwner.api.get(C(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Tribunal');
  });
});

describe('updating a court', () => {
  it('renames it', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Old Name' });

    const res = await owner.api.put(C(firm.id, `/${id}`)).send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Court updated successfully');
    expect((await courtRow(id)).name).toBe('New Name');
  });

  it('leaves the fields the request does not mention alone', async () => {
    const { id } = await seedCourt(firm.id, {
      name: 'Kings County', abbreviation: 'KC', city: 'Brooklyn', state: 'NY',
    });

    await owner.api.put(C(firm.id, `/${id}`)).send({ name: 'Kings County Supreme' });

    // The service builds its update from the keys actually present. Treat an
    // absent key as null instead and a rename silently wipes the address and
    // the abbreviation off the court.
    expect(await courtRow(id)).toMatchObject({
      name: 'Kings County Supreme', abbreviation: 'KC', city: 'Brooklyn', state: 'NY',
    });
  });

  it('clears the optional fields the request sends as null', async () => {
    const { id } = await seedCourt(firm.id, {
      name: 'Kings County', abbreviation: 'KC', city: 'Brooklyn', state: 'NY', courtType: 'State',
    });
    await testPool.query("update courts set address = '360 Adams St' where id = $1", [id]);

    const res = await owner.api.put(C(firm.id, `/${id}`)).send({
      name: 'Kings County', abbreviation: null, city: null, state: null, address: null, courtType: null,
    });

    // The settings form sends null for a field the user emptied. Refusing it,
    // or treating it as absent, leaves the old value on the court.
    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select address from courts where id = $1', [id]);
    expect(rows[0].address).toBeNull();
    expect(await courtRow(id)).toMatchObject({
      name: 'Kings County', abbreviation: null, city: null, state: null, court_type: null,
    });
  });

  it('refuses to update ANOTHER firm court and leaves it untouched', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Confidential Tribunal' });

    const res = await otherOwner.api.put(C(otherFirm.id, `/${id}`)).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await courtRow(id)).name).toBe('Confidential Tribunal');
  });

  it('refuses an empty name and leaves the court as it was', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Kings County' });

    const res = await owner.api.put(C(firm.id, `/${id}`)).send({ name: '' });

    expect(res.status).toBe(400);
    expect((await courtRow(id)).name).toBe('Kings County');
  });

  it('answers not-found for a court that does not exist', async () => {
    const res = await owner.api.put(C(firm.id, `/${randomUUID()}`)).send({ name: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('refuses a member without courts.manage and leaves the court as it was', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Kings County' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.put(C(firm.id, `/${id}`)).send({ name: 'Renamed' });

    expect(res.status).toBe(403);
    expect((await courtRow(id)).name).toBe('Kings County');
  });
});

describe('deleting a court', () => {
  it('removes the row', async () => {
    const { id } = await seedCourt(firm.id);

    const res = await owner.api.delete(C(firm.id, `/${id}`));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Court deleted successfully');
    expect(await courtCount(firm.id)).toBe(0);
  });

  it('unlinks the court from a matter that referenced it, keeping the matter', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Kings County' });
    const matter = await seedMatter(firm.id, id);

    const res = await owner.api.delete(C(firm.id, `/${id}`));

    // `matters.court_id` is a single-column FK with ON DELETE SET NULL, chosen
    // over the composite form precisely so the tenant id is not nulled with it.
    // Deleting a court a firm no longer uses must never delete or orphan the
    // matters filed in it.
    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select court_id, law_firm_id from matters where id = $1',
      [matter.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ court_id: null, law_firm_id: firm.id });
  });

  it('refuses to delete ANOTHER firm court', async () => {
    const { id } = await seedCourt(firm.id, { name: 'Confidential Tribunal' });
    const matter = await seedMatter(firm.id, id);

    const res = await otherOwner.api.delete(C(otherFirm.id, `/${id}`));

    expect(res.status).toBe(404);
    expect(await courtCount(firm.id)).toBe(1);
    // The matter still points at it. A delete that escaped the tenant scope
    // would blank this silently on a firm that never made the request.
    const { rows } = await testPool.query('select court_id from matters where id = $1', [matter.id]);
    expect(rows[0].court_id).toBe(id);
  });

  it('answers not-found for a court that is already gone', async () => {
    const { id } = await seedCourt(firm.id);
    expect((await owner.api.delete(C(firm.id, `/${id}`))).status).toBe(200);

    const res = await owner.api.delete(C(firm.id, `/${id}`));

    expect(res.status).toBe(404);
  });

  it('refuses a member without courts.manage and keeps the court', async () => {
    const { id } = await seedCourt(firm.id);
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.delete(C(firm.id, `/${id}`));

    expect(res.status).toBe(403);
    expect(await courtCount(firm.id)).toBe(1);
  });
});
