/**
 * The matter activity feed.
 *
 * `matterActivity.repository.ts` was at 42% BRANCH coverage while its statements
 * looked fine: the feed is exercised incidentally by every spec that mutates a
 * matter, but nothing had ever passed it a page, an offset or a type filter.
 * Those are the branches that matter, because the feed doubles as an audit
 * trail:
 *
 *   THE TOTAL IS NOT THE PAGE. `totalItems` comes from a second COUNT query with
 *   its own copy of the predicate. If that copy ever diverges from the page
 *   query, the caller is told there is more history than exists, or stops paging
 *   early and silently loses the older half of the record. Both the paging case
 *   and the filter case below assert the total AND the page contents.
 *
 *   OFFSET MUST NOT OVERLAP OR SKIP. The fixtures are five distinct summaries at
 *   five distinct times, so a page that repeats a row or drops one is visible in
 *   an exact-list assertion rather than in a count.
 *
 *   ORDER IS NEWEST FIRST. The fixtures are inserted oldest-first so the
 *   expected result differs from insertion order; a read with no ORDER BY would
 *   fail rather than accidentally pass.
 *
 * Read access follows the matter, not the firm: an owner sees any matter, and
 * everyone else must be a member of it. The refusal case seeds real rows first,
 * so it cannot pass against a matter with no history.
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

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A
let matterA: string;

const FEED = (matterId = matterA, firm = () => firmA.id) =>
  `/api/lawfirms/${firm()}/matters/${matterId}/activity`;

async function seedMatter(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1,$2,$3,$4,'active') returning id`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function seedActivity(
  lawFirmId: string, matterId: string,
  seed: { summary: string; activityType?: string; createdAt: string },
): Promise<void> {
  const res = await testPool.query(
    `insert into activity_log (id, law_firm_id, matter_id, activity_type, summary, created_at)
     values ($1,$2,$3,$4,$5,$6::timestamptz)`,
    [
      randomUUID(), lawFirmId, matterId,
      seed.activityType ?? 'matter_updated', seed.summary, seed.createdAt,
    ],
  );
  expect(res.rowCount).toBe(1);
}

const summaries = (body: any): string[] => body.activity.map((a: any) => a.summary);

/** Five entries, inserted oldest first, one of them a note. */
async function seedFiveEntries(): Promise<void> {
  await seedActivity(firmA.id, matterA, { summary: 'First', createdAt: '2026-01-01T10:00:00Z' });
  await seedActivity(firmA.id, matterA, { summary: 'Second', createdAt: '2026-01-02T10:00:00Z' });
  await seedActivity(firmA.id, matterA, {
    summary: 'Third', activityType: 'note_added', createdAt: '2026-01-03T10:00:00Z',
  });
  await seedActivity(firmA.id, matterA, { summary: 'Fourth', createdAt: '2026-01-04T10:00:00Z' });
  await seedActivity(firmA.id, matterA, { summary: 'Fifth', createdAt: '2026-01-05T10:00:00Z' });
}

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
  matterA = await seedMatter(firmA.id, 'Host Matter');
});

describe('reading the feed', () => {
  it('returns the entries newest first', async () => {
    await seedFiveEntries();

    const res = await alice.api.get(FEED());

    expect(res.status).toBe(200);
    expect(summaries(res.body)).toEqual(['Fifth', 'Fourth', 'Third', 'Second', 'First']);
    expect(res.body.totalItems).toBe(5);
  });

  it('reports the whole history alongside a short page', async () => {
    await seedFiveEntries();

    const res = await alice.api.get(`${FEED()}?limit=2`);

    expect(res.status).toBe(200);
    expect(summaries(res.body)).toEqual(['Fifth', 'Fourth']);
    // The total is a separate query. Answering 2 here stops the caller paging
    // and quietly loses the older three entries.
    expect(res.body.totalItems).toBe(5);
  });

  it('pages by offset without repeating or skipping an entry', async () => {
    await seedFiveEntries();

    const second = await alice.api.get(`${FEED()}?limit=2&offset=2`);
    const third = await alice.api.get(`${FEED()}?limit=2&offset=4`);

    expect(second.status).toBe(200);
    expect(summaries(second.body)).toEqual(['Third', 'Second']);
    expect(third.status).toBe(200);
    expect(summaries(third.body)).toEqual(['First']);
  });

  it('narrows to the requested types and counts only those', async () => {
    await seedFiveEntries();

    const res = await alice.api.get(`${FEED()}?type=note_added`);

    expect(res.status).toBe(200);
    expect(summaries(res.body)).toEqual(['Third']);
    // The COUNT carries its own copy of the filter. Dropping it there reports 5.
    expect(res.body.totalItems).toBe(1);
  });

  it('accepts a repeated type parameter as a set', async () => {
    await seedFiveEntries();

    const res = await alice.api.get(`${FEED()}?type=note_added&type=matter_updated`);

    expect(res.status).toBe(200);
    expect(summaries(res.body)).toEqual(['Fifth', 'Fourth', 'Third', 'Second', 'First']);
    expect(res.body.totalItems).toBe(5);
  });

  it('clamps a nonsensical limit to a single entry rather than passing it to SQL', async () => {
    await seedFiveEntries();

    const res = await alice.api.get(`${FEED()}?limit=-5`);

    expect(res.status).toBe(200);
    expect(summaries(res.body)).toEqual(['Fifth']);
    expect(res.body.totalItems).toBe(5);
  });

  it('answers an empty feed with a zero total, not an error', async () => {
    const res = await alice.api.get(FEED());

    expect(res.status).toBe(200);
    expect(res.body.activity).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });
});

describe('access', () => {
  it('cannot read a matter belonging to another firm', async () => {
    const theirMatter = await seedMatter(firmB.id, 'Their Matter');
    await seedActivity(firmB.id, theirMatter, {
      summary: 'Their Privileged Note', createdAt: '2026-01-01T10:00:00Z',
    });

    const res = await alice.api.get(FEED(theirMatter));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Their Privileged Note');
  });

  it('refuses a firm member who is not on the matter', async () => {
    await seedFiveEntries();
    // Real history first: a refusal against an empty matter proves nothing.
    const outsider = await memberWith(firmA.id, ['matters.view']);

    const refused = await outsider.api.get(FEED());

    expect(JSON.stringify(refused.body)).not.toContain('Fifth');
    expect(refused.status).toBe(403);

    // The owner reads the same feed, so the refusal withheld five real entries.
    const allowed = await alice.api.get(FEED());
    expect(allowed.body.totalItems).toBe(5);
  });

  it('lets a member who is on the matter read it', async () => {
    await seedFiveEntries();
    const member = await memberWith(firmA.id, ['matters.view']);
    const joined = await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
       values ($1,$2,$3,'member', now())`,
      [firmA.id, matterA, member.uid],
    );
    expect(joined.rowCount).toBe(1);

    const res = await member.api.get(FEED());

    expect(res.status).toBe(200);
    expect(summaries(res.body)).toEqual(['Fifth', 'Fourth', 'Third', 'Second', 'First']);
  });
});
