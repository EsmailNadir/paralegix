/**
 * Creating a client with `matterIds` writes the same `matter_clients` rows as
 * the dedicated attach endpoints. It must not let `clients.manage` alone place
 * a new portal-visible client on a matter the caller cannot manage.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientManager: Actor;
let authorizedManager: Actor;
let matterId: string;

const clientsPath = () => `/api/lawfirms/${firm.id}/clients`;

async function clientsNamed(name: string) {
  const { rows } = await testPool.query(
    'select id from clients where law_firm_id = $1 and name = $2',
    [firm.id, name],
  );
  return rows as Array<{ id: string }>;
}

async function isLinked(clientId: string) {
  const { rows } = await testPool.query(
    `select 1 from matter_clients
      where law_firm_id = $1 and matter_id = $2 and client_id = $3`,
    [firm.id, matterId, clientId],
  );
  return rows.length === 1;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Confidential host matter',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;

  clientManager = await memberWith(firm.id, ['clients.manage', 'clients.view']);
  authorizedManager = await memberWith(firm.id, [
    'clients.manage',
    'clients.view',
    'matters.manageClients',
    'matters.view',
  ]);
  const membership = await owner.api
    .post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
    .send({ targetUserIds: [authorizedManager.uid] });
  expect(membership.status).toBe(200);
});

describe('client creation with matterIds uses the matter-client permission boundary', () => {
  it('refuses clients.manage alone before creating or linking a client to an inaccessible matter', async () => {
    const res = await clientManager.api.post(clientsPath()).send({
      name: 'Unauthorized Client',
      matterIds: [matterId],
    });

    // The canonical POST /matters/:matterId/clients endpoint requires
    // matters.manageClients and matter access for this same junction write.
    expect(res.status).toBe(403);
    expect(await clientsNamed('Unauthorized Client')).toEqual([]);
  });

  it('creates and links the client for a caller with the matching matter authority', async () => {
    const res = await authorizedManager.api.post(clientsPath()).send({
      name: 'Authorized Client',
      matterIds: [matterId],
    });

    expect(res.status).toBe(201);
    const created = await clientsNamed('Authorized Client');
    expect(created).toHaveLength(1);
    expect(await isLinked(created[0].id)).toBe(true);
  });
});

export {};
