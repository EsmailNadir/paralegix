import { testPool, truncateAll, closeTestPool } from './db';
import {
  createFirm,
  createFirmMember,
  createPortalUser,
  createPersonClient,
  createOrgClient,
  linkPersonToOrg,
  setClientNotificationPref,
} from './factories';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('fixture factories', () => {
  it('creates a firm on a plan whose features are all enabled', async () => {
    const firm = await createFirm();

    const { rows } = await testPool.query(
      'select plan_id, billing_status from law_firms where id = $1',
      [firm.id],
    );
    // Not cosmetic: on the schema default of `starter`, requireFeature answers
    // 403 for templates, trust and signing.
    expect(rows[0].plan_id).toBe('enterprise');
    expect(rows[0].billing_status).toBe('comped');
  });

  it('creates an owner with no role row', async () => {
    const firm = await createFirm();
    const owner = await createFirmMember(firm.id);

    const { rows } = await testPool.query(
      'select is_owner, role_id from members where law_firm_id = $1 and user_id = $2',
      [firm.id, owner.uid],
    );
    expect(rows[0].is_owner).toBe(true);
    expect(rows[0].role_id).toBeNull();
  });

  it('creates a non-owner carrying exactly the permissions given', async () => {
    const firm = await createFirm();
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['clients.view', 'matters.view'],
    });

    const { rows } = await testPool.query(
      'select permissions from roles where id = $1',
      [member.roleId],
    );
    expect(rows[0].permissions).toEqual(['clients.view', 'matters.view']);
  });

  it('creates a person client, optionally owned by a portal user', async () => {
    const firm = await createFirm();
    const portal = await createPortalUser();
    const client = await createPersonClient(firm.id, {
      name: 'Alice Adams',
      userId: portal.uid,
      email: 'alice@example.test',
    });

    const { rows } = await testPool.query(
      'select name, client_type, user_id from clients where id = $1',
      [client.id],
    );
    expect(rows[0]).toMatchObject({
      name: 'Alice Adams',
      client_type: 'person',
      user_id: portal.uid,
    });
  });

  it('creates an organization that carries no portal user', async () => {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id, { name: 'Acme Corp' });

    const { rows } = await testPool.query(
      'select name, client_type, user_id from clients where id = $1',
      [org.id],
    );
    expect(rows[0].client_type).toBe('company');
    // An organization can never carry a portal identity here. The invoice
    // notification bug in be459ec0 was reading exactly this column.
    expect(rows[0].user_id).toBeNull();
  });

  it('links a person to an organization with the billing flag it was given', async () => {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id);
    const withBilling = await createPersonClient(firm.id);
    const withoutBilling = await createPersonClient(firm.id);

    await linkPersonToOrg(firm.id, withBilling.id, org.id, { canViewBilling: true, isPrimary: true });
    await linkPersonToOrg(firm.id, withoutBilling.id, org.id, { canViewBilling: false });

    const { rows } = await testPool.query(
      `select person_client_id, can_view_billing, is_primary
         from client_company_links
        where company_client_id = $1
        order by can_view_billing desc`,
      [org.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ person_client_id: withBilling.id, can_view_billing: true, is_primary: true });
    expect(rows[1]).toMatchObject({ person_client_id: withoutBilling.id, can_view_billing: false });
  });

  it('refuses to link a client to itself', async () => {
    const firm = await createFirm();
    const person = await createPersonClient(firm.id);

    await expect(linkPersonToOrg(firm.id, person.id, person.id, { canViewBilling: false }))
      .rejects.toThrow(/client_company_links_not_self/);
  });

  it('writes a notification opt-out into clients.settings', async () => {
    const firm = await createFirm();
    const client = await createPersonClient(firm.id);

    await setClientNotificationPref(client.id, 'invoiceIssued', false);
    await setClientNotificationPref(client.id, 'trustLowBalance', true);

    const { rows } = await testPool.query('select settings from clients where id = $1', [client.id]);
    expect(rows[0].settings.notifications).toEqual({ invoiceIssued: false, trustLowBalance: true });
  });

  it('empties every table on truncate', async () => {
    const firm = await createFirm();
    await createFirmMember(firm.id);
    await createPersonClient(firm.id);

    await truncateAll();

    for (const table of ['law_firms', 'members', 'clients', 'users']) {
      const { rows } = await testPool.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n).toBe(0);
    }
  });
});
