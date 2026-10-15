/**
 * Client CRUD, characterized in process.
 *
 * The first three cases mirror what the live suite already covers, and assert
 * the response shape that ships today rather than a shape someone thinks is
 * right. The last three are the point of the harness: they need a second firm,
 * a partially permissioned role, and a caller who is nobody, and the live suite
 * has one firm and one fully permissioned account.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  createOrgClient,
  ownerOf,
  memberWith,
  stranger,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
const eventBus = require('../../src/shared/events/eventBus');
const { CLIENT_DELETED } = require('../../src/shared/events/eventTypes');

// The client deletion case delivers the real CLIENT_DELETED listener, which
// removes the client's stored files. Keep that storage boundary real without
// letting the harness's intentionally fail-loud default bucket obscure this
// focused client-route suite.
installInMemoryBucket();

beforeEach(() => {
  objects.clear();
});

describe('clients, in process', () => {
  it('creates a person client and returns it', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Acme Person', email: 'acme@example.test' });

    expect(res.status).toBe(201);
    // Characterized, not assumed. This route answers with an id and a portal
    // status, not the created record, which is a deviation from the create
    // envelope the backend conventions describe.
    expect(res.body).toMatchObject({
      message: 'Client created successfully',
      clientId: expect.any(String),
    });

    const read = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${res.body.clientId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ name: 'Acme Person', clientType: 'person' });
  });

  it('creates an organization client', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Acme Corp', clientType: 'company' });

    expect(res.status).toBe(201);

    const read = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${res.body.clientId}`);
    expect(read.body.clientType).toBe('company');
    // An organization never carries a portal identity on the client row itself.
    // The invoice notification bug in be459ec0 read exactly this field.
    expect(read.body.userId ?? null).toBeNull();
  });

  it('lists a firm its own clients and nobody else', async () => {
    const firmA = await createFirm();
    const firmB = await createFirm();
    const ownerA = await ownerOf(firmA.id);
    await createPersonClient(firmA.id, { name: 'Belongs To A' });
    await createPersonClient(firmB.id, { name: 'Belongs To B' });
    await createOrgClient(firmB.id, { name: 'Also B' });

    const res = await ownerA.api.get(`/api/lawfirms/${firmA.id}/clients`);

    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: any) => c.name);
    expect(names).toEqual(['Belongs To A']);
  });

  it('refuses one firm access to another firm\'s client', async () => {
    const firmA = await createFirm();
    const firmB = await createFirm();
    const clientA = await createPersonClient(firmA.id);
    const ownerB = await ownerOf(firmB.id);

    // Asked for under firm B, whose owner is a legitimate member, so this is the
    // tenancy boundary rather than an authentication failure.
    const res = await ownerB.api.get(`/api/lawfirms/${firmB.id}/clients/${clientA.id}`);

    expect(res.status).toBe(404);
  });

  it('lets any member read the client list, even with an empty role', async () => {
    // Deliberate product behaviour, not a hole. resolveFromRolePermissions unions
    // every role with DEFAULT_PERMISSIONS, an always-on baseline that carries
    // every `.view` code. It is what keeps a narrow role on a read-only page
    // instead of a denial screen. Pinned here because a change to that baseline
    // silently widens what every member of every firm can read.
    const firm = await createFirm();
    const member = await memberWith(firm.id, []);

    const res = await member.api.get(`/api/lawfirms/${firm.id}/clients`);

    expect(res.status).toBe(200);
  });

  it('refuses a member without clients.manage the right to create one', async () => {
    // Writes are NOT in the baseline, which is where the boundary actually sits.
    const firm = await createFirm();
    const member = await memberWith(firm.id, ['clients.view']);

    const res = await member.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Should Not Exist' });

    expect(res.status).toBe(403);
  });

  it('allows a member holding clients.manage to create one', async () => {
    const firm = await createFirm();
    const member = await memberWith(firm.id, ['clients.manage']);

    const res = await member.api
      .post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Created By Role' });

    expect(res.status).toBe(201);
  });

  it('refuses a signed-in caller who is a member of no firm', async () => {
    const firm = await createFirm();

    const res = await stranger().api.get(`/api/lawfirms/${firm.id}/clients`);

    expect(res.status).toBe(403);
  });
  it.each([
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
  ])('rejects a create with %s before creating a blank-looking record', async (_label, name) => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/clients`).send({ name });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from clients where law_firm_id = $1',
      [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('updates a client name', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Before' });

    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${client.id}`)
      .send({ name: 'After' });

    expect(res.status).toBe(200);
    const read = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${client.id}`);
    expect(read.body.name).toBe('After');
  });

  describe('update applies the same per-field rules as create', () => {
    const update = async (body: Record<string, unknown>) => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const client = await createPersonClient(firm.id, { name: 'Stays Put' });
      const res = await owner.api.put(`/api/lawfirms/${firm.id}/clients/${client.id}`).send(body);
      const { rows } = await testPool.query(
        'select name, phone, organization, address from clients where id = $1', [client.id],
      );
      return { res, row: rows[0] };
    };

    it.each(['', '   ', '\t\n'])('refuses blanking the name with %j and keeps the stored name', async (name) => {
      const { res, row } = await update({ name });
      expect(res.status).toBe(400);
      expect(row.name).toBe('Stays Put');
    });

    it('trims a padded name before storing it', async () => {
      const { res, row } = await update({ name: '  Padded Name  ' });
      expect(res.status).toBe(200);
      expect(row.name).toBe('Padded Name');
    });

    it.each([
      ['phone', 101],
      ['organization', 201],
      ['address', 1001],
    ])('refuses a %s longer than create allows (%i characters), changing nothing', async (field, length) => {
      const { res, row } = await update({ name: 'Renamed', [field]: 'x'.repeat(length) });
      expect(res.status).toBe(400);
      expect(row.name).toBe('Stays Put');
      expect(row[field]).toBeNull();
    });
  });

  it('cannot delete another firm client while deleting its own client works', async () => {
    const firstFirm = await createFirm();
    const secondFirm = await createFirm();
    const firstClient = await createPersonClient(firstFirm.id, { name: 'First firm client' });
    const secondClient = await createPersonClient(secondFirm.id, { name: 'Second firm client' });
    const secondOwner = await ownerOf(secondFirm.id);

    const refused = await secondOwner.api.delete(`/api/lawfirms/${secondFirm.id}/clients/${firstClient.id}`);
    expect(refused.status).toBe(404);
    const { rows: firstRows } = await testPool.query('select name from clients where id = $1', [firstClient.id]);
    expect(firstRows).toEqual([{ name: 'First firm client' }]);

    const ownDelete = await secondOwner.api.delete(`/api/lawfirms/${secondFirm.id}/clients/${secondClient.id}`);
    expect(ownDelete.status).toBe(200);
    const { rows: secondRows } = await testPool.query('select id from clients where id = $1', [secondClient.id]);
    expect(secondRows).toHaveLength(0);
  });

  it('answers not-found on a repeated client deletion', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id);

    const first = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);
    const second = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });

  it('finishes client deletion listeners before acknowledging removal', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id);
    let finished = false;
    const listener = async ({ clientId }: { clientId: string }) => {
      if (clientId !== client.id) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
    };
    eventBus.on(CLIENT_DELETED, listener);
    try {
      const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);
      expect(res.status).toBe(200);
      expect(finished).toBe(true);
    } finally {
      eventBus.off(CLIENT_DELETED, listener);
    }
  });

});
