/**
 * Clearing an optional matter field from the edit modal.
 *
 * The edit modal offers "None" for the practice area and lets the matter number
 * be emptied. Both are a legitimate request to remove the value, so the routes
 * must store null rather than refuse the request or answer success while
 * keeping the old value.
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

let firm: Firm;
let alice: Actor;

async function seedPracticeArea(name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into practice_areas (id, law_firm_id, name) values ($1, $2, $3) returning id`,
    [id, firm.id, name],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMatter(
  { practiceAreaId = null, matterNumber = null }: { practiceAreaId?: string | null; matterNumber?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const m = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, practice_area_id, matter_number)
     values ($1, $2, 'Estate Plan', $3, 'active', $4, $5) returning id`,
    [id, firm.id, `REF-${id.slice(0, 8)}`, practiceAreaId, matterNumber],
  );
  expect(m.rowCount).toBe(1);
  await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [firm.id, id, alice.uid],
  );
  return id;
}

const matterRow = async (matterId: string) => (await testPool.query(
  'select practice_area_id, matter_number from matters where id = $1', [matterId],
)).rows[0];

const practiceAreaPath = (matterId: string) =>
  `/api/lawfirms/${firm.id}/matters/${matterId}/update-practice-area`;

beforeEach(async () => {
  firm = await createFirm({ name: 'Alpha Legal' });
  alice = await ownerOf(firm.id);
  await drainEvents();
});

describe('clearing a matter\'s practice area', () => {
  it('clears it when the body sends null', async () => {
    const pa = await seedPracticeArea('Family');
    const matterId = await seedMatter({ practiceAreaId: pa });

    const res = await alice.api.post(practiceAreaPath(matterId)).send({ practiceAreaId: null });

    expect(res.status).toBe(200);
    expect((await matterRow(matterId)).practice_area_id).toBeNull();
  });

  it('clears it when the body sends an empty string', async () => {
    const pa = await seedPracticeArea('Family');
    const matterId = await seedMatter({ practiceAreaId: pa });

    const res = await alice.api.post(practiceAreaPath(matterId)).send({ practiceAreaId: '' });

    expect(res.status).toBe(200);
    expect((await matterRow(matterId)).practice_area_id).toBeNull();
  });

  it('still refuses a missing practiceAreaId, so an empty body cannot clear by accident', async () => {
    const pa = await seedPracticeArea('Family');
    const matterId = await seedMatter({ practiceAreaId: pa });

    const res = await alice.api.post(practiceAreaPath(matterId)).send({});

    expect(res.status).toBe(400);
    expect((await matterRow(matterId)).practice_area_id).toBe(pa);
  });

  it('still sets a practice area the firm owns', async () => {
    const pa = await seedPracticeArea('Family');
    const matterId = await seedMatter();

    const res = await alice.api.post(practiceAreaPath(matterId)).send({ practiceAreaId: pa });

    expect(res.status).toBe(200);
    expect((await matterRow(matterId)).practice_area_id).toBe(pa);
  });
});

describe('clearing a matter\'s number', () => {
  it('stores null when the update sends an empty matter number', async () => {
    const matterId = await seedMatter({ matterNumber: '2026-001' });

    const res = await alice.api.put(`/api/lawfirms/${firm.id}/matters/${matterId}`).send({ matterNumber: '' });

    expect(res.status).toBe(200);
    expect((await matterRow(matterId)).matter_number).toBeNull();
  });

  it('stores null for a whitespace-only matter number', async () => {
    const matterId = await seedMatter({ matterNumber: '2026-001' });

    const res = await alice.api.put(`/api/lawfirms/${firm.id}/matters/${matterId}`).send({ matterNumber: '   ' });

    expect(res.status).toBe(200);
    expect((await matterRow(matterId)).matter_number).toBeNull();
  });

  it('lets two matters in one firm both have no number', async () => {
    const first = await seedMatter({ matterNumber: '2026-001' });
    const second = await seedMatter({ matterNumber: '2026-002' });

    await alice.api.put(`/api/lawfirms/${firm.id}/matters/${first}`).send({ matterNumber: '' });
    const res = await alice.api.put(`/api/lawfirms/${firm.id}/matters/${second}`).send({ matterNumber: '' });

    expect(res.status).toBe(200);
    expect((await matterRow(first)).matter_number).toBeNull();
    expect((await matterRow(second)).matter_number).toBeNull();
  });

  it('keeps the number when the update omits it', async () => {
    const matterId = await seedMatter({ matterNumber: '2026-001' });

    const res = await alice.api.put(`/api/lawfirms/${firm.id}/matters/${matterId}`).send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect((await matterRow(matterId)).matter_number).toBe('2026-001');
  });
});
