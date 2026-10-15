/**
 * Client records are firm-wide, but a client's matter associations are not.
 * The client detail/list convenience fields and client-side Matters tab must
 * apply the matter ethical wall before exposing those associations.
 */
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let outsider: Actor;
let client: ClientRecord;
let matterId: string;

const C = (suffix = '') => `/api/lawfirms/${firm.id}/clients${suffix}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  outsider = await memberWith(firm.id, []);
  client = await createPersonClient(firm.id, { name: 'Matter-associated client' });

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Matter Cormorant',
    clients: [{ clientId: client.id, name: 'Matter-associated client' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
});

describe('client-side matter reads', () => {
  it('shows a matter member the client association but hides it from another firm member', async () => {
    const ownerDetail = await owner.api.get(C(`/${client.id}`));
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.matterIds).toEqual([matterId]);

    const ownerMatters = await owner.api.get(C(`/${client.id}/matters`));
    expect(ownerMatters.status).toBe(200);
    expect(ownerMatters.body.matters).toHaveLength(1);
    expect(ownerMatters.body.matters[0]).toMatchObject({ id: matterId, name: 'Matter Cormorant' });

    const outsiderDetail = await outsider.api.get(C(`/${client.id}`));
    expect(outsiderDetail.status).toBe(200);
    expect(outsiderDetail.body.matterIds).toEqual([]);
    expect(JSON.stringify(outsiderDetail.body)).not.toContain(matterId);

    const outsiderMatters = await outsider.api.get(C(`/${client.id}/matters`));
    expect(outsiderMatters.status).toBe(200);
    expect(outsiderMatters.body.matters).toEqual([]);
    expect(JSON.stringify(outsiderMatters.body)).not.toContain('Matter Cormorant');
  });

  it('does not expose a matter association through the client list or matter-scoped client picker', async () => {
    const ownerList = await owner.api.get(C());
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.clients.find((row: any) => row.id === client.id).matterIds).toEqual([matterId]);

    const outsiderList = await outsider.api.get(C());
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.clients.find((row: any) => row.id === client.id).matterIds).toEqual([]);

    const scopedList = await outsider.api.get(`${C()}?matterId=${matterId}`);
    expect(scopedList.status).toBe(403);
    expect(JSON.stringify(scopedList.body)).not.toContain('Matter-associated client');

    const scopedLookup = await outsider.api.get(`${C('/lookup')}?matterId=${matterId}`);
    expect(scopedLookup.status).toBe(403);
    expect(JSON.stringify(scopedLookup.body)).not.toContain('Matter-associated client');
  });
});

describe('client batch reads apply the matter wall to matterIds', () => {
  it('omits a walled matter id from the full lookup and keeps it for the owner', async () => {
    const ownerLookup = await owner.api.get(`${C('/lookup')}?full=true&search=Matter-associated`);
    expect(ownerLookup.status).toBe(200);
    expect(ownerLookup.body.items.find((row: any) => row.id === client.id).matterIds).toEqual([matterId]);

    const outsiderLookup = await outsider.api.get(`${C('/lookup')}?full=true&search=Matter-associated`);
    expect(outsiderLookup.status).toBe(200);
    const row = outsiderLookup.body.items.find((item: any) => item.id === client.id);
    expect(row).toBeDefined();
    expect(row.matterIds).toEqual([]);
    expect(JSON.stringify(outsiderLookup.body)).not.toContain(matterId);
  });

  it('omits a walled matter id from the full lookup resolved by id', async () => {
    const res = await outsider.api.get(`${C('/lookup')}?full=true&ids=${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].matterIds).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(matterId);
  });

  it('does not carry a walled matter id in the batch resolve by ids on the list route', async () => {
    const res = await outsider.api.get(`${C()}?ids=${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0].id).toBe(client.id);
    expect(JSON.stringify(res.body)).not.toContain(matterId);
  });
});

export {};
