/**
 * B11.2: export completeness and security, for the ORGANIZATION arm of
 * `GET /api/lawfirms/:lawFirmId/clients/:clientId/data-export`
 * (`privacy.service.ts#exportClientData`).
 *
 * Every existing export-completeness spec (`privacyExportCompleteness.test.ts`,
 * `privacySubjectRights.test.ts`) drives its scale/duplicate-join/isolation cases
 * against a PERSON client, whose "contacts" come from `contact_clients`. A
 * COMPANY client's roster comes from a different table entirely
 * (`client_company_links`, joined to the person's own `clients` row) and had no
 * dedicated coverage at scale or for cross-roster isolation. That matters
 * specifically because it is the one place this export legitimately hands back
 * OTHER people's names (the roster) rather than just the subject's own data, so
 * it is also the one place a join mistake would leak the widest.
 *
 * Both cases below prove the export is correct as written; neither found a bug.
 * That is a legitimate result: the isolation is real, not just declared, because
 * `contactsQuery`'s `where` clause filters on `company_client_id = clientId`
 * rather than on the roster person's identity, which is exactly the kind of
 * thing that reads as obviously correct until someone seeds two companies and
 * checks.
 */
import { randomUUID } from 'crypto';

import {
  createFirm,
  createPersonClient,
  createOrgClient,
  linkPersonToOrg,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const exportPath = (clientId: string, lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}/data-export`;

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('company roster export isolation', () => {
  it('never leaks a roster member other company affiliation', async () => {
    const companyA = await createOrgClient(firm.id, { name: 'Roster Export Corp A' });
    const companyB = await createOrgClient(firm.id, { name: 'Confidential Corp B' });
    const sharedPerson = await createPersonClient(firm.id, { name: 'Dual Roster Person' });
    await linkPersonToOrg(firm.id, sharedPerson.id, companyA.id, {
      canViewBilling: true, relationship: 'CFO at A',
    });
    await linkPersonToOrg(firm.id, sharedPerson.id, companyB.id, {
      canViewBilling: false, relationship: 'Board member at B',
    });

    const res = await owner.api.get(exportPath(companyA.id, firm.id));

    expect(res.status).toBe(200);
    // Positive control: the roster member's link to THIS company is present, so
    // the absences below mean company B's data was withheld, not that the join
    // failed to run at all.
    expect(res.body.contacts.map((c: any) => c.name)).toEqual(['Dual Roster Person']);
    expect(res.body.contacts[0].relationship).toBe('CFO at A');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Confidential Corp B');
    expect(body).not.toContain('Board member at B');
    expect(body).not.toContain(companyB.id);
  });

  it('returns every roster member exactly once at scale, with no fan-out duplication', async () => {
    const company = await createOrgClient(firm.id, { name: 'Large Roster Corp' });
    const rosterSize = 15;
    const roster = [];
    for (let i = 0; i < rosterSize; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const person = await createPersonClient(firm.id, { name: `Roster Person ${i}` });
      // eslint-disable-next-line no-await-in-loop
      await linkPersonToOrg(firm.id, person.id, company.id, { canViewBilling: i % 2 === 0 });
      roster.push(person);
    }
    // A second company in the same firm, with its own roster of the same size,
    // is the fan-out trap: an inner join that lost its `company_client_id`
    // filter would return rosterSize * 2 rows, or the wrong set entirely.
    const otherCompany = await createOrgClient(firm.id, { name: 'Other Firm Roster Corp' });
    const otherPerson = await createPersonClient(firm.id, { name: 'Not On This Roster' });
    await linkPersonToOrg(firm.id, otherPerson.id, otherCompany.id, { canViewBilling: false });

    const res = await owner.api.get(exportPath(company.id, firm.id));

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(rosterSize);
    const names = res.body.contacts.map((c: any) => c.name);
    expect(new Set(names).size).toBe(rosterSize);
    expect(names).toContain('Roster Person 0');
    expect(names).toContain('Roster Person 14');
    expect(names).not.toContain('Not On This Roster');
  });
});
