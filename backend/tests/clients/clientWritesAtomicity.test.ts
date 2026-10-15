import { getTableName } from 'drizzle-orm';
import { createFirm, ownerOf, createPersonClient, testPool, sentEmails } from '../support/setupInProcess';
import { seedMatter } from '../support/matters';
import { randomUUID } from 'crypto';

const repo = require('../../src/modules/clients/clients.repository');
const writes = require('../../src/shared/database/scopedWrite');
const invites = require('../../src/modules/invitations/invitations.repository');

it('returns the committed client and publishes its event even if invitation delivery bookkeeping fails', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const email = `delivery-${firm.id}@example.test`;
  const eventBus = require('../../src/shared/events/eventBus');
  const { CLIENT_CREATED } = require('../../src/shared/events/eventTypes');
  const emitted = jest.spyOn(eventBus, 'emit');
  const original = invites.markSent;
  let written = false;
  const fault = jest.spyOn(invites, 'markSent').mockImplementation(async (...args: any[]) => {
    await original.apply(invites, args);
    written = true;
    throw new Error('Injected delivery bookkeeping failure');
  });
  try {
    const response = await owner.api.post(`/api/lawfirms/${firm.id}/clients`).send({ name: 'Client', email, portalInvitePending: true });
    expect(response.status).toBe(201);
    expect(written).toBe(true);
    const { rows } = await testPool.query('select id from clients where law_firm_id = $1', [firm.id]);
    expect(rows).toEqual([{ id: response.body.clientId }]);
    expect(emitted).toHaveBeenCalledWith(CLIENT_CREATED, expect.objectContaining({ clientId: response.body.clientId }));
    expect(sentEmails().filter(mail => (Array.isArray(mail.to) ? mail.to : [mail.to]).includes(email))).toHaveLength(1);
  } finally {
    fault.mockRestore();
    emitted.mockRestore();
  }
});

it('rolls back invitation preparation if resolving its canonical client fails', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const uid = `client-${randomUUID()}`;
  const email = `${uid}@example.test`;
  await testPool.query("insert into users (id, email, name, user_type) values ($1, $2, 'Registered', 'client')", [uid, email]);
  const original = invites.findClientByEmail;
  let resolved = false;
  const fault = jest.spyOn(invites, 'findClientByEmail').mockImplementation(async (...args: any[]) => {
    const result = await original.apply(invites, args);
    if (result?.user_id === uid) {
      resolved = true;
      throw new Error('Injected canonical client lookup failure');
    }
    return result;
  });
  try {
    const response = await owner.api.post(`/api/lawfirms/${firm.id}/clients`).send({ name: 'Client', email, portalInvitePending: true });
    expect(response.status).toBe(201);
    expect(resolved).toBe(true);
    expect(response.body.portalStatus).toBe('invite_failed');
    const { rows } = await testPool.query('select id, user_id from clients where law_firm_id = $1', [firm.id]);
    expect(rows).toEqual([{ id: response.body.clientId, user_id: null }]);
    expect(sentEmails().filter(mail => (Array.isArray(mail.to) ? mail.to : [mail.to]).includes(email))).toEqual([]);
  } finally {
    fault.mockRestore();
  }
});

it('rejects a direct portal invitation for an organization without creating or linking a person', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const email = `org-${firm.id}@example.test`;
  const response = await owner.api.post(`/api/lawfirms/${firm.id}/clients`).send({ name: 'Organization', clientType: 'company', email, portalInvitePending: true });
  expect(response.status).toBe(400);
  const { rows } = await testPool.query('select id from clients where law_firm_id = $1', [firm.id]);
  expect(rows).toEqual([]);
  const { rows: invitations } = await testPool.query('select id from invitations where law_firm_id = $1', [firm.id]);
  expect(invitations).toEqual([]);
  expect(sentEmails().filter(mail => (Array.isArray(mail.to) ? mail.to : [mail.to]).includes(email))).toEqual([]);
});

it.each([false, true])('commits one client with its matter and sends its portal invitation (existing account: %s)', async (existingAccount) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const uid = `client-${randomUUID()}`;
  const email = `${uid}@example.test`;
  if (existingAccount) {
    await testPool.query("insert into users (id, email, name, user_type) values ($1, $2, 'Registered Client', 'client')", [uid, email]);
  }
  const matterId = await seedMatter(firm.id, { memberUids: [owner.uid] });
  const response = await owner.api.post(`/api/lawfirms/${firm.id}/clients`)
    .send({ name: 'Invited Client', email, portalInvitePending: true, matterIds: [matterId] });
  expect(response.status).toBe(201);
  expect(response.body.portalStatus).toBe(existingAccount ? 'added' : 'invited');
  const { rows } = await testPool.query(
    'select c.id, c.user_id, mc.matter_id from clients c left join matter_clients mc on mc.client_id = c.id where c.law_firm_id = $1',
    [firm.id],
  );
  expect(rows).toEqual([{ id: response.body.clientId, user_id: existingAccount ? uid : null, matter_id: matterId }]);
  expect(sentEmails().filter((mail) => (Array.isArray(mail.to) ? mail.to : [mail.to]).includes(email))).toHaveLength(1);
});

it.each([false, true])('rolls back client creation and any portal invitation if saving its matter links fails (invite: %s)', async (portalInvitePending) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const matterId = await seedMatter(firm.id, { memberUids: [owner.uid] });
  const original = repo.linkMattersTxn;
  let linked = false;
  const fault = jest.spyOn(repo, 'linkMattersTxn').mockImplementation(async (...args: any[]) => {
    await original.apply(repo, args);
    linked = true;
    throw new Error('Injected failure after matter links');
  });
  try {
    const email = `invite-${firm.id}@example.test`;
    const response = await owner.api.post(`/api/lawfirms/${firm.id}/clients`).send({ name: 'New Client', email, portalInvitePending, matterIds: [matterId] });
    expect(response.status).toBe(500);
    expect(linked).toBe(true);
    const { rows: clients } = await testPool.query('select id from clients where law_firm_id = $1', [firm.id]);
    const { rows: links } = await testPool.query('select client_id from matter_clients where law_firm_id = $1', [firm.id]);
    expect(clients).toEqual([]);
    expect(links).toEqual([]);
    const { rows: invites } = await testPool.query('select id from invitations where law_firm_id = $1', [firm.id]);
    expect(invites).toEqual([]);
    expect(sentEmails().filter((mail) => (Array.isArray(mail.to) ? mail.to : [mail.to]).includes(email))).toEqual([]);
  } finally {
    fault.mockRestore();
  }
});

it('rolls back directory edits if updating the person contact relationship fails', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const path = `/api/lawfirms/${firm.id}/clients/${client.id}/contacts`;
  const created = await owner.api.post(path).send({ name: 'Original', relationship: 'Spouse' });
  expect(created.status).toBe(201);
  const original = writes.scopedUpdate;
  let updated = false;
  const fault = jest.spyOn(writes, 'scopedUpdate').mockImplementation(async (...args: any[]) => {
    const result = await original.apply(writes, args);
    if (getTableName(args[0]) === 'contact_clients') {
      updated = true;
      throw new Error('Injected failure after relationship update');
    }
    return result;
  });
  try {
    const response = await owner.api.put(`${path}/${created.body.linkId}`).send({ name: 'Changed', relationship: 'Guardian' });
    expect(response.status).toBe(500);
    expect(updated).toBe(true);
    const { rows } = await testPool.query(
      'select c.name, cc.relationship from contacts c join contact_clients cc on cc.contact_id = c.id where cc.id = $1',
      [created.body.linkId],
    );
    expect(rows).toEqual([{ name: 'Original', relationship: 'Spouse' }]);
  } finally {
    fault.mockRestore();
  }
});
