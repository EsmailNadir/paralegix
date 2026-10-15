/**
 * Matters, tasks and clients each carry a notes surface, and they are meant to
 * be ONE surface: `createNotesRouter` over the shared notes engine. Every drift
 * between them so far has been invisible, because no single screen looks wrong.
 * This file puts the three side by side.
 *
 *   (a) the set of routes each mount registers is identical, apart from the
 *       routes only a matter note has (spawn or link work, send to the client);
 *   (b) the permission each route group demands, written out by hand here and
 *       compared to the route catalog. The catalog is a transcript of the
 *       middleware, so the table below is the independent statement of intent;
 *   (c) the behaviour behind those permissions, driven through the real routes:
 *       a view-only member can read and nothing else; time on a note, and a
 *       note posted with time attached, is billable work and needs the billing
 *       permission whichever parent the note sits on; retracting a note takes
 *       the parent's write permission;
 *   (d) one pass of every shared engine route per parent.
 *
 * Red if a notes route is added to one module instead of the factory, if one
 * mount's permission changes, or if the time or retract rule differs by parent.
 */
import {
  createFirm,
  createFirmMember,
  createPersonClient,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatterMember } from '../support/matters';
import { noteCount, noteRow, seedNote, walkNoteEngine, type NoteParent } from '../support/notesWorld';
import { ROUTE_CATALOG } from '../contracts/routeCatalog';

const matterNotesRouter = require('../../src/modules/matters/notes/matterNotes.routes');
const taskNotesRouter = require('../../src/modules/tasks/notes/taskNotes.routes');
const clientNotesRouter = require('../../src/modules/clients/notes/clientNotes.routes');

const TIME = { timeSpent: 1, timeEntryDate: '2026-09-01', activityName: 'Call', isBillable: true };
const BILLING = 'billing.manageTimeEntries';

interface Parent {
  name: 'matter' | 'task' | 'client';
  param: string;
  router: any;
  catalogPrefix: string;
  /** The parent's own permission per route group (hand-written, see (b)). */
  perms: { view: string; write: string; retract: string; time: string; reply: string };
}

const PARENTS: Parent[] = [
  {
    name: 'matter', param: 'matterId', router: matterNotesRouter, catalogPrefix: '/api/lawfirms/:lawFirmId/matters/:matterId/notes',
    perms: { view: 'matters.view', write: 'matters.update', retract: 'matters.update', time: BILLING, reply: 'matters.update' },
  },
  {
    name: 'task', param: 'taskId', router: taskNotesRouter, catalogPrefix: '/api/lawfirms/:lawFirmId/tasks/:taskId/notes',
    perms: { view: 'tasks.view', write: 'tasks.update', retract: 'tasks.update', time: BILLING, reply: 'tasks.update' },
  },
  {
    name: 'client', param: 'clientId', router: clientNotesRouter, catalogPrefix: '/api/lawfirms/:lawFirmId/clients/:clientId/notes',
    perms: { view: 'clients.view', write: 'clients.manage', retract: 'clients.manage', time: BILLING, reply: 'clients.manage' },
  },
];

/** Routes only a matter note has: they spawn or link work, or message the client. */
const MATTER_ONLY = [
  'POST /:noteId/tasks',
  'POST /:noteId/links/task',
  'POST /:noteId/links/file',
  'DELETE /:noteId/links/:linkId',
  'POST /:noteId/client-update',
];

/** Every `METHOD /suffix` an Express router registers, with the parent prefix stripped. */
function registeredRoutes(router: any, param: string): string[] {
  const out: string[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const suffix = (layer.route.path as string).replace(`/:${param}/notes`, '') || '/';
    for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${suffix}`);
  }
  return out.sort();
}

/** The permission list the catalog records for each `METHOD /suffix` of one parent. */
function cataloguedPermissions(prefix: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of ROUTE_CATALOG) {
    if (!row.path.startsWith(prefix)) continue;
    out[`${row.method} ${row.path.slice(prefix.length) || '/'}`] = [...(row.permissions || [])];
  }
  return out;
}

describe('the routes each notes mount registers', () => {
  const shared = registeredRoutes(taskNotesRouter, 'taskId');

  it('are the same fourteen for a task, a client and (apart from its own extras) a matter', () => {
    expect(shared).toHaveLength(14);
    expect(registeredRoutes(clientNotesRouter, 'clientId')).toEqual(shared);
    const matter = registeredRoutes(matterNotesRouter, 'matterId');
    expect(matter.filter((r) => !MATTER_ONLY.includes(r))).toEqual(shared);
    // The extras really are mounted: a typo in the allow-list must not hide a missing route.
    expect(matter.filter((r) => MATTER_ONLY.includes(r))).toEqual([...MATTER_ONLY].sort());
  });
});

describe.each(PARENTS)('the permission table for $name notes', (parent) => {
  const route = (method: string, suffix: string) => `${method} ${suffix}`;
  const expected: Record<string, string> = {
    [route('GET', '/')]: parent.perms.view,
    [route('GET', '/:noteId')]: parent.perms.view,
    [route('GET', '/:noteId/versions')]: parent.perms.view,
    [route('GET', '/:noteId/replies')]: parent.perms.view,
    [route('POST', '/')]: parent.perms.write,
    [route('PUT', '/:noteId')]: parent.perms.write,
    [route('PUT', '/:noteId/pin')]: parent.perms.write,
    [route('DELETE', '/:noteId')]: parent.perms.retract,
    [route('POST', '/:noteId/time')]: parent.perms.time,
    [route('PUT', '/:noteId/time/:timeEntryId')]: parent.perms.time,
    [route('DELETE', '/:noteId/time/:timeEntryId')]: parent.perms.time,
    [route('POST', '/:noteId/replies')]: parent.perms.reply,
    [route('PUT', '/:noteId/replies/:replyId')]: parent.perms.reply,
    [route('DELETE', '/:noteId/replies/:replyId')]: parent.perms.reply,
  };

  it('is what the route catalog records for each of the fourteen shared routes', () => {
    const catalogued = cataloguedPermissions(parent.catalogPrefix);
    const actual: Record<string, string> = {};
    for (const key of Object.keys(expected)) actual[key] = (catalogued[key] || []).join(',');
    expect(actual).toEqual(expected);
  });
});

describe.each(PARENTS)('$name notes through the real routes', (parent) => {
  let firm: Firm;
  let owner: Actor;
  let viewer: Actor;   // reads only
  let writer: Actor;   // the parent's write permission, no billing
  let biller: Actor;   // the parent's write permission plus billing
  let parentId: string;

  const notesPath = (suffix = '') => {
    const base = parent.name === 'matter' ? 'matters' : parent.name === 'task' ? 'tasks' : 'clients';
    return `/api/lawfirms/${firm.id}/${base}/${parentId}/notes${suffix}`;
  };
  const noteParent = (): NoteParent => ({ [parent.param]: parentId } as NoteParent);
  const timeRows = async () => (await testPool.query(
    `select count(*)::int n from activities where kind = 'time' and law_firm_id = $1`, [firm.id],
  )).rows[0].n as number;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    viewer = await memberWith(firm.id, [parent.perms.view]);
    writer = await memberWith(firm.id, [parent.perms.view, parent.perms.write]);
    biller = await memberWith(firm.id, [parent.perms.view, parent.perms.write, BILLING]);

    // A matter every actor is on, so matter-scoped parents (the matter itself and
    // the task) are reachable and give time a billing context.
    const client = await createPersonClient(firm.id, { name: 'Notes Parity Client' });
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Parity Matter', clients: [{ clientId: client.id, name: 'Notes Parity Client' }],
    });
    expect(matter.status).toBe(201);
    for (const actor of [viewer, writer, biller]) await seedMatterMember(firm.id, matter.body.matterId, actor.uid);

    if (parent.name === 'matter') parentId = matter.body.matterId;
    else if (parent.name === 'client') parentId = client.id;
    else {
      const task = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
        .send({ title: 'Parity task', matterId: matter.body.matterId });
      expect(task.status).toBe(201);
      parentId = task.body.taskId;
    }
  });

  it('lets a view-only member read the notes and refuses every write, adding no row', async () => {
    const seeded = await seedNote(firm.id, noteParent(), { content: 'Existing', createdBy: owner.uid });
    const before = await noteCount(firm.id);

    expect((await viewer.api.get(notesPath())).status).toBe(200);
    expect((await viewer.api.post(notesPath()).send({ content: 'Nope' })).status).toBe(403);
    expect((await viewer.api.post(notesPath(`/${seeded.id}/replies`)).send({ content: 'Nope' })).status).toBe(403);
    expect((await viewer.api.post(notesPath(`/${seeded.id}/time`)).send(TIME)).status).toBe(403);
    expect((await viewer.api.delete(notesPath(`/${seeded.id}`)).send({})).status).toBe(403);

    expect(await noteCount(firm.id)).toBe(before);
    expect((await noteRow(seeded.id)).retracted_at).toBeNull();
    expect(await timeRows()).toBe(0);
  });

  it('refuses time on a note, and a note posted with time, to a member with only the write permission', async () => {
    const seeded = await seedNote(firm.id, noteParent(), { content: 'Existing', createdBy: writer.uid });
    const before = await noteCount(firm.id);

    const addTime = await writer.api.post(notesPath(`/${seeded.id}/time`)).send(TIME);
    const withTime = await writer.api.post(notesPath()).send({ content: 'With time', timeEntries: [TIME] });

    expect(addTime.status).toBe(403);
    expect(withTime.status).toBe(403);
    // Refused before the note exists, so no half-written note without its time.
    expect(await noteCount(firm.id)).toBe(before);
    expect(await timeRows()).toBe(0);
  });

  it('still lets that member write a note with no time', async () => {
    const res = await writer.api.post(notesPath()).send({ content: 'Plain note' });

    expect(res.status).toBe(201);
  });

  it('accepts time on a note, and a note posted with time, from a member who also has the billing permission', async () => {
    const seeded = await seedNote(firm.id, noteParent(), { content: 'Existing', createdBy: biller.uid });

    const addTime = await biller.api.post(notesPath(`/${seeded.id}/time`)).send(TIME);
    const withTime = await biller.api.post(notesPath()).send({ content: 'With time', timeEntries: [TIME] });

    expect(addTime.status).toBe(201);
    expect(withTime.status).toBe(201);
    expect(await timeRows()).toBe(2);
  });

  it('does not turn time attached to an edit into a time entry, whoever sends it', async () => {
    const seeded = await seedNote(firm.id, noteParent(), { content: 'Existing', createdBy: writer.uid });

    const res = await writer.api.put(notesPath(`/${seeded.id}`)).send({ content: 'Edited', timeEntries: [TIME] });

    expect(res.status).toBe(200);
    expect(await timeRows()).toBe(0);
  });

  it("lets the author retract their own note with the parent's write permission alone", async () => {
    const seeded = await seedNote(firm.id, noteParent(), { content: 'Mine', createdBy: writer.uid });

    const res = await writer.api.delete(notesPath(`/${seeded.id}`)).send({});

    expect(res.status).toBe(200);
    expect((await noteRow(seeded.id)).retracted_at).not.toBeNull();
  });

  it('does not let a firm member without the parent write permission retract', async () => {
    const stranger = await createFirmMember(firm.id, { isOwner: false, permissions: [parent.perms.view] });
    const seeded = await seedNote(firm.id, noteParent(), { content: 'Theirs', createdBy: stranger.uid });

    const res = await viewer.api.delete(notesPath(`/${seeded.id}`)).send({});

    expect(res.status).toBe(403);
    expect((await noteRow(seeded.id)).retracted_at).toBeNull();
  });

  it('reaches every shared engine route with this parent', async () => {
    await walkNoteEngine({ actor: owner, lawFirmId: firm.id, parent: noteParent(), notesPath });
  });
});
