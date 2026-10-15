/**
 * Contacts are firm-wide, but their links identify confidential matters. The
 * contact detail and matter-narrowing picker paths must apply the same matter
 * read boundary as the canonical matter-contacts route.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let outsider: Actor;
let contactId: string;
let matterId: string;

const D = (suffix = '') => `/api/lawfirms/${firm.id}/contacts${suffix}`;
const MC = () => `/api/lawfirms/${firm.id}/matters/${matterId}/contacts`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  outsider = await memberWith(firm.id, []);

  const contact = await owner.api.post(D()).send({
    name: 'Confidential matter counsel', category: 'opposing_counsel',
  });
  expect(contact.status).toBe(201);
  contactId = contact.body.contactId;

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Matter Blackbird',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;

  const link = await owner.api.post(MC()).send({
    contactId, role: 'opposing_counsel', notes: 'Settlement authority is restricted',
  });
  expect(link.status).toBe(201);
});

describe('contact-to-matter visibility', () => {
  it('keeps linked matter details out of the firm-wide contact detail for a non-member', async () => {
    const ownerView = await owner.api.get(D(`/${contactId}`));
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.matters).toHaveLength(1);
    expect(ownerView.body.matters[0]).toMatchObject({
      matterId, matterName: 'Matter Blackbird', notes: 'Settlement authority is restricted',
    });

    const outsiderView = await outsider.api.get(D(`/${contactId}`));
    expect(outsiderView.status).toBe(200);
    expect(outsiderView.body.contact.name).toBe('Confidential matter counsel');
    expect(outsiderView.body.contact.matterCount).toBe(0);
    expect(outsiderView.body.matters).toEqual([]);
    expect(JSON.stringify(outsiderView.body)).not.toContain('Matter Blackbird');
    expect(JSON.stringify(outsiderView.body)).not.toContain('Settlement authority is restricted');
  });

  it('requires matter read access before a contact list or picker can use that matter as a filter', async () => {
    const ownerList = await owner.api.get(`${D()}?matterId=${matterId}`);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.contacts.map((contact: any) => contact.id)).toEqual([contactId]);

    const ownerLookup = await owner.api.get(`${D('/lookup')}?excludeMatterId=${matterId}`);
    expect(ownerLookup.status).toBe(200);
    expect(ownerLookup.body.items).toEqual([]);

    const outsiderList = await outsider.api.get(`${D()}?matterId=${matterId}`);
    expect(outsiderList.status).toBe(403);
    expect(JSON.stringify(outsiderList.body)).not.toContain('Confidential matter counsel');

    const outsiderLookup = await outsider.api.get(`${D('/lookup')}?excludeMatterId=${matterId}`);
    expect(outsiderLookup.status).toBe(403);
    expect(JSON.stringify(outsiderLookup.body)).not.toContain('Confidential matter counsel');
  });
});

export {};
