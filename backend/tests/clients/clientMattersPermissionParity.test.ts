/**
 * Attaching/detaching a client to a matter is reachable through two different
 * REST surfaces that both write the SAME `matter_clients` junction row:
 *
 *   POST/DELETE /matters/:matterId/clients[/:clientId]  - gated on
 *     `matters.manageClients` at the route, and the service additionally
 *     calls `assertMatterWriteAccess` (owner/admin bypass, else real matter
 *     membership) before writing.
 *
 *   POST/DELETE /clients/:clientId/matters[/:matterId]  - the client-side
 *     "Matters" tab, gated on `clients.manage` only. `addClientMatters`/
 *     `removeClientMatter` in `clients.service.ts` called straight into
 *     `clientsRepo.linkMatter`/`unlinkMatter` with no re-check of
 *     `matters.manageClients` and no matter-membership check at all - not
 *     even the owner/admin-bypass-or-membership rule the direct route
 *     enforces.
 *
 * That let a member holding ONLY `clients.manage` (no `matters.*` permission,
 * and not even a member of the target matter) attach or detach any client on
 * any matter in the firm by routing the write through the client-matters
 * endpoint instead of the direct matter-clients one - the direct route 403s
 * the same caller for the same mutation. Same class of bug as the matter/
 * client EVENTS permission-parity fix (clientEvents.service.ts delegating to
 * matterEventsService without re-checking `matters.update`), found by the
 * same sweep.
 *
 * Fixed by adding the identical two checks - `assertFirmPermission(lawFirmId,
 * userId, 'matters.manageClients')` and `assertMatterWriteAccess` - to
 * `addClientMatters`/`removeClientMatter` before they touch `matter_clients`.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let matterId: string;
// Holds `clients.manage` and is a real member of the matter, but has no
// `matters.*` permission at all - the exact combination that let the bug
// through even with matter-membership scoping in place.
let manager: Actor;
// Holds both `clients.manage` and `matters.manageClients`, to prove the fix
// does not overtighten the legitimate case.
let editor: Actor;

const clientMattersPath = (id?: string) =>
  `/api/lawfirms/${firm.id}/clients/${client.id}/matters${id ? `/${id}` : ''}`;
const matterClientsPath = (id?: string) =>
  `/api/lawfirms/${firm.id}/matters/${matterId}/clients${id ? `/${id}` : ''}`;

async function addMatterMember(uid: string) {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
    .send({ targetUserIds: [uid] });
  expect(res.status).toBe(200);
}

async function isLinked() {
  const { rows } = await testPool.query(
    'select 1 from matter_clients where law_firm_id = $1 and matter_id = $2 and client_id = $3',
    [firm.id, matterId, client.id],
  );
  return rows.length > 0;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;

  manager = await memberWith(firm.id, ['clients.manage', 'clients.view']);
  editor = await memberWith(firm.id, ['clients.manage', 'clients.view', 'matters.manageClients', 'matters.view']);
  await addMatterMember(manager.uid);
  await addMatterMember(editor.uid);
});

describe('attaching a client to a matter via the client-matters route', () => {
  it('403s a caller who holds clients.manage but not matters.manageClients, matching the direct matter route', async () => {
    const direct = await manager.api.post(matterClientsPath()).send({
      client: { clientId: client.id, name: client.id },
    });
    expect(direct.status).toBe(403);

    const viaClient = await manager.api.post(clientMattersPath()).send({ matterIds: [matterId] });
    expect(viaClient.status).toBe(403);
    expect(await isLinked()).toBe(false);
  });

  it('still lets a caller who genuinely holds matters.manageClients attach through the client route', async () => {
    const res = await editor.api.post(clientMattersPath()).send({ matterIds: [matterId] });
    expect(res.status).toBe(200);
    expect(await isLinked()).toBe(true);
  });
});

describe('detaching a client from a matter via the client-matters route', () => {
  beforeEach(async () => {
    const res = await owner.api.post(matterClientsPath()).send({
      client: { clientId: client.id, name: client.id },
    });
    expect(res.status).toBe(201);
    expect(await isLinked()).toBe(true);
  });

  it('403s a caller who holds clients.manage but not matters.manageClients, and leaves the link in place', async () => {
    const direct = await manager.api.delete(matterClientsPath(client.id));
    expect(direct.status).toBe(403);

    const viaClient = await manager.api.delete(clientMattersPath(matterId));
    expect(viaClient.status).toBe(403);
    expect(await isLinked()).toBe(true);
  });

  it('still lets a caller who genuinely holds matters.manageClients detach through the client route', async () => {
    const res = await editor.api.delete(clientMattersPath(matterId));
    expect(res.status).toBe(200);
    expect(await isLinked()).toBe(false);
  });
});

export {};
