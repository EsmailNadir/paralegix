/**
 * `clients.routes.ts`'s create and update client-event handlers build the
 * service call as `{ lawFirmId: req.params.lawFirmId, clientId: req.params.clientId,
 * ..., ...req.body }` - trusted fields spread BEFORE the raw body. `validate()`'s
 * `writeBack()` merges the zod-parsed body OVER `req.body` (`{ ...current,
 * ...parsed }`), so a key the schema does not declare (`lawFirmId`, `clientId`,
 * `eventId`) survives on `req.body` after validation and then wins the later
 * spread in the route handler, silently overriding the trusted value.
 *
 * `clientEventsService.createClientEvent`/`updateClientEvent` call
 * `assertLawFirmMembership(lawFirmId, userId)` first - not `assertClientInFirm`
 * against the URL firm - so a caller who is a bystander member (zero granted
 * permissions) of a SECOND firm can smuggle that second firm's id through the
 * body and have the write land there, even though `requirePermission` only
 * checked `clients.manage` against the URL firm.
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
let otherFirm: Firm;
let otherOwner: Actor;
let otherClient: ClientRecord;

const eventsPath = (lawFirmId = firm.id, clientId = client.id) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}/events`;

async function eventRow(id: string) {
  const { rows } = await testPool.query(
    'select id, law_firm_id, client_id, title from events where id = $1', [id],
  );
  return rows[0] || null;
}

async function eventsForFirm(lawFirmId: string) {
  const { rows } = await testPool.query(
    'select id, client_id, title from events where law_firm_id = $1', [lawFirmId],
  );
  return rows;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Home Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Home Client' });

  otherFirm = await createFirm({ name: 'Neighbour Firm' });
  otherOwner = await ownerOf(otherFirm.id);
  otherClient = await createPersonClient(otherFirm.id, { name: 'Neighbour Client' });
});

describe('server-owned fields cannot be widened from the body', () => {
  it('ignores a lawFirmId/clientId in the create body and never writes into the other firm', async () => {
    // The A04 shape: the SAME person holds `clients.manage` in their own firm
    // (via the URL) and is ALSO a bare member of a second firm, with no
    // permissions granted there at all - exactly what `assertLawFirmMembership`
    // alone lets through.
    await memberWith(otherFirm.id, [], { uid: owner.uid });

    const res = await owner.api.post(eventsPath()).send({
      type: 'meeting',
      title: 'Smuggled Event',
      date: '2026-05-10',
      allDay: true,
      lawFirmId: otherFirm.id,
      clientId: otherClient.id,
    });

    // If the body's lawFirmId/clientId won, this would come back 201 with the
    // event written under `otherFirm.id`/`otherClient.id`, despite the caller
    // holding zero permissions in that firm.
    expect(res.status).toBe(201);

    const leaked = await eventsForFirm(otherFirm.id);
    expect(leaked).toHaveLength(0);

    const home = await eventsForFirm(firm.id);
    expect(home).toHaveLength(1);
    expect(home[0].client_id).toBe(client.id);
    expect(home[0].title).toBe('Smuggled Event');
  });

  it('ignores an eventId/lawFirmId/clientId in the update body and never touches the victim event', async () => {
    await memberWith(otherFirm.id, [], { uid: owner.uid });

    const victimRes = await otherOwner.api.post(eventsPath(otherFirm.id, otherClient.id)).send({
      type: 'meeting',
      title: 'Neighbour Original',
      date: '2026-05-10',
      allDay: true,
    });
    expect(victimRes.status).toBe(201);
    const victimId = (victimRes.body.event?.id ?? victimRes.body.eventId) as string;

    const mineRes = await owner.api.post(eventsPath()).send({
      type: 'meeting',
      title: 'My Original',
      date: '2026-05-10',
      allDay: true,
    });
    expect(mineRes.status).toBe(201);
    const mineId = (mineRes.body.event?.id ?? mineRes.body.eventId) as string;

    const res = await owner.api.put(`${eventsPath()}/${mineId}`).send({
      source: 'client',
      title: 'Hijacked',
      lawFirmId: otherFirm.id,
      clientId: otherClient.id,
      eventId: victimId,
    });

    expect(res.status).toBe(200);
    expect((await eventRow(mineId)).title).toBe('Hijacked');
    expect((await eventRow(victimId)).title).toBe('Neighbour Original');
  });
});

export {};
