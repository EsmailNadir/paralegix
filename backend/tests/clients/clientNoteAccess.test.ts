/**
 * Client notes follow the matters the client is on.
 *
 * The three note types share one engine and each supplies its own read gate.
 * Matter notes use `assertMatterReadAccess`. Task notes use
 * `assertTaskReadAccess`. Client notes used `assertClientExists`, which checked
 * only that the client was in the firm, and the route's permission is
 * `clients.view`, which is in DEFAULT_PERMISSIONS. So the read gate was: you are
 * in this firm. Every member could read every client's intake summaries,
 * strategy notes and privileged conversation records, including clients of
 * matters they were deliberately walled off from.
 *
 * The comment justifying `clients.view` as baseline is explicitly about NAMES:
 * "a member who can already open matters and invoices reads the same client
 * names there". Notes are not names, so that justification never covered this.
 *
 * THE RULE NOW, and the reason for its shape. Clients have no membership model
 * of their own, so there is nothing to check directly. Access follows the
 * matters instead:
 *
 *   - the client is on one or more matters -> you must be on one of them;
 *   - the client is on NO matter -> firm-wide, because there is no matter to be
 *     walled off from yet, and this is the pre-matter intake case that a strict
 *     rule would otherwise strand;
 *   - an owner, a firm admin, or a holder of `notes.viewFirmWide` always reads,
 *     matching what `listFirmNotes` already does for matter notes.
 *
 * Replies are the note's content by another route, so the reply service uses
 * the same gate for listing and adding them.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  memberWith,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedMatterClient } from '../support/matters';
import { seedNote as seedParentNote } from '../support/notesWorld';

let firm: Firm;
let owner: Actor;
let insider: Actor;   // on the matter
let outsider: Actor;  // in the firm, not on the matter

const notesOf = (clientId: string) => `/api/lawfirms/${firm.id}/clients/${clientId}/notes`;

const seedWalledMatter = (memberUids: string[]) =>
  seedMatter(firm.id, { name: 'Walled matter', memberUids });

const attachClient = (matterId: string, clientId: string) => seedMatterClient(firm.id, matterId, clientId);

async function seedNote(clientId: string, subject: string): Promise<string> {
  const note = await seedParentNote(firm.id, { clientId }, { subject, content: 'Privileged content' });
  return note.id;
}

async function seedReply(noteId: string, content: string) {
  const res = await testPool.query(
    `insert into note_replies (law_firm_id, note_id, content, created_by)
     values ($1, $2, $3, $4)`,
    [firm.id, noteId, content, owner.uid],
  );
  expect(res.rowCount).toBe(1);
}

async function replyContents(noteId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    'select content from note_replies where note_id = $1 order by created_at, content',
    [noteId],
  );
  return rows.map((r: any) => r.content);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  insider = await memberWith(firm.id, ['clients.view', 'matters.view']);
  outsider = await memberWith(firm.id, ['clients.view', 'matters.view']);
  await drainEvents();
});

describe('a client attached to a matter', () => {
  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Walled Client' });
    const matterId = await seedWalledMatter([insider.uid]);
    await attachClient(matterId, client.id);
    await seedNote(client.id, 'Privileged strategy');
  });

  it('lets a member ON that matter read the notes', async () => {
    const res = await insider.api.get(notesOf(client.id));

    // First, because every refusal below is only meaningful once this proves
    // the notes exist and are reachable.
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: any) => n.subject)).toEqual(['Privileged strategy']);
  });

  it('refuses a member who is NOT on that matter', async () => {
    const res = await outsider.api.get(notesOf(client.id));

    expect(res.status).toBe(403);
  });

  it('refuses that member the single-note read too', async () => {
    const list = await insider.api.get(notesOf(client.id));
    const noteId = list.body.notes[0].id;

    const res = await outsider.api.get(`${notesOf(client.id)}/${noteId}`);

    // The list is not the only way in. A gate applied to one and not the other
    // leaves the note readable by id.
    expect(res.status).toBe(403);
  });

  it('refuses that member the WRITE too', async () => {
    // Holds the write permission, so only the matter wall can refuse it.
    const walledWriter = await memberWith(firm.id, ['clients.view', 'clients.manage']);
    const res = await walledWriter.api.post(notesOf(client.id))
      .send({ subject: 'Injected', content: 'Injected' });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select count(*)::int as n from notes where client_id = $1', [client.id],
    );
    // The row, not the status. A member who cannot read these notes should not
    // be able to add one to the file either.
    expect(rows[0].n).toBe(1);
  });

  it('lets the OWNER read regardless of matter membership', async () => {
    const res = await owner.api.get(notesOf(client.id));

    // Owners and admins already list and open every matter in the firm, so
    // holding them out here would be inconsistent, not safer.
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
  });

  it('lets a notes.viewFirmWide holder read', async () => {
    const searcher = await memberWith(firm.id, ['clients.view', 'notes.viewFirmWide']);

    const res = await searcher.api.get(notesOf(client.id));

    // The same code that widens the firm-wide matter-notes search.
    expect(res.status).toBe(200);
  });

  it('lets a member on ONE of several matters read', async () => {
    const second = await seedWalledMatter([outsider.uid]);
    await attachClient(second, client.id);

    const res = await outsider.api.get(notesOf(client.id));

    // A client can be on many matters. Being on any one of them is enough, or
    // a co-client relationship would hide the file from half the people
    // working it.
    expect(res.status).toBe(200);
  });
});

describe('replies on a walled client\'s notes follow the same rule', () => {
  let client: ClientRecord;
  let noteId: string;
  // Both hold the write permission, so only the matter wall separates them.
  let insideWriter: Actor;
  let walledWriter: Actor;
  const repliesOf = () => `${notesOf(client.id)}/${noteId}/replies`;

  beforeEach(async () => {
    insideWriter = await memberWith(firm.id, ['clients.view', 'clients.manage']);
    walledWriter = await memberWith(firm.id, ['clients.view', 'clients.manage']);
    client = await createPersonClient(firm.id, { name: 'Walled Client' });
    const matterId = await seedWalledMatter([insider.uid, insideWriter.uid]);
    await attachClient(matterId, client.id);
    noteId = await seedNote(client.id, 'Privileged strategy');
    await seedReply(noteId, 'Privileged reply');
  });

  it.each([
    ['a member on the matter', () => insider],
    ['the owner', () => owner],
  ])('lets %s list the replies', async (_label, who) => {
    const res = await who().api.get(repliesOf());

    expect(res.status).toBe(200);
    expect(res.body.replies.map((r: any) => r.content)).toEqual(['Privileged reply']);
  });

  it('refuses a walled member the reply list', async () => {
    const res = await outsider.api.get(repliesOf());

    // A reply thread quotes and answers the note, so it is the note's content
    // by another route and has to sit behind the same wall.
    expect(res.status).toBe(403);
    expect(res.body.replies).toBeUndefined();
  });

  it('lets a member on the matter add a reply', async () => {
    const res = await insideWriter.api.post(repliesOf()).send({ content: 'Insider reply' });

    expect(res.status).toBe(201);
    expect(await replyContents(noteId)).toEqual(['Privileged reply', 'Insider reply']);
  });

  it('refuses a walled member adding a reply, and writes nothing', async () => {
    const res = await walledWriter.api.post(repliesOf()).send({ content: 'Injected reply' });

    expect(res.status).toBe(403);
    expect(await replyContents(noteId)).toEqual(['Privileged reply']);
  });
});

describe('a client attached to NO matter', () => {
  it('is readable firm-wide, which is the intake case', async () => {
    const client = await createPersonClient(firm.id, { name: 'Fresh Intake' });
    await seedNote(client.id, 'Intake call summary');

    const res = await outsider.api.get(notesOf(client.id));

    // Deliberate. Intake notes are written before the first matter exists, so a
    // strict matter rule would hide them from everyone including the person who
    // just took the call. There is no matter to be walled off from yet.
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: any) => n.subject)).toEqual(['Intake call summary']);
  });

  it('becomes walled as soon as it IS attached to a matter', async () => {
    const client = await createPersonClient(firm.id, { name: 'Fresh Intake' });
    await seedNote(client.id, 'Intake call summary');
    const before = await outsider.api.get(notesOf(client.id));
    expect(before.status).toBe(200);

    const matterId = await seedWalledMatter([insider.uid]);
    await attachClient(matterId, client.id);
    const after = await outsider.api.get(notesOf(client.id));

    // The pair that makes the case above safe rather than a permanent hole.
    expect(after.status).toBe(403);
  });
});

describe('tenant scope survives the new rule', () => {
  it('refuses another firm\'s client outright', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const theirClient = await createPersonClient(other.id, { name: 'Their Client' });
    await testPool.query(
      `insert into notes (law_firm_id, client_id, subject, content, content_html, note_type)
       values ($1, $2, 'Their note', 'x', 'x', 'general')`,
      [other.id, theirClient.id],
    );

    const res = await owner.api.get(notesOf(theirClient.id));

    // That client is on no matter in EITHER firm, so the unattached rule must
    // not be a way past the firm boundary.
    expect(res.status).toBe(404);
  });
});

describe('a person linked to an organization on a walled matter', () => {
  // The person's notes list also shows notes recorded against the organizations
  // they belong to. The read gate ran for the person only, so a member walled off
  // from the organization's matter could read the organization's privileged notes
  // by opening the notes of any person on its roster. Red if the widened list
  // stops checking the organization's own gate.
  let person: ClientRecord;
  let org: ClientRecord;

  beforeEach(async () => {
    person = await createPersonClient(firm.id, { name: 'Roster Person' });
    org = await createOrgClient(firm.id, { name: 'Walled Org' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });
    const matterId = await seedWalledMatter([insider.uid]);
    await attachClient(matterId, org.id);
    await seedNote(person.id, 'Person note');
    await seedNote(org.id, 'Organization strategy');
  });

  it("does not show a walled member the organization's notes, only the person's own", async () => {
    const res = await outsider.api.get(notesOf(person.id));

    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: any) => n.subject)).toEqual(['Person note']);
    expect(res.body.totalNotes ?? res.body.totalItems ?? res.body.notes.length).toBe(1);
  });

  it("shows the organization's notes to a member on its matter, and to the owner", async () => {
    for (const who of [insider, owner]) {
      const res = await who.api.get(notesOf(person.id));

      expect(res.status).toBe(200);
      expect(res.body.notes.map((n: any) => n.subject).sort()).toEqual(['Organization strategy', 'Person note']);
    }
  });

  it('still refuses the organization notes directly to the walled member', async () => {
    expect((await outsider.api.get(notesOf(org.id))).status).toBe(403);
  });
});

describe('a person linked to three organizations, two of them visible to the viewer', () => {
  // The widened list drops every organization the viewer could not open
  // directly. That decision is made for the whole roster together, so the work
  // does not grow with the number of organizations a person belongs to.
  let person: ClientRecord;
  let visibleA: ClientRecord;
  let visibleB: ClientRecord;
  let walledC: ClientRecord;
  let unattachedD: ClientRecord;

  beforeEach(async () => {
    person = await createPersonClient(firm.id, { name: 'Multi Person' });
    visibleA = await createOrgClient(firm.id, { name: 'Org A' });
    visibleB = await createOrgClient(firm.id, { name: 'Org B' });
    walledC = await createOrgClient(firm.id, { name: 'Org C' });
    unattachedD = await createOrgClient(firm.id, { name: 'Org D' });
    for (const org of [visibleA, visibleB, walledC, unattachedD]) {
      await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });
    }
    await attachClient(await seedWalledMatter([insider.uid]), visibleA.id);
    await attachClient(await seedWalledMatter([insider.uid]), visibleB.id);
    await attachClient(await seedWalledMatter([owner.uid]), walledC.id);
    await seedNote(person.id, 'Person note');
    await seedNote(visibleA.id, 'A note');
    await seedNote(visibleB.id, 'B note');
    await seedNote(walledC.id, 'C note');
    await seedNote(unattachedD.id, 'D note');
  });

  it('lists the notes of the organizations the viewer can open, and only those', async () => {
    const res = await insider.api.get(notesOf(person.id));

    expect(res.status).toBe(200);
    // C is walled from the viewer. D is on no matter, which is firm-wide.
    expect(res.body.notes.map((n: any) => n.subject).sort())
      .toEqual(['A note', 'B note', 'D note', 'Person note']);
  });

  it('lists every organization note for the owner', async () => {
    const res = await owner.api.get(notesOf(person.id));

    expect(res.body.notes.map((n: any) => n.subject).sort())
      .toEqual(['A note', 'B note', 'C note', 'D note', 'Person note']);
  });

  it('lists none of the walled organizations for a viewer on no matter', async () => {
    const res = await outsider.api.get(notesOf(person.id));

    expect(res.body.notes.map((n: any) => n.subject).sort()).toEqual(['D note', 'Person note']);
  });

  it('looks the organizations up together rather than once each', async () => {
    const clientsRepo = require('../../src/modules/clients/clients.repository');
    const single = jest.spyOn(clientsRepo, 'findByIdRaw');
    const many = jest.spyOn(clientsRepo, 'findByIdsRaw');
    try {
      const res = await insider.api.get(notesOf(person.id));
      expect(res.status).toBe(200);
      // One lookup for the person being viewed, one for the whole roster.
      expect(single.mock.calls.length + many.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      single.mockRestore();
      many.mockRestore();
    }
  });
});
