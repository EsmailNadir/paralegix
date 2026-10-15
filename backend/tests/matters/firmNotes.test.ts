/**
 * The firm-wide notes search: GET /api/lawfirms/:lawFirmId/notes.
 *
 * One route, no test, and it is the widest read surface in the matters module.
 * Every other notes endpoint is addressed through a matter, so `assertMatterReadAccess`
 * stands between the caller and the content. This one is addressed through the
 * FIRM, and the only thing narrowing it is a predicate inside the SQL.
 *
 * That makes the visibility rule the whole point of this file:
 *
 *   AN ORDINARY MEMBER SEES ONLY THE MATTERS THEY ARE ON. The route deliberately
 *   carries no `matters.view`-style gate, because the query narrows the caller
 *   itself. If the `exists (select 1 from matter_members …)` predicate is ever
 *   dropped, every member reads every note in the firm: the strategy, the
 *   impressions, the matters they were kept off. NOTHING on screen looks
 *   broken. There is no error, no empty state, just more results.
 *
 *   AN OWNER, OR A HOLDER OF notes.viewFirmWide, SEES EVERYTHING. That is the
 *   route's reason to exist, so a test that only proved narrowing would pass
 *   against a query that returned nothing to anyone.
 *
 * Both halves are asserted in every isolation case below, for that reason: a
 * result set that is empty for the wrong reason is the failure mode this file
 * exists to catch.
 *
 * The counts come from a SECOND query (`getFirmNoteCounts`) carrying its own
 * copy of the same predicate. A leak can therefore appear in the tab counts
 * while the list itself is correctly narrowed, so the counts are asserted
 * separately rather than trusted to follow the list.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;

const base = () => `/api/lawfirms/${firm.id}/notes`;

/** A matter, with the given uids on it as members. */
const seedNamedMatter = (name: string, memberUids: string[] = [], lawFirmId = firm.id) =>
  seedMatter(lawFirmId, { name, memberUids });

/**
 * A note, straight into the table. Seeded through SQL rather than the notes
 * routes so that a broken repository cannot produce both the row and the
 * expectation.
 */
async function seedNote(
  matterId: string,
  seed: {
    subject?: string;
    content?: string;
    noteType?: string;
    createdBy?: string | null;
    noteDate?: string;
    lawFirmId?: string;
  } = {},
) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into notes
       (id, law_firm_id, matter_id, subject, content, content_html, note_type,
        created_by, note_date)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8::date)
     returning id`,
    [
      id,
      seed.lawFirmId ?? firm.id,
      matterId,
      seed.subject ?? 'Note subject',
      seed.content ?? 'Note content',
      seed.noteType ?? 'general',
      seed.createdBy ?? null,
      seed.noteDate ?? '2026-05-10',
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/**
 * Give a note a time entry, which is what the "with time" tab actually asks
 * about.
 *
 * `MATTER_NOTE_COLUMNS.hasTime` is an `exists (select 1 from activities where
 kind = 'time' and * linked_note_id = ...)`, so a real row in that table is the only way a note
 * reaches the billable tab. A fixture that set the old `has_time_entry` flag
 * instead put this file's first draft two cases into the green while proving
 * nothing; migration 0194 removed that flag.
 */
async function seedLinkedTimeEntry(matterId: string, noteId: string, uid: string) {
  const res = await testPool.query(
    `insert into activities (kind, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents,
        description, linked_note_id)
     values ('time', $1, $2, $3, '2026-05-10', 1.5, 25000, 'Linked work', $4)
     returning id`,
    [firm.id, matterId, uid, noteId],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

const subjectsIn = (body: any) => (body.notes ?? []).map((n: any) => n.subject);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('visibility: a member reads only the matters they are on', () => {
  it('returns a note from the member\'s own matter and NOT one from a matter they are off', async () => {
    const member = await memberWith(firm.id, ['matters.view']);
    const mine = await seedNamedMatter('Member Matter', [member.uid]);
    const theirs = await seedNamedMatter('Other Matter', [owner.uid]);
    await seedNote(mine, { subject: 'On my matter' });
    await seedNote(theirs, { subject: 'Off my matter' });

    const res = await member.api.get(base());

    expect(res.status).toBe(200);
    // BOTH halves. The presence proves the read ran and the query is not simply
    // returning nothing; only then does the absence mean the note was withheld.
    expect(subjectsIn(res.body)).toEqual(['On my matter']);
  });

  it('narrows the tab COUNTS as well as the list', async () => {
    const member = await memberWith(firm.id, ['matters.view']);
    const mine = await seedNamedMatter('Member Matter', [member.uid]);
    const theirs = await seedNamedMatter('Other Matter', [owner.uid]);
    await seedNote(mine, { subject: 'On my matter' });
    await seedNote(theirs, { subject: 'Off my matter' });
    await seedNote(theirs, { subject: 'Also off my matter' });

    const res = await member.api.get(base());

    // The counts come from a SEPARATE query carrying its own copy of the
    // visibility predicate. A leak can land here while the list stays correct,
    // and the member would see a tab saying 3 above a list of 1.
    expect(res.body.counts.all).toBe(1);
  });

  it('returns nothing to a member who is on no matter at all', async () => {
    const member = await memberWith(firm.id, ['matters.view']);
    const theirs = await seedNamedMatter('Other Matter', [owner.uid]);
    await seedNote(theirs, { subject: 'Off my matter' });

    const res = await member.api.get(base());

    // Weak on its own, which is why it sits next to the case above: that one
    // proves the route CAN return a note, so this empty result means withheld
    // rather than broken.
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
    expect(res.body.counts.all).toBe(0);
  });

  it('stops returning a note once the member is taken off the matter', async () => {
    const member = await memberWith(firm.id, ['matters.view']);
    const matterId = await seedNamedMatter('Member Matter', [member.uid]);
    await seedNote(matterId, { subject: 'Was visible' });
    const before = await member.api.get(base());
    expect(subjectsIn(before.body)).toEqual(['Was visible']);

    await testPool.query(
      'delete from matter_members where matter_id = $1 and user_id = $2',
      [matterId, member.uid],
    );
    const after = await member.api.get(base());

    // Membership is read per request, not cached onto the session. A member
    // removed from a matter mid-session must lose the notes immediately.
    expect(after.body.notes).toEqual([]);
  });
});

describe('visibility: an owner or notes.viewFirmWide holder reads everything', () => {
  it('returns notes from matters the OWNER is not a member of', async () => {
    const other = await memberWith(firm.id, ['matters.view']);
    const notMine = await seedNamedMatter('Someone Else Matter', [other.uid]);
    await seedNote(notMine, { subject: 'Not the owner\'s matter' });

    const res = await owner.api.get(base());

    // This is the route's reason to exist. Without this case a query that
    // returned nothing to anybody would pass every narrowing test above.
    expect(subjectsIn(res.body)).toEqual(['Not the owner\'s matter']);
    expect(res.body.counts.all).toBe(1);
  });

  it('gives a member holding notes.viewFirmWide the same firm-wide view', async () => {
    const searcher = await memberWith(firm.id, ['matters.view', 'notes.viewFirmWide']);
    const notTheirs = await seedNamedMatter('Unrelated Matter', [owner.uid]);
    await seedNote(notTheirs, { subject: 'Firm-wide visible' });

    const res = await searcher.api.get(base());

    expect(subjectsIn(res.body)).toEqual(['Firm-wide visible']);
  });

  it('does NOT give that view to a member holding only matters.view', async () => {
    const plain = await memberWith(firm.id, ['matters.view']);
    const notTheirs = await seedNamedMatter('Unrelated Matter', [owner.uid]);
    await seedNote(notTheirs, { subject: 'Firm-wide visible' });

    const res = await plain.api.get(base());

    // The pair that makes the case above meaningful: `notes.viewFirmWide` is
    // what widens the query, not firm membership.
    expect(res.body.notes).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('never returns another firm\'s notes to an owner', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(other.id);
    const theirMatter = await seedNamedMatter('Their Matter', [otherOwner.uid], other.id);
    await seedNote(theirMatter, { subject: 'Their note', lawFirmId: other.id });
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'My note' });

    const res = await owner.api.get(base());

    // The owner path drops the membership predicate entirely, so `law_firm_id`
    // is the ONLY thing left separating the two firms on this query.
    expect(subjectsIn(res.body)).toEqual(['My note']);
  });

  it('refuses a caller who is a member of no firm', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const outsider = await ownerOf(other.id);
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'My note' });

    const res = await outsider.api.get(base());

    // Seeded first on purpose: a firm with no notes answers this the same way
    // whether the notes were withheld or never existed.
    expect(res.status).toBe(403);
  });
});

describe('filters run inside the visibility scope, not around it', () => {
  it('narrows to one matter when matterId is given', async () => {
    const a = await seedNamedMatter('Matter A', [owner.uid]);
    const b = await seedNamedMatter('Matter B', [owner.uid]);
    await seedNote(a, { subject: 'From A' });
    await seedNote(b, { subject: 'From B' });

    const res = await owner.api.get(`${base()}?matterId=${a}`);

    expect(subjectsIn(res.body)).toEqual(['From A']);
  });

  it('does not let matterId reach a matter the member is off', async () => {
    const member = await memberWith(firm.id, ['matters.view']);
    await seedNamedMatter('Member Matter', [member.uid]);
    const theirs = await seedNamedMatter('Other Matter', [owner.uid]);
    await seedNote(theirs, { subject: 'Off my matter' });

    const res = await member.api.get(`${base()}?matterId=${theirs}`);

    // The filter must AND with the visibility predicate rather than replace it.
    // Naming a matter id directly is the obvious way to try to step around the
    // narrowing, and it has to fail.
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  it('does not let matterId reach ANOTHER firm\'s matter', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(other.id);
    const theirMatter = await seedNamedMatter('Their Matter', [otherOwner.uid], other.id);
    await seedNote(theirMatter, { subject: 'Their note', lawFirmId: other.id });

    const res = await owner.api.get(`${base()}?matterId=${theirMatter}`);

    expect(res.body.notes).toEqual([]);
  });

  it('rejects a matterId that is not a uuid rather than ignoring it', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'My note' });

    const res = await owner.api.get(`${base()}?matterId=not-a-uuid`);

    // The schema types this as a uuid. Were it merely coerced to null, the
    // filter would silently widen to EVERY matter instead of failing, and the
    // caller would never know the filter had been dropped.
    expect(res.status).toBe(400);
  });

  it('filters by note type inside the scope', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'A call', noteType: 'call' });
    await seedNote(mine, { subject: 'A general note', noteType: 'general' });

    const res = await owner.api.get(`${base()}?noteType=call`);

    expect(subjectsIn(res.body)).toEqual(['A call']);
  });

  it('splits with-time from without-time', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    const timed = await seedNote(mine, { subject: 'Billed work' });
    await seedLinkedTimeEntry(mine, timed, owner.uid);
    await seedNote(mine, { subject: 'Unbilled work' });

    const withTime = await owner.api.get(`${base()}?timeFilter=with-time`);
    const withoutTime = await owner.api.get(`${base()}?timeFilter=without-time`);

    // Asserted as a pair. Either query returning everything looks correct on
    // its own if only one is checked.
    expect(subjectsIn(withTime.body)).toEqual(['Billed work']);
    expect(subjectsIn(withoutTime.body)).toEqual(['Unbilled work']);
  });

  it('answers "with time" from the time entry alone', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    // A note with no row in `time_entries` naming it. `hasTime` is an
    // `exists (...)` against that table, so there is no second place a note can
    // claim time from; migration 0194 dropped the denormalized mirror that used
    // to offer one.
    await seedNote(mine, { subject: 'No time recorded' });

    const res = await owner.api.get(`${base()}?timeFilter=with-time`);

    expect(res.body.notes).toEqual([]);
  });

  it('reports the with-time and without-time counts separately', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    const timed = await seedNote(mine, { subject: 'Billed work' });
    await seedLinkedTimeEntry(mine, timed, owner.uid);
    await seedNote(mine, { subject: 'Unbilled work' });
    await seedNote(mine, { subject: 'More unbilled' });

    const res = await owner.api.get(base());

    expect(res.body.counts).toMatchObject({ all: 3, withTime: 1, withoutTime: 2 });
  });

  it('bounds a date range at both ends', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'Too early', noteDate: '2026-01-01' });
    await seedNote(mine, { subject: 'In range', noteDate: '2026-05-10' });
    await seedNote(mine, { subject: 'Too late', noteDate: '2026-12-31' });

    const res = await owner.api.get(`${base()}?dateFrom=2026-04-01&dateTo=2026-06-30`);

    // A range that only bounded one end would still return two of these, so
    // both out-of-range notes are seeded rather than one.
    expect(subjectsIn(res.body)).toEqual(['In range']);
  });

  it('searches text without letting a wildcard widen the match', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'Deposition prep', content: 'Prepared the deponent' });
    await seedNote(mine, { subject: 'Filing', content: 'Filed the motion' });

    const hit = await owner.api.get(`${base()}?search=deposition`);
    const wildcard = await owner.api.get(`${base()}?search=%25`);

    expect(subjectsIn(hit.body)).toEqual(['Deposition prep']);
    // Search is ILIKE '%term%'. An unescaped '%' from the caller would match
    // every note in the firm, which turns the search box into a way to dump
    // the lot.
    expect(wildcard.body.notes).toEqual([]);
  });
});

describe('paging', () => {
  it('honours the limit and reports the unpaged total', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    for (let i = 0; i < 5; i++) {
      await seedNote(mine, { subject: `Note ${i}`, noteDate: `2026-05-0${i + 1}` });
    }

    const res = await owner.api.get(`${base()}?limit=2`);

    expect(res.body.notes).toHaveLength(2);
    // The total is the size of the WHOLE result set, not of the page. Returning
    // the page size here makes the pager show one page and hide the rest.
    expect(res.body.totalNotes).toBe(5);
  });

  it('returns a different page for a different offset', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    for (let i = 0; i < 5; i++) {
      await seedNote(mine, { subject: `Note ${i}`, noteDate: `2026-05-0${i + 1}` });
    }

    const first = await owner.api.get(`${base()}?limit=2&offset=0`);
    const second = await owner.api.get(`${base()}?limit=2&offset=2`);

    // Ordering is note_date desc, so these are deterministic. Overlapping pages
    // would mean the caller never reaches the end of the list.
    expect(subjectsIn(first.body)).toEqual(['Note 4', 'Note 3']);
    expect(subjectsIn(second.body)).toEqual(['Note 2', 'Note 1']);
  });

  it('refuses a limit past the 200 bound', async () => {
    const res = await owner.api.get(`${base()}?limit=5000`);

    expect(res.status).toBe(400);
  });

  it('orders newest note date first', async () => {
    const mine = await seedNamedMatter('My Matter', [owner.uid]);
    await seedNote(mine, { subject: 'Older', noteDate: '2026-01-01' });
    await seedNote(mine, { subject: 'Newer', noteDate: '2026-09-01' });

    const res = await owner.api.get(base());

    // `note_date` is the day the work happened, set by the author, and it is
    // deliberately not `created_at`. Ordering by insertion instead would put a
    // note written up late at the top of the list.
    expect(subjectsIn(res.body)).toEqual(['Newer', 'Older']);
  });
});

describe('each note carries the matter it belongs to', () => {
  it('names the matter, because the caller is looking across all of them', async () => {
    const mine = await seedNamedMatter('Henderson v. Acme', [owner.uid]);
    await seedNote(mine, { subject: 'A note' });

    const res = await owner.api.get(base());

    // On a per-matter panel the matter is implied by the page. Here it is the
    // only thing telling the reader which case the note is about.
    expect(res.body.notes[0]).toMatchObject({
      matterId: mine,
      matterName: 'Henderson v. Acme',
    });
  });
});
