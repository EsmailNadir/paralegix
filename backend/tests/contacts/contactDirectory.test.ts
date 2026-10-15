/**
 * The firm-wide contact directory, and the per-matter links that hang off it.
 *
 * `contacts.repository.ts` was at 5.21%. A contact is an opposing counsel, an
 * expert, an adjuster or a judge: the people on the other side of a matter. Two
 * properties of this module are worth a suite of their own.
 *
 *   THE DIRECTORY IS FIRM-WIDE. Unlike matters and tasks, nothing about a
 *   contact is matter-scoped, so `law_firm_id` is the ONLY thing separating one
 *   firm's opposing counsel from another's. Every read path is a separate query
 *   -- list, search, typeahead, id-resolution, duplicate probe, tag menu, export
 *   -- and each can leak independently of the others. They are covered one by
 *   one below rather than through the list alone.
 *
 *   THE ROLE IS NOT ON THE CONTACT. `contacts.category` is what the person
 *   usually is; `matter_contacts.role` is what they are on ONE matter. The same
 *   attorney is opposing counsel on one matter and co-counsel on the next. If a
 *   role is written to the directory record instead of the link, the app shows
 *   that person as an expert on a matter where they are opposing counsel, and
 *   nothing on screen looks broken. Several cases exist only to pin that split.
 *
 * Search is `ILIKE '%term%'`, not full-text search. The `tsvector` columns that
 * used to exist here were dropped in migration 0140 because `to_tsvector` is the
 * wrong tool for this data: it tokenises an email as one indivisible unit and
 * its stop-word list swallows ordinary names. The search cases below are written
 * so that a return to full-text search turns them red.
 *
 * Fixtures are plain SQL through the test pool. A contact seeded through the
 * repository under test cannot expose a repository bug, because the same broken
 * code would produce both the row and the expectation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  memberWith,
  request,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A
let bob: Actor;     // owner at firm B

const DIR = () => `/api/lawfirms/${firmA.id}/contacts`;
const matterContacts = (matterId: string) =>
  `/api/lawfirms/${firmA.id}/matters/${matterId}/contacts`;

interface ContactSeed {
  name?: string;
  category?: string;
  contactType?: string;
  organization?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string[];
  isArchived?: boolean;
  oneTime?: boolean;
  courtId?: string | null;
}

/**
 * A directory contact, straight into the table.
 *
 * `returning id` plus the row-count assertion is not ceremony: a seed rejected
 * by a check constraint would otherwise surface several lines later as a 404 on
 * a lookup, and the failure would name the read rather than the seed.
 */
async function seedContact(lawFirmId: string, seed: ContactSeed = {}): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into contacts
       (id, law_firm_id, name, category, contact_type, organization, title,
        email, phone, tags, is_archived, one_time, court_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning id`,
    [
      id, lawFirmId,
      seed.name ?? `Contact ${id.slice(0, 8)}`,
      seed.category ?? 'other',
      seed.contactType ?? 'person',
      seed.organization ?? null,
      seed.title ?? null,
      seed.email ?? null,
      seed.phone ?? null,
      seed.tags ?? [],
      seed.isArchived ?? false,
      seed.oneTime ?? false,
      seed.courtId ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

/**
 * A matter with `memberUid` on it.
 *
 * The membership row is required, not decorative: every write route under
 * `/matters/:matterId/contacts` goes through `assertMatterMembership`, which
 * refuses a firm owner who is not on the matter.
 */
const seedMemberMatter = (lawFirmId: string, memberUid: string, name: string) =>
  seedMatter(lawFirmId, { name, memberUids: [memberUid] });

async function seedCourt(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into courts (id, law_firm_id, name) values ($1, $2, $3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

const contactRow = async (id: string) => {
  const { rows } = await testPool.query(
    `select law_firm_id, name, category, contact_type, organization, email,
            tags, is_archived, one_time, court_id, notes
       from contacts where id = $1`,
    [id],
  );
  return rows[0];
};

/** Every matter link for one directory contact, newest ordering irrelevant. */
const linkRows = async (contactId: string) => {
  const { rows } = await testPool.query(
    `select id, matter_id, contact_id, role, notes
       from matter_contacts where contact_id = $1 order by role`,
    [contactId],
  );
  return rows;
};

const linksOnMatter = async (matterId: string) => {
  const { rows } = await testPool.query(
    `select id, contact_id, role from matter_contacts where matter_id = $1`,
    [matterId],
  );
  return rows;
};

/** Names in a directory list response, so an assertion reads as a set of people. */
const namesIn = (body: { contacts?: Array<{ name: string }> }) =>
  (body.contacts as Array<{ name: string }>).map((c) => c.name);

beforeEach(async () => {
  firmA = await createFirm({ name: 'Alpha Legal' });
  firmB = await createFirm({ name: 'Bravo Legal' });
  alice = await ownerOf(firmA.id);
  bob = await ownerOf(firmB.id);
});

describe('tenant isolation across every read path', () => {
  // The directory is firm-wide and matter-independent, so law_firm_id is the
  // only boundary there is. Each of these is a DIFFERENT query in the
  // repository, and each seeds the other firm with a contact that WOULD match
  // if the scope were missing, so an empty result is never the reason a case
  // passes.

  it('lists this firm\'s contacts and not the other firm\'s', async () => {
    await seedContact(firmA.id, { name: 'Alpha Counsel' });
    await seedContact(firmB.id, { name: 'Bravo Counsel' });

    const res = await alice.api.get(DIR());

    expect(res.status).toBe(200);
    // Both halves matter. Asserting only the absence would pass against a
    // directory that returned nothing at all.
    expect(namesIn(res.body)).toContain('Alpha Counsel');
    expect(namesIn(res.body)).not.toContain('Bravo Counsel');
  });

  it('counts only this firm\'s contacts in totalItems', async () => {
    await seedContact(firmA.id, { name: 'Alpha Counsel' });
    await seedContact(firmB.id, { name: 'Bravo Counsel' });

    // `totalItems` comes from a `count(*) over()` on the paged CTE and is what
    // drives the pager. A count that included the other firm would show a page
    // of results the user can never reach.
    const res = await alice.api.get(`${DIR()}?limit=50`);

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(1);
  });

  it('does not surface another firm\'s contact through search', async () => {
    await seedContact(firmA.id, { name: 'Dana Sharpe' });
    await seedContact(firmB.id, { name: 'Dana Sharpe' });

    // Identical names on purpose: the search predicate matches both rows, so
    // only the tenant scope can keep the other firm's copy out.
    const res = await alice.api.get(`${DIR()}?search=Sharpe`);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].name).toBe('Dana Sharpe');
  });

  it('does not surface another firm\'s contact through the typeahead', async () => {
    await seedContact(firmA.id, { name: 'Dana Sharpe' });
    await seedContact(firmB.id, { name: 'Dana Sharpe' });

    const res = await alice.api.get(`${DIR()}/lookup?search=Dana`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('refuses to resolve another firm\'s contact id in the typeahead', async () => {
    const foreign = await seedContact(firmB.id, { name: 'Bravo Counsel' });

    // The `ids` branch of the lookup deliberately bypasses the archived and
    // matter filters so a saved selection stays labelled. It must NOT bypass
    // the tenant scope: this is the one read where a caller supplies the
    // primary key directly and could otherwise name any row in the table.
    const res = await alice.api.get(`${DIR()}/lookup?ids=${foreign}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('answers 404 for another firm\'s contact', async () => {
    const foreign = await seedContact(firmB.id, { name: 'Bravo Counsel' });

    const res = await alice.api.get(`${DIR()}/${foreign}`);

    expect(res.status).toBe(404);
  });

  it('leaves another firm\'s contact unchanged on an update attempt', async () => {
    const foreign = await seedContact(firmB.id, { name: 'Bravo Counsel' });

    const res = await alice.api.put(`${DIR()}/${foreign}`).send({ name: 'Renamed By Alpha' });

    expect(res.status).toBe(404);
    // The status alone would pass against a route that wrote the row and then
    // failed to read it back.
    expect((await contactRow(foreign)).name).toBe('Bravo Counsel');
  });

  it('leaves another firm\'s contact in place on a delete attempt', async () => {
    const foreign = await seedContact(firmB.id, { name: 'Bravo Counsel' });

    const res = await alice.api.delete(`${DIR()}/${foreign}`);

    expect(res.status).toBe(404);
    expect(await contactRow(foreign)).toBeDefined();
  });

  it('does not report another firm\'s contact as a possible duplicate', async () => {
    await seedContact(firmB.id, { name: 'Dana Sharpe', email: 'dana@sharpe.test' });

    // The duplicate probe matches on lower(name) / lower(email). A leak here
    // would tell one firm that another firm already knows this person.
    const res = await alice.api.get(`${DIR()}/duplicate-check?name=Dana%20Sharpe`);

    expect(res.status).toBe(200);
    expect(res.body.duplicates).toEqual([]);
  });

  it('does not list another firm\'s tags in the filter menu', async () => {
    await seedContact(firmA.id, { name: 'Alpha Counsel', tags: ['alpha-tag'] });
    await seedContact(firmB.id, { name: 'Bravo Counsel', tags: ['bravo-tag'] });

    const res = await alice.api.get(`${DIR()}/tags`);

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['alpha-tag']);
  });

  it('does not put another firm\'s contact in the CSV export', async () => {
    await seedContact(firmA.id, { name: 'Alpha Counsel' });
    await seedContact(firmB.id, { name: 'Bravo Counsel' });

    // The export is a separate read that a reviewer is unlikely to check, and
    // it produces a file that leaves the building.
    const res = await alice.api.get(`${DIR()}/export?format=csv`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Alpha Counsel');
    expect(res.text).not.toContain('Bravo Counsel');
  });

  it('refuses a caller who belongs to no firm at all', async () => {
    await seedContact(firmA.id, { name: 'Alpha Counsel' });

    const res = await bob.api.get(DIR());

    // Firm B's owner is a real, signed-in user with every permission at their
    // own firm. Membership is what stops them here.
    expect(res.status).toBe(403);
  });
});

describe('the per-matter role lives on the link, not on the contact', () => {
  // The design point of splitting `contacts` from `matter_contacts`. One
  // person, two matters, two different roles, and the directory record says
  // what they usually are rather than what they are here.

  let counselId: string;
  let matterOne: string;
  let matterTwo: string;

  beforeEach(async () => {
    counselId = await seedContact(firmA.id, {
      name: 'Marina Vance',
      category: 'opposing_counsel',
      organization: 'Vance & Pryor',
    });
    matterOne = await seedMemberMatter(firmA.id, alice.uid, 'Hollis v. Redline');
    matterTwo = await seedMemberMatter(firmA.id, alice.uid, 'Estate of Bramwell');
  });

  it('stores two different roles for the same contact on two matters', async () => {
    const first = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });
    const second = await alice.api.post(matterContacts(matterTwo))
      .send({ contactId: counselId, role: 'expert' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Read from the table rather than the responses: a role echoed back from
    // the request body would satisfy the response assertion while never
    // reaching the link.
    expect((await linkRows(counselId)).map((r) => r.role)).toEqual(['expert', 'opposing_counsel']);
  });

  it('keeps ONE directory record behind both matter links', async () => {
    await alice.api.post(matterContacts(matterOne)).send({ contactId: counselId, role: 'opposing_counsel' });
    await alice.api.post(matterContacts(matterTwo)).send({ contactId: counselId, role: 'expert' });

    const links = await linkRows(counselId);
    expect(links).toHaveLength(2);
    // The whole reason the directory exists: a corrected phone number is
    // corrected once. Two contact rows would defeat it silently.
    expect(new Set(links.map((r) => r.contact_id)).size).toBe(1);
  });

  it('does not write the matter role onto the directory record', async () => {
    await alice.api.post(matterContacts(matterTwo)).send({ contactId: counselId, role: 'expert' });

    // If the role were written here, Marina Vance would read as an expert on
    // every matter she appears on, including the one where she is opposing
    // counsel.
    expect((await contactRow(counselId)).category).toBe('opposing_counsel');
  });

  it('reports both matters and both roles on the contact page', async () => {
    await alice.api.post(matterContacts(matterOne)).send({ contactId: counselId, role: 'opposing_counsel' });
    await alice.api.post(matterContacts(matterTwo)).send({ contactId: counselId, role: 'expert' });

    const res = await alice.api.get(`${DIR()}/${counselId}`);

    expect(res.status).toBe(200);
    const byMatter = Object.fromEntries(
      res.body.matters.map((m: { matterId: string; role: string }) => [m.matterId, m.role]),
    );
    expect(byMatter[matterOne]).toBe('opposing_counsel');
    expect(byMatter[matterTwo]).toBe('expert');
  });

  it('changes one matter\'s role without touching the other\'s', async () => {
    const first = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });
    await alice.api.post(matterContacts(matterTwo)).send({ contactId: counselId, role: 'expert' });
    expect(first.status).toBe(201);

    const res = await alice.api.put(`${matterContacts(matterOne)}/${first.body.contact.id}`)
      .send({ role: 'co_counsel' });

    expect(res.status).toBe(200);
    const roles = Object.fromEntries((await linkRows(counselId)).map((r) => [r.matter_id, r.role]));
    expect(roles[matterOne]).toBe('co_counsel');
    expect(roles[matterTwo]).toBe('expert');
  });

  it('does not let a role change edit the shared directory record', async () => {
    const link = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });
    expect(link.status).toBe(201);

    await alice.api.put(`${matterContacts(matterOne)}/${link.body.contact.id}`)
      .send({ role: 'witness', notes: 'Served on 3 March' });

    const row = await contactRow(counselId);
    expect(row.category).toBe('opposing_counsel');
    // The matter note belongs to the link. On the contact it would follow
    // Marina Vance onto every other matter she is on.
    expect(row.notes).toBeNull();
  });

  it('keeps the matter note on the link', async () => {
    const link = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel', notes: 'Prefers service by email' });

    expect(link.status).toBe(201);
    expect((await linkRows(counselId))[0].notes).toBe('Prefers service by email');
  });

  it('refuses to link the same contact to one matter twice', async () => {
    await alice.api.post(matterContacts(matterOne)).send({ contactId: counselId, role: 'opposing_counsel' });

    const res = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'expert' });

    // A second row would give the matter two copies of one person with
    // conflicting roles, which is exactly what the unique link constraint and
    // this check exist to prevent. The role change is an update, not a new row.
    expect(res.status).toBe(409);
    expect(await linksOnMatter(matterOne)).toHaveLength(1);
  });

  it('refuses a role outside the per-matter vocabulary', async () => {
    // `vendor` and `court_reporter` are valid directory CATEGORIES but not
    // matter roles; the link's check constraint does not accept them, so a
    // value that got past validation would be a 500.
    const res = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'vendor' });

    expect(res.status).toBe(400);
  });

  it('refuses to link another firm\'s contact to this firm\'s matter', async () => {
    const foreign = await seedContact(firmB.id, { name: 'Bravo Counsel' });

    const res = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: foreign, role: 'expert' });

    expect(res.status).toBe(404);
    expect(await linksOnMatter(matterOne)).toEqual([]);
  });
});

describe('detaching a contact from a matter', () => {
  let counselId: string;
  let matterOne: string;
  let matterTwo: string;

  beforeEach(async () => {
    counselId = await seedContact(firmA.id, { name: 'Marina Vance', category: 'opposing_counsel' });
    matterOne = await seedMemberMatter(firmA.id, alice.uid, 'Hollis v. Redline');
    matterTwo = await seedMemberMatter(firmA.id, alice.uid, 'Estate of Bramwell');
  });

  it('removes the link and keeps the directory record', async () => {
    const link = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });
    expect(link.status).toBe(201);

    const res = await alice.api.delete(`${matterContacts(matterOne)}/${link.body.contact.id}`);

    expect(res.status).toBe(200);
    expect(await linksOnMatter(matterOne)).toEqual([]);
    // The point of the whole test: taking someone off one matter must not
    // erase them from the firm's address book.
    expect(await contactRow(counselId)).toBeDefined();
  });

  it('leaves the contact reachable in the directory after detaching', async () => {
    const link = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });
    await alice.api.delete(`${matterContacts(matterOne)}/${link.body.contact.id}`);

    const res = await alice.api.get(DIR());

    expect(res.status).toBe(200);
    expect(namesIn(res.body)).toContain('Marina Vance');
  });

  it('leaves the other matter\'s link alone', async () => {
    const first = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });
    await alice.api.post(matterContacts(matterTwo)).send({ contactId: counselId, role: 'expert' });

    await alice.api.delete(`${matterContacts(matterOne)}/${first.body.contact.id}`);

    const remaining = await linkRows(counselId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].matter_id).toBe(matterTwo);
  });

  it('deletes a ONE-TIME contact from the directory when its only link goes', async () => {
    const created = await alice.api.post(matterContacts(matterOne))
      .send({ name: 'Process Server Dan', role: 'other', oneTime: true });
    expect(created.status).toBe(201);
    const contactId = created.body.contact.contactId;
    expect((await contactRow(contactId)).one_time).toBe(true);

    await alice.api.delete(`${matterContacts(matterOne)}/${created.body.contact.id}`);

    // A one-time contact is excluded from every picker, so it can never gain a
    // second link. Leaving the row behind would accumulate rows nothing can
    // reach.
    expect(await contactRow(contactId)).toBeUndefined();
  });

  it('refuses to detach through a matter the link does not belong to', async () => {
    const link = await alice.api.post(matterContacts(matterOne))
      .send({ contactId: counselId, role: 'opposing_counsel' });

    const res = await alice.api.delete(`${matterContacts(matterTwo)}/${link.body.contact.id}`);

    expect(res.status).toBe(404);
    expect(await linksOnMatter(matterOne)).toHaveLength(1);
  });
});

describe('creating a directory contact', () => {
  it('creates one and returns its id', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance', category: 'opposing_counsel' });

    expect(res.status).toBe(201);
    const row = await contactRow(res.body.contactId);
    expect(row.name).toBe('Marina Vance');
    expect(row.law_firm_id).toBe(firmA.id);
  });

  it('defaults an unspecified category to other', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance' });

    expect(res.status).toBe(201);
    expect((await contactRow(res.body.contactId)).category).toBe('other');
  });

  it('refuses a blank name', async () => {
    const res = await alice.api.post(DIR()).send({ name: '   ' });

    // Whitespace passes Zod's `min(1)` and is caught by the service's own trim.
    // A directory entry with no name is unreachable in every picker, which
    // sorts and labels by name.
    expect(res.status).toBe(400);
  });

  it('refuses a missing name', async () => {
    const res = await alice.api.post(DIR()).send({ category: 'expert' });

    expect(res.status).toBe(400);
  });

  it('refuses a category outside the vocabulary', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance', category: 'archnemesis' });

    // The category drives the filter menu and the check constraint. An
    // unrecognised value is a 500 at the database if it gets that far.
    expect(res.status).toBe(400);
  });

  it('refuses a court belonging to another firm', async () => {
    const foreignCourt = await seedCourt(firmB.id, 'Bravo County Superior');

    const res = await alice.api.post(DIR())
      .send({ name: 'Judge Okonjo', category: 'judge', courtId: foreignCourt });

    // `contacts.court_id` is a single-column FK, so the database alone would
    // accept this and hang one firm's judge off another firm's courthouse.
    // The service is the only tenant boundary on that column.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/court/i);
  });

  it('accepts a court belonging to this firm', async () => {
    const court = await seedCourt(firmA.id, 'Alpha County Superior');

    const res = await alice.api.post(DIR())
      .send({ name: 'Judge Okonjo', category: 'judge', courtId: court });

    // The refusal above is only meaningful next to this: it has to reject the
    // other firm's court specifically, not every court.
    expect(res.status).toBe(201);
    expect((await contactRow(res.body.contactId)).court_id).toBe(court);
  });

  it('de-duplicates tags case-insensitively but stores them as typed', async () => {
    const res = await alice.api.post(DIR())
      .send({ name: 'Marina Vance', tags: ['Expert', 'expert', '  EXPERT  ', 'Retained'] });

    expect(res.status).toBe(201);
    // One entry in the filter menu, spelled the way the first person typed it.
    // Storing all four would show four indistinguishable filter options.
    expect((await contactRow(res.body.contactId)).tags).toEqual(['Expert', 'Retained']);
  });

  it('trims a padded field to null rather than storing whitespace', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance', organization: '   ' });

    expect(res.status).toBe(201);
    // A whitespace organization is not null, so it defeats every `is not null`
    // filter and renders as a blank line in the UI.
    expect((await contactRow(res.body.contactId)).organization).toBeNull();
  });

  it('records the creating user', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance' });

    const { rows } = await testPool.query('select created_by from contacts where id = $1', [res.body.contactId]);
    expect(rows[0].created_by).toBe(alice.uid);
  });

  it('refuses a member who may view the directory but not manage it', async () => {
    const reader = await memberWith(firmA.id, ['contacts.view']);

    const res = await reader.api.post(DIR()).send({ name: 'Marina Vance' });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select count(*)::int n from contacts where law_firm_id = $1', [firmA.id],
    );
    // Proving the write did not happen, not just that the response said no.
    expect(rows[0].n).toBe(0);
  });

  it('refuses a matter member without contacts.manage the inline-create path', async () => {
    const editor = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const matterId = await seedMemberMatter(firmA.id, editor.uid, 'Hollis v. Redline');

    const res = await editor.api.post(matterContacts(matterId))
      .send({ name: 'Brand New Counsel', role: 'opposing_counsel' });

    // `matters.update` lets a member arrange their own matter. Creating a
    // directory record every other matter can see is a firm-wide write and
    // needs the firm-wide permission.
    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select count(*)::int n from contacts where law_firm_id = $1`, [firmA.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('lets a matter member link an EXISTING contact without contacts.manage', async () => {
    const editor = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const matterId = await seedMemberMatter(firmA.id, editor.uid, 'Hollis v. Redline');
    const counselId = await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await editor.api.post(matterContacts(matterId))
      .send({ contactId: counselId, role: 'opposing_counsel' });

    // The counterpart to the refusal above. Linking writes only to this
    // matter, so `matters.update` is the right gate and the stricter check
    // must not spill onto it.
    expect(res.status).toBe(201);
    expect(await linksOnMatter(matterId)).toHaveLength(1);
  });

  it('ignores an isArchived field sent on create', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance', isArchived: true });

    expect(res.status).toBe(201);
    // `createContactSchema` has no `isArchived` field at all -- a brand-new
    // directory entry cannot be born archived. If the service ever grew a raw
    // `data.isArchived` read (or started spreading the body), this starts
    // failing instead of silently letting a caller create a pre-archived row.
    expect((await contactRow(res.body.contactId)).is_archived).toBe(false);
  });

  it('refuses more than 25 tags', async () => {
    const tags = Array.from({ length: 26 }, (_, i) => `tag-${i}`);
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance', tags });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from contacts where law_firm_id = $1', [firmA.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a single tag longer than 50 characters', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance', tags: ['x'.repeat(51)] });

    expect(res.status).toBe(400);
  });

  it('refuses a name longer than 300 characters', async () => {
    const res = await alice.api.post(DIR()).send({ name: 'x'.repeat(301) });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from contacts where law_firm_id = $1', [firmA.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('list query validation', () => {
  it('refuses an unknown sortBy field', async () => {
    // `CONTACT_SORT_FIELDS` is the whitelist the repository's ORDER BY honours.
    // An unrecognised value has to be a 400, not something the repository
    // silently drops from the query.
    const res = await alice.api.get(DIR()).query({ sortBy: 'ssn' });

    expect(res.status).toBe(400);
  });
});

describe('authorization runs before an unvalidated id reaches the database', () => {
  it('refuses an anonymous caller with a malformed contact id', async () => {
    // Neither GET, PUT nor DELETE /:contactId validates the id shape with Zod --
    // `verifyToken` has to be the thing that stops a garbage id here, not a
    // downstream lookup.
    const res = await request().get(`${DIR()}/not-a-valid-uuid-at-all`);

    expect(res.status).toBe(401);
  });
});

describe('search is ILIKE, not full-text search', () => {
  // Each case below is a query that `to_tsvector('english', …)` answers wrongly.
  // Together they are the regression fence around migration 0140.

  it('matches a fragment from the MIDDLE of a word', async () => {
    await seedContact(firmA.id, { name: 'Rutherford' });
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}?search=utherfo`);

    // A tsvector match is on whole lexemes and a prefix at best; it cannot
    // answer this at all. So can a `term%` pattern, which is why the fragment
    // deliberately starts inside the word.
    expect(namesIn(res.body)).toEqual(['Rutherford']);
  });

  it('matches regardless of case', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}?search=VANCE`);

    expect(namesIn(res.body)).toEqual(['Marina Vance']);
  });

  it('matches inside an email address', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', email: 'marina@vance-pryor.test' });
    await seedContact(firmA.id, { name: 'Other Person', email: 'other@elsewhere.test' });

    const res = await alice.api.get(`${DIR()}?search=vance-pryor`);

    // Full-text search tokenises an email as ONE indivisible unit, so a search
    // for the domain returned nothing. This is one of the reasons the tsvector
    // column was dropped.
    expect(namesIn(res.body)).toEqual(['Marina Vance']);
  });

  it('matches a name that the english stop-word list swallows', async () => {
    await seedContact(firmA.id, { name: 'Will Draper' });

    // "will" is an english stop word, so `to_tsvector` dropped it entirely and
    // searching for this person returned nothing at all.
    const res = await alice.api.get(`${DIR()}?search=will`);

    expect(namesIn(res.body)).toEqual(['Will Draper']);
  });

  it('searches the organization', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', organization: 'Vance & Pryor' });
    await seedContact(firmA.id, { name: 'Other Person', organization: 'Elsewhere LLP' });

    const res = await alice.api.get(`${DIR()}?search=Pryor`);

    expect(namesIn(res.body)).toEqual(['Marina Vance']);
  });

  it('searches the title and phone on the directory list', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', title: 'Managing Partner' });
    await seedContact(firmA.id, { name: 'Reachable', phone: '555-0147' });

    const byTitle = await alice.api.get(`${DIR()}?search=Managing`);
    const byPhone = await alice.api.get(`${DIR()}?search=0147`);

    expect(namesIn(byTitle.body)).toEqual(['Marina Vance']);
    expect(namesIn(byPhone.body)).toEqual(['Reachable']);
  });

  it('does NOT search the title in the typeahead', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', title: 'Managing Partner' });

    const list = await alice.api.get(`${DIR()}?search=Managing`);
    const lookup = await alice.api.get(`${DIR()}/lookup?search=Managing`);

    // The asymmetry is deliberate: the typeahead fires per keystroke and
    // searches only the fields it shows. Pinning both halves means a change to
    // either one is a decision rather than an accident.
    expect(namesIn(list.body)).toHaveLength(1);
    expect(lookup.body.items).toEqual([]);
  });

  it('treats a percent sign as a literal character', async () => {
    await seedContact(firmA.id, { name: 'Alpha%Beta' });
    await seedContact(firmA.id, { name: 'AlphaXBeta' });

    const res = await alice.api.get(`${DIR()}?search=${encodeURIComponent('%')}`);

    // Unescaped, `%` is the ILIKE wildcard and this returns the whole
    // directory. That is a search box that silently ignores what was typed.
    expect(namesIn(res.body)).toEqual(['Alpha%Beta']);
  });

  it('treats an underscore as a literal character', async () => {
    await seedContact(firmA.id, { name: 'Alpha_Beta' });
    await seedContact(firmA.id, { name: 'AlphaXBeta' });

    const res = await alice.api.get(`${DIR()}?search=${encodeURIComponent('Alpha_Beta')}`);

    // `_` is the single-character ILIKE wildcard, so unescaped this matches
    // both names.
    expect(namesIn(res.body)).toEqual(['Alpha_Beta']);
  });

  it('returns the whole directory for a blank search rather than nothing', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}?search=${encodeURIComponent('   ')}`);

    // `toIlikeTerm` returns null for an empty term so the predicate is skipped
    // entirely. Filtering on '%%' would be equivalent here but not for a null
    // column, and an empty result would be wrong either way.
    expect(namesIn(res.body)).toEqual(['Marina Vance']);
  });
});

describe('what the directory hides by default', () => {
  it('hides archived contacts', async () => {
    await seedContact(firmA.id, { name: 'Retired Counsel', isArchived: true });
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(DIR());

    expect(namesIn(res.body)).toEqual(['Marina Vance']);
  });

  it('shows archived contacts when asked', async () => {
    await seedContact(firmA.id, { name: 'Retired Counsel', isArchived: true });
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}?archived=all`);

    // Archiving is the non-destructive alternative to deleting, so the records
    // have to remain retrievable.
    expect(namesIn(res.body).sort()).toEqual(['Marina Vance', 'Retired Counsel']);
  });

  it('hides one-time contacts from the shared directory', async () => {
    await seedContact(firmA.id, { name: 'Process Server Dan', oneTime: true });
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(DIR());

    // A one-time contact belongs to the single matter it was created for.
    // Leaving it in the shared list is how a directory fills with people
    // nobody recognises.
    expect(namesIn(res.body)).toEqual(['Marina Vance']);
  });

  it('keeps an archived contact out of the typeahead', async () => {
    await seedContact(firmA.id, { name: 'Retired Counsel', isArchived: true });

    const res = await alice.api.get(`${DIR()}/lookup?search=Retired`);

    expect(res.body.items).toEqual([]);
  });

  it('still resolves an archived contact by id, so a saved selection stays labelled', async () => {
    const archived = await seedContact(firmA.id, { name: 'Retired Counsel', isArchived: true });

    const res = await alice.api.get(`${DIR()}/lookup?ids=${archived}`);

    // The counterpart to the case above. A selection saved before the contact
    // was archived would otherwise render as a bare uuid.
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].label).toBe('Retired Counsel');
  });

  it('drops contacts already on a matter from that matter\'s picker', async () => {
    const linked = await seedContact(firmA.id, { name: 'Already On It' });
    await seedContact(firmA.id, { name: 'Not Yet Linked' });
    const matterId = await seedMemberMatter(firmA.id, alice.uid, 'Hollis v. Redline');
    const link = await alice.api.post(matterContacts(matterId)).send({ contactId: linked, role: 'expert' });
    expect(link.status).toBe(201);

    const res = await alice.api.get(`${DIR()}/lookup?excludeMatterId=${matterId}`);

    // Offering a contact the matter already has produces a 409 on selection.
    expect(res.body.items.map((i: { label: string }) => i.label)).toEqual(['Not Yet Linked']);
  });

  it('filters the directory down to one matter\'s contacts', async () => {
    const onMatter = await seedContact(firmA.id, { name: 'On The Matter' });
    await seedContact(firmA.id, { name: 'Elsewhere Entirely' });
    const matterId = await seedMemberMatter(firmA.id, alice.uid, 'Hollis v. Redline');
    const link = await alice.api.post(matterContacts(matterId)).send({ contactId: onMatter, role: 'expert' });
    expect(link.status).toBe(201);

    const res = await alice.api.get(`${DIR()}?matterId=${matterId}`);

    expect(namesIn(res.body)).toEqual(['On The Matter']);
  });

  it('returns nothing rather than erroring for a malformed matter filter', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}?matterId=not-a-uuid`);

    // `matter_id` is a uuid column, so an unguarded value reaches Postgres as a
    // cast error and surfaces as a 500 on an ordinary list read.
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([]);
  });

  it('returns 404 rather than erroring for a malformed contact id', async () => {
    const res = await alice.api.get(`${DIR()}/not-a-uuid`);

    expect(res.status).toBe(404);
  });
});

describe('deleting a directory contact', () => {
  it('reports how many matters the contact was removed from', async () => {
    const counselId = await seedContact(firmA.id, { name: 'Marina Vance' });
    const matterOne = await seedMemberMatter(firmA.id, alice.uid, 'Hollis v. Redline');
    const matterTwo = await seedMemberMatter(firmA.id, alice.uid, 'Estate of Bramwell');
    for (const matterId of [matterOne, matterTwo]) {
      const link = await alice.api.post(matterContacts(matterId))
        .send({ contactId: counselId, role: 'expert' });
      expect(link.status).toBe(201);
    }

    const res = await alice.api.delete(`${DIR()}/${counselId}`);

    expect(res.status).toBe(200);
    // The count is what the UI warns with before the delete. Reporting zero
    // while cascading two links is how someone deletes a contact off two live
    // matters believing it was unused.
    expect(res.body.unlinkedMatters).toBe(2);
    expect(await linkRows(counselId)).toEqual([]);
  });

  it('reports zero for a contact on no matters', async () => {
    const counselId = await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.delete(`${DIR()}/${counselId}`);

    expect(res.body.unlinkedMatters).toBe(0);
    expect(await contactRow(counselId)).toBeUndefined();
  });
});

describe('the duplicate probe on the create form', () => {
  it('reports an existing contact with the same name', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}/duplicate-check?name=marina%20vance`);

    // Matched on lower(name): a firm that types the name differently cased
    // should still be warned.
    expect(res.body.duplicates.map((d: { name: string }) => d.name)).toEqual(['Marina Vance']);
  });

  it('reports a match on email alone', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', email: 'marina@vance-pryor.test' });

    const res = await alice.api.get(
      `${DIR()}/duplicate-check?email=${encodeURIComponent('MARINA@vance-pryor.test')}`,
    );

    expect(res.body.duplicates).toHaveLength(1);
  });

  it('reports nothing when neither name nor email is supplied', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.get(`${DIR()}/duplicate-check`);

    // With no criteria the probe must not fall through to "every contact",
    // which is what an empty match list would do if it reached SQL.
    expect(res.body.duplicates).toEqual([]);
  });

  it('does not offer an archived contact as the duplicate to reuse', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', isArchived: true });

    const res = await alice.api.get(`${DIR()}/duplicate-check?name=Marina%20Vance`);

    // The warning offers to link the existing contact instead. Offering an
    // archived one puts a deliberately retired record back into use.
    expect(res.body.duplicates).toEqual([]);
  });

  it('never blocks the create itself', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.post(DIR()).send({ name: 'Marina Vance' });

    // Two real people share a name, and the schema deliberately carries no
    // unique constraint on (firm, name). The probe is advisory only.
    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select count(*)::int n from contacts where law_firm_id = $1 and name = 'Marina Vance'`,
      [firmA.id],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe('importing a contact file', () => {
  it('creates a contact per CSV row', async () => {
    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'csv',
      content: 'Name,Email,Category\nMarina Vance,marina@vance-pryor.test,opposing_counsel\nDr Ivo Prei,ivo@labs.test,expert\n',
    });

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(2);
    const list = await alice.api.get(DIR());
    expect(namesIn(list.body).sort()).toEqual(['Dr Ivo Prei', 'Marina Vance']);
  });

  it('skips a row that already exists rather than duplicating it', async () => {
    const existing = await seedContact(firmA.id, { name: 'Marina Vance', email: 'marina@vance-pryor.test' });

    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'csv',
      content: 'Name,Email\nMarina Vance,marina@vance-pryor.test\n',
    });

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(0);
    // The report names the row that was skipped and the record it matched, so
    // the UI can say what happened instead of implying everything landed.
    expect(res.body.skipped).toEqual([{ row: 1, name: 'Marina Vance', existingContactId: existing }]);
  });

  it('skips the second occurrence of a contact within one file', async () => {
    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'csv',
      content: 'Name,Email\nMarina Vance,marina@vance-pryor.test\nMarina Vance,marina@vance-pryor.test\n',
    });

    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    // The within-file duplicate is pointed at the row that actually got
    // created, which is only knowable after the create finishes.
    expect(res.body.skipped[0].existingContactId).toBe(res.body.contacts[0].id);
  });

  it('reports a row number the user can find in their own file', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', email: 'marina@vance-pryor.test' });

    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'csv',
      // Three data rows under the header. Row 1 has no name, row 2 is new, and
      // row 3 duplicates the contact seeded above.
      content: 'Name,Email\n,orphan@nowhere.test\nDr Ivo Prei,ivo@labs.test\nMarina Vance,marina@vance-pryor.test\n',
    });

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(1);
    // The skipped duplicate is on data row 3 of the file the user is looking
    // at. `row` is the only handle they have for finding it, so a number that
    // points at a different line sends them to edit the wrong contact.
    expect(res.body.skipped).toEqual([
      { row: 3, name: 'Marina Vance', existingContactId: expect.any(String) },
    ]);
  });

  it('REPORTS a row that has no name instead of silently dropping it', async () => {
    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'csv',
      content: 'Name,Email\n,orphan@nowhere.test\nMarina Vance,marina@vance-pryor.test\n',
    });

    // A nameless row used to vanish between the parser and the importer, so a
    // firm importing a 500-row address book with 12 unusable rows was told 488
    // imported and nothing failed. The count and the file no longer agree, and
    // nothing tells them which lines to look at.
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].row).toBe(1);
    expect(res.body.failed[0].reason).toMatch(/no name/i);
  });

  it('numbers vCards by their position in the file', async () => {
    await seedContact(firmA.id, { name: 'Marina Vance', email: 'marina@vance-pryor.test' });

    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'vcard',
      content: [
        'BEGIN:VCARD\nVERSION:3.0\nEMAIL:orphan@nowhere.test\nEND:VCARD',
        'BEGIN:VCARD\nVERSION:3.0\nFN:Dr Ivo Prei\nEMAIL:ivo@labs.test\nEND:VCARD',
        'BEGIN:VCARD\nVERSION:3.0\nFN:Marina Vance\nEMAIL:marina@vance-pryor.test\nEND:VCARD',
      ].join('\n'),
    });

    // The same drift as the CSV path, through a different parser. Card 1 has no
    // FN and card 3 duplicates an existing contact; the report must name card 3,
    // not card 2. Both parsers dropped nameless entries, so both had to carry
    // the source position for either report to be usable.
    expect(res.body.imported).toBe(1);
    expect(res.body.failed[0].row).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].row).toBe(3);
  });

  it('refuses a file nothing could be read from', async () => {
    const res = await alice.api.post(`${DIR()}/import`).send({ format: 'csv', content: 'not a csv at all' });

    expect(res.status).toBe(400);
  });

  it('refuses an import payload above two megabytes before parsing or creating contacts', async () => {
    const res = await alice.api.post(`${DIR()}/import`).send({
      format: 'csv',
      content: `Name\n${'x'.repeat(2_000_000)}`,
    });

    // The importer is deliberately concurrency-bounded, not row-count-bound.
    // Reject the oversized raw payload before it can allocate a massive row or
    // begin creating any directory records.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from contacts where law_firm_id = $1',
      [firmA.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('updating a directory contact', () => {
  it('leaves an omitted field untouched', async () => {
    const counselId = await seedContact(firmA.id, {
      name: 'Marina Vance', organization: 'Vance & Pryor', category: 'opposing_counsel',
    });

    const res = await alice.api.put(`${DIR()}/${counselId}`).send({ title: 'Managing Partner' });

    expect(res.status).toBe(200);
    const row = await contactRow(counselId);
    // A partial patch that blanked everything else would wipe a contact
    // record on an edit to one field.
    expect(row.organization).toBe('Vance & Pryor');
    expect(row.category).toBe('opposing_counsel');
  });

  it('clears a field when null is sent explicitly', async () => {
    const counselId = await seedContact(firmA.id, { name: 'Marina Vance', organization: 'Vance & Pryor' });

    await alice.api.put(`${DIR()}/${counselId}`).send({ organization: null });

    // The counterpart to the case above: omission and an explicit null have to
    // mean different things, or a field can never be emptied.
    expect((await contactRow(counselId)).organization).toBeNull();
  });

  it('refuses to blank the name', async () => {
    const counselId = await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.put(`${DIR()}/${counselId}`).send({ name: '   ' });

    expect(res.status).toBe(400);
    expect((await contactRow(counselId)).name).toBe('Marina Vance');
  });

  it('archives a contact without deleting it', async () => {
    const counselId = await seedContact(firmA.id, { name: 'Marina Vance' });

    const res = await alice.api.put(`${DIR()}/${counselId}`).send({ isArchived: true });

    expect(res.status).toBe(200);
    expect((await contactRow(counselId)).is_archived).toBe(true);
    expect(await contactRow(counselId)).toBeDefined();
  });

  it('refuses to move a contact onto another firm\'s court', async () => {
    const counselId = await seedContact(firmA.id, { name: 'Judge Okonjo', category: 'judge' });
    const foreignCourt = await seedCourt(firmB.id, 'Bravo County Superior');

    const res = await alice.api.put(`${DIR()}/${counselId}`).send({ courtId: foreignCourt });

    expect(res.status).toBe(400);
    expect((await contactRow(counselId)).court_id).toBeNull();
  });
});

afterEach(async () => {
  // The contacts service emits CONTACT_CREATED / UPDATED / DELETED and the bus
  // does not await its async listeners, so a listener's write would otherwise
  // race the truncate that opens the next test.
  await drainEvents();
});
