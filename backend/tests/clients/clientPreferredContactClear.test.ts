/**
 * Clearing a client's preferred contact method, through the real routes.
 *
 * The client forms offer "None" for this field. The update route treats an
 * absent field as "leave it alone" and `null` as "clear it", the same as email,
 * phone, organization and address. Two things have to hold for "None" to stick:
 *
 *   THE UPDATE ROUTE ACCEPTS NULL. Otherwise the request is refused and the old
 *   preference stays on the record.
 *
 *   THE MATTER'S CLIENT LIST READS A CLEARED VALUE BACK AS NULL. The matter page
 *   seeds its Edit Client form from that list, so a read that turned null into
 *   'email' would show the cleared preference as "Email" on the next open.
 */
import { randomUUID } from 'crypto';
import { testPool, createFirm, createPersonClient, ownerOf } from '../support/setupInProcess';

async function seedPreference(clientId: string, method: string) {
  await testPool.query('update clients set preferred_contact_method = $2 where id = $1', [clientId, method]);
}

async function storedPreference(clientId: string): Promise<string | null> {
  const { rows } = await testPool.query('select preferred_contact_method from clients where id = $1', [clientId]);
  return rows[0].preferred_contact_method;
}

async function seedMatterWith(lawFirmId: string, clientId: string) {
  const id = randomUUID();
  await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id, status) values ($1, $2, $3, $4, $5)',
    [id, lawFirmId, 'Contact Preference Matter', `REF-${id.slice(0, 8)}`, 'active'],
  );
  await testPool.query(
    'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
    [id, clientId, lawFirmId],
  );
  return id;
}

describe('clearing a client preferred contact method', () => {
  // Red if: the update schema refuses null for this field.
  it('stores null when the update sends null', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Pref Holder' });
    await seedPreference(client.id, 'phone');

    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${client.id}`)
      .send({ name: 'Pref Holder', preferredContactMethod: null });

    expect(res.status).toBe(200);
    expect(await storedPreference(client.id)).toBeNull();
  });

  // Red if: accepting null also made an omitted field wipe the stored value.
  it('keeps the stored preference when the update leaves the field out', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Pref Holder' });
    await seedPreference(client.id, 'sms');

    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${client.id}`)
      .send({ name: 'Renamed Holder' });

    expect(res.status).toBe(200);
    expect(await storedPreference(client.id)).toBe('sms');
  });

  // Red if: the matter client read substitutes 'email' for a cleared preference.
  it('reads a cleared preference back as null on the matter client list', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const cleared = await createPersonClient(firm.id, { name: 'Cleared Pref' });
    const matterId = await seedMatterWith(firm.id, cleared.id);
    await seedPreference(cleared.id, 'phone');

    const update = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${cleared.id}`)
      .send({ preferredContactMethod: null });
    expect(update.status).toBe(200);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters/${matterId}/clients`);
    expect(res.status).toBe(200);
    const row = res.body.clients.find((c: { id: string }) => c.id === cleared.id);
    expect(row).toBeDefined();
    expect(row.preferredContactMethod).toBeNull();
  });

  // Red if: the read dropped a stored preference while handling null.
  it('still reads a stored preference on the matter client list', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Phone Pref' });
    const matterId = await seedMatterWith(firm.id, client.id);
    await seedPreference(client.id, 'phone');

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters/${matterId}/clients`);
    expect(res.status).toBe(200);
    const row = res.body.clients.find((c: { id: string }) => c.id === client.id);
    expect(row.preferredContactMethod).toBe('phone');
  });
});

/**
 * Creating a client with "None" chosen. The create forms send null for None;
 * an API caller that leaves the field out still gets the 'email' default.
 */
describe('creating a client with no preferred contact method', () => {
  async function storedPreferenceByName(lawFirmId: string, name: string): Promise<string | null> {
    const { rows } = await testPool.query(
      'select preferred_contact_method from clients where law_firm_id = $1 and name = $2', [lawFirmId, name],
    );
    expect(rows).toHaveLength(1);
    return rows[0].preferred_contact_method;
  }

  // Red if: the create route refuses null, or the service turns it into 'email'.
  it('stores null when the client create sends null', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'No Pref Client', preferredContactMethod: null });

    expect(res.status).toBe(201);
    expect(await storedPreference(res.body.clientId)).toBeNull();
  });

  it('still defaults to email when the client create leaves the field out', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/clients`).send({ name: 'Default Pref Client' });

    expect(res.status).toBe(201);
    expect(await storedPreference(res.body.clientId)).toBe('email');
  });

  it('stores the method chosen on create', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/clients`)
      .send({ name: 'Phone Pref Client', preferredContactMethod: 'phone' });

    expect(res.status).toBe(201);
    expect(await storedPreference(res.body.clientId)).toBe('phone');
  });

  // Red if: adding a new client from a matter turns None into 'email'.
  it('stores null when a new client added to a matter sends null', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const anchor = await createPersonClient(firm.id, { name: 'Anchor Client' });
    const matterId = await seedMatterWith(firm.id, anchor.id);
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at) values ($1, $2, $3, 'lead', now())`,
      [firm.id, matterId, owner.uid],
    );

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/clients`)
      .send({ client: { name: 'Matter No Pref', preferredContactMethod: null } });

    expect(res.status).toBeLessThan(300);
    expect(await storedPreferenceByName(firm.id, 'Matter No Pref')).toBeNull();
  });

  it('still defaults to email when a new matter client leaves the field out', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const anchor = await createPersonClient(firm.id, { name: 'Anchor Client' });
    const matterId = await seedMatterWith(firm.id, anchor.id);
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at) values ($1, $2, $3, 'lead', now())`,
      [firm.id, matterId, owner.uid],
    );

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/clients`)
      .send({ client: { name: 'Matter Default Pref' } });

    expect(res.status).toBeLessThan(300);
    expect(await storedPreferenceByName(firm.id, 'Matter Default Pref')).toBe('email');
  });
});
