import { getTableName } from 'drizzle-orm';
import { createFirm, ownerOf, createPersonClient, testPool, drainEvents } from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

const linksRepo = require('../../src/modules/matters/contacts/matterContacts.repository');
const contactsRepo = require('../../src/modules/contacts/contacts.repository');
const writes = require('../../src/shared/database/scopedWrite');
const eventBus = require('../../src/shared/events/eventBus');
const { CONTACT_CREATED } = require('../../src/shared/events/eventTypes');

it.each(['matter', 'client'])('rolls back a new directory contact if its %s link fails', async (parent) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const matterId = await seedMatter(firm.id, { memberUids: [owner.uid] });
  const client = await createPersonClient(firm.id);
  const original = parent === 'matter' ? linksRepo.linkContact : writes.scopedInsert;
  let linked = false;
  const created = jest.fn();
  eventBus.on(CONTACT_CREATED, created);
  const fault = parent === 'matter'
    ? jest.spyOn(linksRepo, 'linkContact').mockImplementation(async (...args: any[]) => {
      await original.apply(linksRepo, args);
      linked = true;
      throw new Error('Injected matter link failure');
    })
    : jest.spyOn(writes, 'scopedInsert').mockImplementation(async (...args: any[]) => {
      const result = await original.apply(writes, args);
      if (getTableName(args[0]) === 'contact_clients') {
        linked = true;
        throw new Error('Injected client link failure');
      }
      return result;
    });
  try {
    const path = parent === 'matter'
      ? `/api/lawfirms/${firm.id}/matters/${matterId}/contacts`
      : `/api/lawfirms/${firm.id}/clients/${client.id}/contacts`;
    const response = await owner.api.post(path).send({ name: 'New Contact', role: 'other', isPrimary: true });
    expect(response.status).toBe(500);
    expect(linked).toBe(true);
    await drainEvents();
    for (const table of ['contacts', 'matter_contacts', 'contact_clients']) {
      const { rows } = await testPool.query(`select id from ${table} where law_firm_id = $1`, [firm.id]);
      expect({ table, rows }).toEqual({ table, rows: [] });
    }
    expect(created).not.toHaveBeenCalled();
  } finally {
    fault.mockRestore();
    eventBus.off(CONTACT_CREATED, created);
  }
});

it('restores a one-time contact and its matter link if deleting the directory record fails', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const matterId = await seedMatter(firm.id, { memberUids: [owner.uid] });
  const path = `/api/lawfirms/${firm.id}/matters/${matterId}/contacts`;
  const created = await owner.api.post(path).send({ name: 'One-time Contact', role: 'other', oneTime: true });
  expect(created.status).toBe(201);
  const linkId = created.body.contact.id;
  const contactId = created.body.contact.contactId;
  const original = contactsRepo.deleteContact;
  let deleted = false;
  const fault = jest.spyOn(contactsRepo, 'deleteContact').mockImplementation(async (...args: any[]) => {
    await original.apply(contactsRepo, args);
    deleted = true;
    throw new Error('Injected directory delete failure');
  });
  try {
    const response = await owner.api.delete(`${path}/${linkId}`);
    expect(response.status).toBe(500);
    expect(deleted).toBe(true);
    const { rows: contacts } = await testPool.query('select id from contacts where id = $1', [contactId]);
    const { rows: links } = await testPool.query('select id from matter_contacts where id = $1', [linkId]);
    expect(contacts).toEqual([{ id: contactId }]);
    expect(links).toEqual([{ id: linkId }]);
  } finally {
    fault.mockRestore();
  }
});
