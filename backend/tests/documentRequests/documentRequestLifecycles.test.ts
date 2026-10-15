import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  createRequest,
  getRequest,
  updateItem,
  listRequests,
} from '../../src/modules/documentRequests/documentRequests.service';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;

async function seedClient(lawFirmId: string, name = 'Doc Client') {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, email, client_type) values ($1, $2, $3, 'doc@example.com', 'person')`,
    [id, lawFirmId, name],
  );
  return { id, name };
}

/**
 * A matter, optionally with a client already on its `matter_clients` roster
 * and/or a user already on its `matter_members` staffing (`createRequest`'s
 * `matterId` branch checks both independently: `assertMatterMembership` for
 * the caller, `getClientOnMatter` for the client named in the body).
 */
const seedDocMatter = async (lawFirmId: string, opts: { clientId?: string; memberUid?: string } = {}) => ({
  id: await seedMatter(lawFirmId, {
    name: 'Doc Matter',
    clientIds: opts.clientId ? [opts.clientId] : [],
    memberUids: opts.memberUid ? [opts.memberUid] : [],
  }),
});

describe('Document Requests Lifecycle & Fulfillments', () => {
  beforeEach(async () => {
    firm = await createFirm({ name: 'Doc Request Firm' });
    owner = await ownerOf(firm.id);
  });

  it('supports waiving or manually marking an item received from firm side', async () => {
    const client = await seedClient(firm.id);
    const { request } = await createRequest({
      lawFirmId: firm.id,
      userId: owner.uid,
      clientId: client.id,
      title: 'Prior Year Returns',
      items: [
        { label: '2024 Tax Return', isRequired: true },
      ],
    });

    const itemId = request.items[0].id;

    // Firm waives the requirement
    await updateItem({
      lawFirmId: firm.id,
      userId: owner.uid,
      requestId: request.id,
      itemId,
      status: 'waived',
    });

    const updated = await getRequest({
      lawFirmId: firm.id,
      userId: owner.uid,
      requestId: request.id,
    });
    expect(updated.request.items[0].status).toBe('waived');
    expect(updated.request.status).toBe('completed'); // All required items waived/received
  });

  describe('matter-scoped requests', () => {
    it('creates a request against a client on the matter, and it appears on the matter list', async () => {
      const client = await seedClient(firm.id);
      const matter = await seedDocMatter(firm.id, { clientId: client.id, memberUid: owner.uid });

      const { request } = await createRequest({
        lawFirmId: firm.id,
        userId: owner.uid,
        matterId: matter.id,
        clientId: client.id,
        title: 'Discovery Documents',
        items: [{ label: 'Signed Retainer', isRequired: true }],
      });

      expect(request.matterId).toBe(matter.id);

      const list = await listRequests({ lawFirmId: firm.id, userId: owner.uid, matterId: matter.id });
      expect(list.requests.map((r: any) => r.id)).toContain(request.id);
    });

    it('refuses a client that is not on the matter roster', async () => {
      const onMatter = await seedClient(firm.id, 'On The Matter');
      const notOnMatter = await seedClient(firm.id, 'Not On The Matter');
      // `onMatter` is linked; `notOnMatter` is a real client of the same firm,
      // just never added to THIS matter's `matter_clients` roster.
      const matter = await seedDocMatter(firm.id, { clientId: onMatter.id, memberUid: owner.uid });

      await expect(createRequest({
        lawFirmId: firm.id,
        userId: owner.uid,
        matterId: matter.id,
        clientId: notOnMatter.id,
        title: 'Wrong Client',
        items: [{ label: 'Anything' }],
      })).rejects.toThrow('The selected client is not on this matter');
    });

    it('refuses a caller who is not staffed on the matter', async () => {
      const client = await seedClient(firm.id);
      // No `memberUid`: the matter exists and the client is on its roster, but
      // nobody is staffed on it yet.
      const matter = await seedDocMatter(firm.id, { clientId: client.id });

      await expect(createRequest({
        lawFirmId: firm.id,
        userId: owner.uid,
        matterId: matter.id,
        clientId: client.id,
        title: 'Unstaffed Matter',
        items: [{ label: 'Anything' }],
      })).rejects.toThrow('User is not a member of this matter');
    });
  });
});
