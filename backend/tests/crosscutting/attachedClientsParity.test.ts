/**
 * A matter and a task each hold a set of attached clients, and the screens treat
 * the two the same way (one attach modal, one adapter per parent). The backends
 * are not the same code: a matter links through `matter_clients` with its own
 * route per operation, a task replaces the whole `task_clients` set on update.
 * This file holds both to one contract, through the real routes:
 *
 *   - attach, read back, detach;
 *   - attaching the same client twice leaves one link and no error;
 *   - an organization attaches like a person;
 *   - another firm's client never gets a junction row, and nothing of theirs is
 *     read back;
 *   - a view-only member cannot attach or detach, and the set is unchanged;
 *   - removing an organization removes ONLY the organization. Its roster people
 *     stay attached on both parents (decision D-1). The task page used to
 *     remove them as well, which the matter page never did.
 *
 * A task's attached clients are only held by a firm-wide task (a matter task
 * derives its clients from its matter), so the task adapter uses one.
 *
 * Red if the task update writes `task_clients` without the firm check or
 * replaces the set wrongly, if a matter link skips its tenant scope, or if
 * either parent starts cascading an organization's removal to its roster.
 */
import {
  createFirm,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedMatterMember } from '../support/matters';

interface Adapter {
  name: string;
  /** A parent in `firm` and the permission set that may edit its clients. */
  setup: (firm: Firm, owner: Actor) => Promise<{ parentId: string; editPermissions: string[]; viewPermissions: string[] }>;
  attach: (actor: Actor, firm: Firm, parentId: string, clientId: string, name: string) => Promise<{ status: number }>;
  detach: (actor: Actor, firm: Firm, parentId: string, clientId: string) => Promise<{ status: number }>;
  /** The attached client ids, straight from the junction table. */
  linked: (parentId: string) => Promise<string[]>;
  /** The attached client ids as the parent's own read route reports them. */
  readBack: (actor: Actor, firm: Firm, parentId: string) => Promise<string[]>;
  /** Make `actor` able to reach the parent at all (a matter is walled by membership). */
  admit: (firm: Firm, parentId: string, actor: Actor) => Promise<void>;
}

const sorted = (ids: string[]) => [...ids].sort();

const matterAdapter: Adapter = {
  name: 'a matter',
  async setup(firm, owner) {
    const parentId = await seedMatter(firm.id, { name: 'Parity matter', memberUids: [owner.uid] });
    return { parentId, editPermissions: ['matters.view', 'matters.manageClients'], viewPermissions: ['matters.view'] };
  },
  attach: (actor, firm, parentId, clientId, name) => actor.api
    .post(`/api/lawfirms/${firm.id}/matters/${parentId}/clients`).send({ client: { clientId, name } }),
  detach: (actor, firm, parentId, clientId) => actor.api
    .delete(`/api/lawfirms/${firm.id}/matters/${parentId}/clients/${clientId}`),
  async linked(parentId) {
    const { rows } = await testPool.query('select client_id from matter_clients where matter_id = $1', [parentId]);
    return sorted(rows.map((r: any) => r.client_id));
  },
  async readBack(actor, firm, parentId) {
    const res = await actor.api.get(`/api/lawfirms/${firm.id}/matters/${parentId}/clients`);
    expect(res.status).toBe(200);
    return sorted(res.body.clients.map((c: any) => c.id));
  },
  admit: (firm, parentId, actor) => seedMatterMember(firm.id, parentId, actor.uid, 'member'),
};

const taskAdapter: Adapter = {
  name: 'a firm-wide task',
  async setup(firm, owner) {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Parity task' });
    expect(res.status).toBe(201);
    // Changing a task's client set also takes clients.manage, the same gate the
    // task page applies to its client picker (tests/tasks/taskClientPermissions).
    return {
      parentId: res.body.taskId,
      editPermissions: ['tasks.view', 'tasks.update', 'clients.manage'],
      viewPermissions: ['tasks.view'],
    };
  },
  // A task takes the whole set on update, so an attach is "what is there, plus this".
  async attach(actor, firm, parentId, clientId) {
    const current = (await testPool.query('select client_id from task_clients where task_id = $1', [parentId]))
      .rows.map((r: any) => r.client_id);
    return actor.api.put(`/api/lawfirms/${firm.id}/tasks/${parentId}`)
      .send({ clientIds: [...new Set([...current, clientId])] });
  },
  async detach(actor, firm, parentId, clientId) {
    const current = (await testPool.query('select client_id from task_clients where task_id = $1', [parentId]))
      .rows.map((r: any) => r.client_id);
    return actor.api.put(`/api/lawfirms/${firm.id}/tasks/${parentId}`)
      .send({ clientIds: current.filter((id: string) => id !== clientId) });
  },
  async linked(parentId) {
    const { rows } = await testPool.query('select client_id from task_clients where task_id = $1', [parentId]);
    return sorted(rows.map((r: any) => r.client_id));
  },
  async readBack(actor, firm, parentId) {
    const res = await actor.api.get(`/api/lawfirms/${firm.id}/tasks/${parentId}`);
    expect(res.status).toBe(200);
    return sorted(res.body.clientIds || []);
  },
  async admit() { /* a firm-wide task is visible to every member */ },
};

describe.each([matterAdapter, taskAdapter])('attached clients on $name', (adapter) => {
  let firm: Firm;
  let owner: Actor;
  let parentId: string;
  let editPermissions: string[];
  let viewPermissions: string[];
  let person: { id: string };
  let org: { id: string };
  let rosterPerson: { id: string };
  let foreign: { id: string };

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    ({ parentId, editPermissions, viewPermissions } = await adapter.setup(firm, owner));
    person = await createPersonClient(firm.id, { name: 'Pat Person' });
    org = await createOrgClient(firm.id, { name: 'Acme Org' });
    rosterPerson = await createPersonClient(firm.id, { name: 'Roster Person' });
    await linkPersonToOrg(firm.id, rosterPerson.id, org.id, { canViewBilling: false });
    const other = await createFirm();
    foreign = await createPersonClient(other.id, { name: 'Foreign Client' });
  });

  it('attaches a client, reads it back, and detaches it', async () => {
    const attached = await adapter.attach(owner, firm, parentId, person.id, 'Pat Person');
    expect([200, 201]).toContain(attached.status);
    expect(await adapter.linked(parentId)).toEqual([person.id]);
    expect(await adapter.readBack(owner, firm, parentId)).toEqual([person.id]);

    const detached = await adapter.detach(owner, firm, parentId, person.id);
    expect(detached.status).toBe(200);
    expect(await adapter.linked(parentId)).toEqual([]);
    expect(await adapter.readBack(owner, firm, parentId)).toEqual([]);
  });

  it('keeps one link when the same client is attached twice', async () => {
    await adapter.attach(owner, firm, parentId, person.id, 'Pat Person');

    const again = await adapter.attach(owner, firm, parentId, person.id, 'Pat Person');

    expect([200, 201]).toContain(again.status);
    expect(await adapter.linked(parentId)).toEqual([person.id]);
  });

  it('attaches an organization like a person', async () => {
    const res = await adapter.attach(owner, firm, parentId, org.id, 'Acme Org');

    expect([200, 201]).toContain(res.status);
    expect(await adapter.linked(parentId)).toEqual([org.id]);
    expect(await adapter.readBack(owner, firm, parentId)).toEqual([org.id]);
  });

  it("never links another firm's client, and keeps the clients it already had", async () => {
    await adapter.attach(owner, firm, parentId, person.id, 'Pat Person');

    await adapter.attach(owner, firm, parentId, foreign.id, 'Foreign Client');

    // What happens next differs by design. A task replaces its set and drops an
    // id that is not this firm's. A matter treats an unknown id as an inline
    // "new client" and creates one of THIS firm from the fields in the request.
    // The contract both share: the stranger's own row is never linked or
    // touched, and nothing the parent already had is lost.
    const linked = await adapter.linked(parentId);
    expect(linked).toContain(person.id);
    expect(linked).not.toContain(foreign.id);
    const stranger = await testPool.query('select name, law_firm_id from clients where id = $1', [foreign.id]);
    expect(stranger.rows[0].name).toBe('Foreign Client');
    expect(stranger.rows[0].law_firm_id).not.toBe(firm.id);
    const { rows } = await testPool.query(
      `select count(*)::int n from (
         select client_id from matter_clients where client_id = $1
         union all select client_id from task_clients where client_id = $1) q`,
      [foreign.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a view-only member an attach and a detach, and leaves the set as it was', async () => {
    await adapter.attach(owner, firm, parentId, person.id, 'Pat Person');
    const viewer = await memberWith(firm.id, viewPermissions);
    await adapter.admit(firm, parentId, viewer);

    const attach = await adapter.attach(viewer, firm, parentId, org.id, 'Acme Org');
    const detach = await adapter.detach(viewer, firm, parentId, person.id);

    expect(attach.status).toBe(403);
    expect(detach.status).toBe(403);
    expect(await adapter.linked(parentId)).toEqual([person.id]);
  });

  it('lets a member with the edit permission attach, so the refusal above is the permission and nothing else', async () => {
    const editor = await memberWith(firm.id, editPermissions);
    await adapter.admit(firm, parentId, editor);

    const res = await adapter.attach(editor, firm, parentId, person.id, 'Pat Person');

    expect([200, 201]).toContain(res.status);
    expect(await adapter.linked(parentId)).toEqual([person.id]);
  });

  it('removes only the organization when it is detached, and keeps its roster people attached', async () => {
    await adapter.attach(owner, firm, parentId, org.id, 'Acme Org');
    await adapter.attach(owner, firm, parentId, rosterPerson.id, 'Roster Person');
    expect(await adapter.linked(parentId)).toEqual(sorted([org.id, rosterPerson.id]));

    const res = await adapter.detach(owner, firm, parentId, org.id);

    expect(res.status).toBe(200);
    expect(await adapter.linked(parentId)).toEqual([rosterPerson.id]);
  });
});
