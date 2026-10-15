/**
 * Client notes, driven through the real routes.
 *
 * `clientNotes.service.ts` and `noteReplies.service.ts` were at 54% and
 * 59% statements with 0% of their functions ever called: the two files are thin
 * adapters onto the shared notes engine, so what needed testing was never the
 * engine, it was the four decisions THIS module makes.
 *
 *   1. WHAT COUNTS AS ACCESS. There is no per-user membership on a client the
 *      way there is on a matter, so the existence lookup inside
 *      `assertClientNoteAccess` is a security boundary, not a convenience: it
 *      scopes every note read to the caller's firm. The matter wall on top of
 *      it is pinned in `clientNoteAccess.test.ts`.
 *
 *   2. THE COMPANY WIDENING. A person client's note LIST is widened to include
 *      notes recorded on any organization they are linked to, while reading one
 *      note by id stays scoped to its actual parent. Those two must not drift
 *      into each other: widening the by-id read would let any client id in the
 *      firm open any note.
 *
 *   3. THE PORTAL. Client notes are firm-internal, authored by firm members
 *      about the client, and `portal.service.ts` hardcodes `notes: []` for
 *      exactly that reason. A regression there discloses the firm's private
 *      annotations to the person they are about, and the portal screen would
 *      look like a working feature.
 *
 *   4. RETRACTION, NOT DELETION. A note is a record of firm-internal client
 *      history; retracting marks it and keeps the row and its versions.
 *
 * The engine behaviour every parent shares (versions, pinning, the edit lock,
 * who may retract whose note, reply CRUD) is pinned in `matterNotes.test.ts`.
 *
 * Fixtures are plain SQL through the test pool. The neighbouring firm's note in
 * particular is never created through this module's own routes, so a broken
 * scope cannot produce both the data and the expectation.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createOrgClient,
  createPortalUser,
  linkPersonToOrg,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import {
  noteContents,
  noteCount,
  noteRow,
  seedNote as seedParentNote,
  type NoteSeed,
  walkNoteEngine,
} from '../support/notesWorld';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const notesPath = (clientId: string, suffix = '') =>
  `/api/lawfirms/${firm.id}/clients/${clientId}/notes${suffix}`;

/** A note seeded straight onto a client, bypassing this module's own routes. */
const seedNote = (lawFirmId: string, clientId: string, seed: NoteSeed = {}) =>
  seedParentNote(lawFirmId, { clientId }, seed);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Annotated Client' });
});

describe('writing and reading a note', () => {
  it('adds one and lists it back', async () => {
    const created = await owner.api
      .post(notesPath(client.id))
      .send({ content: 'Called the client about the retainer' });
    await drainEvents();

    expect(created.status).toBe(201);

    const list = await owner.api.get(notesPath(client.id));
    expect(list.status).toBe(200);
    expect(noteContents(list.body)).toContain('Called the client about the retainer');
    expect(list.body.totalNotes).toBe(1);
  });

  it('returns the note date as a day-only string', async () => {
    const created = await owner.api
      .post(notesPath(client.id))
      .send({ content: 'Dated note', noteDate: '2026-04-01' });
    await drainEvents();

    // `note_date` is a `date` column: the day the work happened, separate from
    // when the row was saved. Wrapping it in a Date would shift it a day for
    // anyone west of UTC and misdate the work.
    expect(created.body.note.noteDate).toBe('2026-04-01');
  });

  it('reads one back by id', async () => {
    const note = await seedNote(firm.id, client.id, { content: 'Readable note' });

    const res = await owner.api.get(notesPath(client.id, `/${note.id}`));

    expect(res.status).toBe(200);
    expect(res.body.note.content).toBe('Readable note');
  });

  it('answers 404 for a note that does not exist', async () => {
    const res = await owner.api.get(notesPath(client.id, '/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });

  it('answers 404 for a client that does not exist', async () => {
    const res = await owner.api.get(notesPath('00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });

  it('rejects an empty note', async () => {
    const res = await owner.api.post(notesPath(client.id)).send({ content: '' });

    expect(res.status).toBe(400);
    expect(await noteCount(firm.id)).toBe(0);
  });

  it('filters the list by search term', async () => {
    await seedNote(firm.id, client.id, { content: 'Discussed the settlement offer' });
    await seedNote(firm.id, client.id, { content: 'Filed the appearance' });

    const res = await owner.api.get(notesPath(client.id, '?search=settlement'));

    // Paired: both notes belong to the same client, so only the filter can
    // account for the difference.
    expect(noteContents(res.body)).toEqual(['Discussed the settlement offer']);
  });
});

describe('retracting', () => {
  it('retracts a note without deleting it', async () => {
    const created = await owner.api.post(notesPath(client.id)).send({ content: 'Written in error' });
    await drainEvents();
    const noteId = created.body.note.id;

    const res = await owner.api
      .delete(notesPath(client.id, `/${noteId}`))
      .send({ reason: 'Recorded against the wrong client' });
    await drainEvents();

    expect(res.status).toBe(200);
    const row = await noteRow(noteId);
    // The row and its text must survive: time entries point at it from the
    // billing tables, and it is a record of work performed.
    expect(row).not.toBeNull();
    expect(row.content).toBe('Written in error');
    expect(row.retracted_at).not.toBeNull();
    expect(row.retraction_reason).toBe('Recorded against the wrong client');
  });

});

describe('the shared engine behind the client adapter', () => {
  it('reaches every note route with the client as the parent', async () => {
    await walkNoteEngine({
      actor: owner, lawFirmId: firm.id, parent: { clientId: client.id }, notesPath: (suffix = '') => notesPath(client.id, suffix),
    });
  });
});

describe('replies', () => {
  it('nests a reply under another reply', async () => {
    const note = await seedNote(firm.id, client.id);
    const parent = await owner.api
      .post(notesPath(client.id, `/${note.id}/replies`))
      .send({ content: 'Top level' });
    await drainEvents();
    const parentId = parent.body.reply.id;

    const nested = await owner.api
      .post(notesPath(client.id, `/${note.id}/replies`))
      .send({ content: 'Nested under it', parentReplyId: parentId });
    await drainEvents();

    expect(nested.status).toBe(201);
    const { rows } = await testPool.query(
      'select parent_reply_id from note_replies where id = $1',
      [nested.body.reply.id],
    );
    expect(rows[0].parent_reply_id).toBe(parentId);
  });

  it('rejects an empty reply', async () => {
    const note = await seedNote(firm.id, client.id);

    const res = await owner.api.post(notesPath(client.id, `/${note.id}/replies`)).send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('refuses to reply to a note on a different client', async () => {
    const otherClient = await createPersonClient(firm.id, { name: 'Someone Else' });
    const theirNote = await seedNote(firm.id, otherClient.id, { content: 'Their private note' });

    const res = await owner.api
      .post(notesPath(client.id, `/${theirNote.id}/replies`))
      .send({ content: 'Wrong thread entirely' });

    // The note id is real and this caller could reach it under its OWN client,
    // so a route that ignored the parent would happily attach the reply.
    expect(res.status).toBe(404);
  });

  it('does not let a reply update escape its note parent', async () => {
    const otherClient = await createPersonClient(firm.id, { name: 'Different client' });
    const theirNote = await seedNote(firm.id, otherClient.id, { content: 'Their note' });
    const added = await owner.api
      .post(notesPath(otherClient.id, `/${theirNote.id}/replies`))
      .send({ content: 'Original reply' });
    await drainEvents();

    const res = await owner.api
      .put(notesPath(client.id, `/${theirNote.id}/replies/${added.body.reply.id}`))
      .send({ content: 'Hijacked reply' });

    // The route's client id must scope every reply mutation, not only reply
    // creation. Otherwise a caller who can manage either client can rewrite a
    // thread that belongs to the other client merely by knowing its ids.
    expect(res.status).toBe(404);
    const { rows } = await testPool.query(
      'select content from note_replies where id = $1',
      [added.body.reply.id],
    );
    expect(rows[0].content).toBe('Original reply');
  });
});

describe('time entries linked to a client note', () => {
  // The shared notes router mounts the time endpoints identically for
  // matters, tasks and clients, and `matterNotes.test.ts` pins updating and
  // deleting an entry. What is client-specific is the billing context:
  // `clientNotes.service.ts` returns `{ type: 'client', entityId: clientId }`,
  // so an entry added here must be billed to the client, with no matter.
  it('adds billable time to a note and bills it to the client itself', async () => {
    const noteRes = await owner.api.post(notesPath(client.id)).send({ content: 'Called about settlement' });
    const noteId = noteRes.body.note.id;

    const timeRes = await owner.api.post(notesPath(client.id, `/${noteId}/time`)).send({
      timeSpent: 1.5,
      timeEntryDate: '2026-09-01',
      activityName: 'Client call',
      activityDescription: 'Discussed settlement offer',
      isBillable: true,
    });
    expect(timeRes.status).toBe(201);
    expect(timeRes.body.note.time.totalHours).toBe(1.5);
    expect(timeRes.body.note.time.entries).toHaveLength(1);
    const timeEntryId = timeRes.body.note.time.entries[0].id;

    // The row is attributed to THIS client directly, with no matter, so it can
    // actually be billed to the client rather than silently orphaned.
    const { rows } = await testPool.query(
      `select client_id, matter_id, hours from activities where kind = 'time' and id = $1`,
      [timeEntryId],
    );
    expect(rows[0]).toMatchObject({ client_id: client.id, matter_id: null, hours: '1.50' });
  });

  it('refuses a member without clients.manage', async () => {
    const noteRes = await owner.api.post(notesPath(client.id)).send({ content: 'Needs time logged' });
    const noteId = noteRes.body.note.id;
    const readOnly = await memberWith(firm.id, ['clients.view']);

    const res = await readOnly.api.post(notesPath(client.id, `/${noteId}/time`)).send({
      timeSpent: 1,
      timeEntryDate: '2026-09-01',
      activityName: 'Should be refused',
      isBillable: true,
    });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select count(*)::int as n from activities where kind = 'time' and client_id = $1`,
      [client.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('the organization widening', () => {
  async function personOnOrg() {
    const org = await createOrgClient(firm.id, { name: 'Widening Corp' });
    const person = await createPersonClient(firm.id, { name: 'Roster Person' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });
    return { org, person };
  }

  it('shows a note recorded on the linked organization in the person list', async () => {
    const { org, person } = await personOnOrg();
    await seedNote(firm.id, org.id, { content: 'Recorded against the organization' });
    await seedNote(firm.id, person.id, { content: 'Recorded against the person' });

    const res = await owner.api.get(notesPath(person.id));

    expect(res.status).toBe(200);
    expect(noteContents(res.body)).toContain('Recorded against the person');
    expect(noteContents(res.body)).toContain('Recorded against the organization');
  });

  it('does not widen to an organization the person is not linked to', async () => {
    const { person } = await personOnOrg();
    const unrelated = await createOrgClient(firm.id, { name: 'Unrelated Corp' });
    await seedNote(firm.id, unrelated.id, { content: 'Unrelated organization note' });

    const res = await owner.api.get(notesPath(person.id));

    // Paired with the case above: the widening follows an explicit
    // `client_company_links` row, never a name or a shared firm.
    expect(noteContents(res.body)).not.toContain('Unrelated organization note');
  });

  it('still refuses to open the organization note by id under the person', async () => {
    const { org, person } = await personOnOrg();
    const orgNote = await seedNote(firm.id, org.id, { content: 'Organization only note' });

    const listed = await owner.api.get(notesPath(person.id));
    const byId = await owner.api.get(notesPath(person.id, `/${orgNote.id}`));

    // The list widens; the by-id read does not. Widening it too would make any
    // client id in the firm a usable key for any note in the firm.
    expect(noteContents(listed.body)).toContain('Organization only note');
    expect(byId.status).toBe(404);
  });
});

describe('the client portal never sees a client note', () => {
  it('withholds them from the portal dashboard', async () => {
    const { uid } = await createPortalUser({ name: 'Portal Person' });
    const portalClient = await createPersonClient(firm.id, {
      name: 'Portal Person',
      userId: uid,
      email: `${uid}@example.test`,
    });
    await seedNote(firm.id, portalClient.id, { content: 'Client seems evasive about the deposit' });
    const portalApi = as(tokenFor({ uid }));

    // The firm's own read proves the note exists and is reachable, so the
    // absence from the portal body is a withholding rather than an empty world.
    const firmView = await owner.api.get(notesPath(portalClient.id));
    expect(noteContents(firmView.body)).toContain('Client seems evasive about the deposit');

    const res = await portalApi.get(`/api/client-portal/lawfirm/${firm.id}/dashboard`);

    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
    // These are firm-internal annotations ABOUT this person. Disclosing one is
    // the worst outcome this module has, and it would render as a working
    // notes panel.
    expect(JSON.stringify(res.body)).not.toContain('Client seems evasive about the deposit');
  });

  it('refuses a portal client the firm-side notes route entirely', async () => {
    const { uid } = await createPortalUser({ name: 'Portal Person' });
    const portalClient = await createPersonClient(firm.id, {
      name: 'Portal Person',
      userId: uid,
      email: `${uid}@example.test`,
    });
    await seedNote(firm.id, portalClient.id, { content: 'Internal impression of the client' });

    const res = await as(tokenFor({ uid })).get(notesPath(portalClient.id));

    // A client is not a member of the firm, so the permission gate refuses
    // before the service is reached.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Internal impression of the client');
  });
});

describe('tenancy', () => {
  let otherFirm: Firm;
  let otherOwner: Actor;
  let theirClient: ClientRecord;
  let theirNote: { id: string; content: string };

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    otherOwner = await ownerOf(otherFirm.id);
    theirClient = await createPersonClient(otherFirm.id, { name: 'Neighbour Client' });
    theirNote = await seedNote(otherFirm.id, theirClient.id, { content: 'Neighbour Confidential Note' });
  });

  it('refuses to list notes on another firm client', async () => {
    const theirs = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/clients/${theirClient.id}/notes`);
    const mine = await owner.api.get(notesPath(theirClient.id));

    // The neighbour's own read proves the note exists and is reachable.
    expect(noteContents(theirs.body)).toContain('Neighbour Confidential Note');
    expect(mine.status).toBe(404);
    expect(JSON.stringify(mine.body)).not.toContain('Neighbour Confidential Note');
  });

  it('refuses to open another firm note under this firm own client', async () => {
    const res = await owner.api.get(notesPath(client.id, `/${theirNote.id}`));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Neighbour Confidential Note');
  });

  it('refuses to edit another firm note and leaves the text untouched', async () => {
    const res = await owner.api
      .put(notesPath(client.id, `/${theirNote.id}`))
      .send({ content: 'Rewritten by a stranger' });

    expect(res.status).toBe(404);
    expect((await noteRow(theirNote.id)).content).toBe('Neighbour Confidential Note');
  });

  it('refuses to retract another firm note', async () => {
    const res = await owner.api.delete(notesPath(client.id, `/${theirNote.id}`)).send({});

    expect(res.status).toBe(404);
    expect((await noteRow(theirNote.id)).retracted_at).toBeNull();
  });
});

describe('permissions', () => {
  it('lets a baseline member read the notes', async () => {
    await seedNote(firm.id, client.id, { content: 'Readable note' });
    // `clients.view` is in DEFAULT_PERMISSIONS, so an empty role reads.
    // Asserted first so the write refusals below cannot pass on a member who
    // is simply locked out of the module.
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.get(notesPath(client.id));

    expect(res.status).toBe(200);
    expect(noteContents(res.body)).toContain('Readable note');
  });

  it('refuses a member without clients.manage a write', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(notesPath(client.id)).send({ content: 'Nope' });

    expect(res.status).toBe(403);
    expect(await noteCount(firm.id)).toBe(0);
  });

  it('refuses that member an edit, and the text survives', async () => {
    const note = await seedNote(firm.id, client.id, { content: 'Protected text' });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.put(notesPath(client.id, `/${note.id}`)).send({ content: 'Edited by a reader' });

    expect(res.status).toBe(403);
    expect((await noteRow(note.id)).content).toBe('Protected text');
  });

  it('refuses that member a reply', async () => {
    const note = await seedNote(firm.id, client.id);
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(notesPath(client.id, `/${note.id}/replies`)).send({ content: 'Nope' });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select id from note_replies where note_id = $1', [note.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a member holding clients.manage write one', async () => {
    const writer = await memberWith(firm.id, ['clients.manage']);

    const res = await writer.api.post(notesPath(client.id)).send({ content: 'Allowed' });
    await drainEvents();

    // Paired with the refusals above so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(201);
    expect(await noteCount(firm.id)).toBe(1);
  });
});
