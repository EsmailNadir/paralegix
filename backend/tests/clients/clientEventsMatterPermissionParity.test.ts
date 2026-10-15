/**
 * Matter events are reachable through two different REST surfaces:
 *
 *   POST/PUT/DELETE /matters/:matterId/events[...]   - gated on `matters.update`
 *   POST/PUT/DELETE /clients/:clientId/events[...]   - gated on `clients.manage`,
 *     but delegates straight into `matterEventsService` whenever the caller
 *     supplies a `matterId` (create) or `source: 'matter'` (update/delete),
 *     because the client events tab is a MERGED view of standalone client
 *     events and every event on the client's matters (see the "source" field
 *     in `clientEvents.service.ts`).
 *
 * `matterEventsService.createMatterEvent`/`updateMatterEvent`/`deleteMatterEvent`
 * only assert MATTER MEMBERSHIP (`assertMatterMembership`), not the `matters.update`
 * PERMISSION - permission is normally the route middleware's job. That split
 * meant a member holding `clients.manage` but nothing under `matters.*` could
 * mutate or delete deadlines/hearings on ANY matter they merely sit on as a
 * matter member, by routing the write through the client events endpoint
 * instead of the direct matter events one. The direct route would 403 the same
 * caller for the same operation.
 *
 * `clientEventsService` now calls `assertFirmPermission(lawFirmId, userId,
 * 'matters.update')` before every delegation into matter-event writes, so the
 * two surfaces enforce the identical permission for the identical mutation.
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
// Holds `clients.manage` but no `matters.*` permission at all - the exact
// combination that let the bug through.
let manager: Actor;
// Holds both, to prove the fix does not also break the legitimate case where
// a caller genuinely has `matters.update`.
let editor: Actor;

const clientEventPath = (eventId?: string) =>
  `/api/lawfirms/${firm.id}/clients/${client.id}/events${eventId ? `/${eventId}` : ''}`;
const matterEventPath = (eventId?: string) =>
  `/api/lawfirms/${firm.id}/matters/${matterId}/events${eventId ? `/${eventId}` : ''}`;

async function addMatterMember(uid: string) {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
    .send({ targetUserIds: [uid] });
  expect(res.status).toBe(200);
}

async function matterEventRow(id: string) {
  const { rows } = await testPool.query(
    'select id, title, status from events where id = $1', [id],
  );
  return rows[0] || null;
}

async function matterEventCount() {
  const { rows } = await testPool.query(
    'select count(*)::int n from events where law_firm_id = $1 and matter_id = $2',
    [firm.id, matterId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter', clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;

  manager = await memberWith(firm.id, ['clients.manage', 'clients.view']);
  editor = await memberWith(firm.id, ['clients.manage', 'clients.view', 'matters.update', 'matters.view']);
  await addMatterMember(manager.uid);
  await addMatterMember(editor.uid);
});

describe('creating a matter event via the client events route', () => {
  it('403s a caller who holds clients.manage but not matters.update, matching the direct matter route', async () => {
    const direct = await manager.api.post(matterEventPath()).send({
      type: 'hearing', title: 'Direct Attempt', date: '2026-06-01', allDay: true,
    });
    expect(direct.status).toBe(403);

    const viaClient = await manager.api.post(clientEventPath()).send({
      type: 'hearing', title: 'Via Client Route', date: '2026-06-01', allDay: true, matterId,
    });
    expect(viaClient.status).toBe(403);
    expect(await matterEventCount()).toBe(0);
  });

  it('still lets a caller who genuinely holds matters.update create through the client route', async () => {
    const res = await editor.api.post(clientEventPath()).send({
      type: 'hearing', title: 'Legit Create', date: '2026-06-01', allDay: true, matterId,
    });
    expect(res.status).toBe(201);
    expect(await matterEventCount()).toBe(1);
  });
});

describe('updating a matter event via the client events route', () => {
  it('403s a caller who holds clients.manage but not matters.update, and leaves the event untouched', async () => {
    const created = await owner.api.post(matterEventPath()).send({
      type: 'hearing', title: 'Original Title', date: '2026-06-01', allDay: true,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;

    const res = await manager.api.put(clientEventPath(eventId)).send({
      source: 'matter', matterId, title: 'Hijacked Title',
    });
    expect(res.status).toBe(403);

    const row = await matterEventRow(eventId);
    expect(row.title).toBe('Original Title');
  });

  it('still lets a caller who genuinely holds matters.update update through the client route', async () => {
    const created = await owner.api.post(matterEventPath()).send({
      type: 'hearing', title: 'Original Title', date: '2026-06-01', allDay: true,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;

    const res = await editor.api.put(clientEventPath(eventId)).send({
      source: 'matter', matterId, title: 'Updated By Editor',
    });
    expect(res.status).toBe(200);

    const row = await matterEventRow(eventId);
    expect(row.title).toBe('Updated By Editor');
  });
});

describe('deleting a matter event via the client events route', () => {
  it('403s a caller who holds clients.manage but not matters.update, and leaves the event in place', async () => {
    const created = await owner.api.post(matterEventPath()).send({
      type: 'hearing', title: 'Do Not Delete Me', date: '2026-06-01', allDay: true,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;

    const res = await manager.api.delete(`${clientEventPath(eventId)}?source=matter&matterId=${matterId}`);
    expect(res.status).toBe(403);
    expect(await matterEventRow(eventId)).not.toBeNull();
  });

  it('still lets a caller who genuinely holds matters.update delete through the client route', async () => {
    const created = await owner.api.post(matterEventPath()).send({
      type: 'hearing', title: 'Fine To Delete', date: '2026-06-01', allDay: true,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;

    const res = await editor.api.delete(`${clientEventPath(eventId)}?source=matter&matterId=${matterId}`);
    expect(res.status).toBe(200);
    expect(await matterEventRow(eventId)).toBeNull();
  });
});

export {};
