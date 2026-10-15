/**
 * The leads module, characterised at the route layer.
 *
 * 1,776 lines and seven routes with no test behind them until now. The
 * interesting part is conversion: a lead becomes a client, and optionally a
 * matter, and commit bb93b9d6 changed it to REUSE an existing organization by
 * normalized name instead of inserting a duplicate. Duplicate organizations are
 * expensive to unpick afterwards, because roster links, invoices and matters
 * scatter across both copies.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createOrgClient,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const path = (suffix = '') => `/api/lawfirms/${firm.id}/leads${suffix}`;

async function createLead(overrides: Record<string, unknown> = {}) {
  const res = await owner.api.post(path()).send({
    name: 'Prospective Client',
    email: 'prospect@example.test',
    phone: '555-0100',
    ...overrides,
  });
  return res;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('creating and reading a lead', () => {
  it('creates one and returns it in the list', async () => {
    const created = await createLead({ name: 'Jane Prospect' });

    expect(created.status).toBe(201);

    const list = await owner.api.get(path());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Jane Prospect');
  });

  it('rejects a lead with no name', async () => {
    const res = await owner.api.post(path()).send({ email: 'nameless@example.test' });

    expect(res.status).toBe(400);
  });

  it('rejects a malformed email rather than storing it', async () => {
    const res = await createLead({ email: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('rejects an empty string email rather than treating it as absent', async () => {
    // `z.string().email()` runs before `.nullable()`/`.optional()` kick in, so an
    // empty string is neither "missing" nor "cleared" -- it is a malformed email.
    const res = await createLead({ email: '' });

    expect(res.status).toBe(400);
  });

  it('accepts an explicit null email and stores nothing', async () => {
    // The counterpart to the empty-string case: null is the real "no email"
    // value, distinct from an empty string that failed validation above.
    const created = await createLead({ email: null });
    expect(created.status).toBe(201);

    const leadId = created.body.lead?.id ?? created.body.leadId;
    const { rows } = await testPool.query('select email from leads where id = $1', [leadId]);
    expect(rows[0].email).toBeNull();
  });

  it('rejects a malformed stageId', async () => {
    const res = await createLead({ stageId: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });

  it('reads one back by id', async () => {
    const created = await createLead({ name: 'Readable Lead' });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    const res = await owner.api.get(path(`/${leadId}`));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Readable Lead');
  });

  it('answers 404 for a lead that does not exist', async () => {
    const res = await owner.api.get(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });
});

describe('updating and deleting', () => {
  async function aLead() {
    const created = await createLead();
    return (created.body.lead?.id ?? created.body.leadId) as string;
  }

  it('updates a field', async () => {
    const leadId = await aLead();

    const res = await owner.api.put(path(`/${leadId}`)).send({ name: 'Renamed Lead' });
    expect(res.status).toBe(200);

    const read = await owner.api.get(path(`/${leadId}`));
    expect(JSON.stringify(read.body)).toContain('Renamed Lead');
  });

  it('deletes one', async () => {
    const leadId = await aLead();

    const res = await owner.api.delete(path(`/${leadId}`));
    expect([200, 204]).toContain(res.status);

    const read = await owner.api.get(path(`/${leadId}`));
    expect(read.status).toBe(404);
  });

  it('rejects a disqualifyReason over 1000 characters', async () => {
    const leadId = await aLead();

    const res = await owner.api.put(path(`/${leadId}`)).send({ disqualifyReason: 'x'.repeat(1001) });

    expect(res.status).toBe(400);
  });

  it('ignores an assignedTo-shaped field on create or update: leads have no assignee', async () => {
    // There is no lead assignment feature anywhere in the product: no schema
    // column, no validation field, no UI to set one. A caller who sends one of
    // these keys anyway (an old client build, a hand-crafted request) must not
    // be able to trigger a notification that promises a capability the app
    // does not have.
    const colleague = await memberWith(firm.id, ['leads.view']);

    const created = await createLead({
      name: 'Has an assignee-shaped field',
      assignedTo: colleague.uid,
      assigneeUserId: colleague.uid,
      assignedUserId: colleague.uid,
    });
    expect(created.status).toBe(201);
    await drainEvents();

    const leadId = (created.body.lead?.id ?? created.body.leadId) as string;
    const updated = await owner.api.put(path(`/${leadId}`)).send({
      assignedTo: colleague.uid,
      assigneeUserId: colleague.uid,
      assignedUserId: colleague.uid,
    });
    expect(updated.status).toBe(200);
    await drainEvents();

    const { rows } = await testPool.query(
      `select 1 from notifications where law_firm_id = $1 and type = 'lead_assigned'`,
      [firm.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('converting a lead to a client', () => {
  it('creates a person client from the lead', async () => {
    const created = await createLead({ name: 'Converting Person' });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    // `createMatter: false` is required to convert the client ALONE. The schema
    // defaults to also opening a matter, and then demands a matter `name`, so a
    // bare `{ clientType }` is refused with "Matter name is required".
    const res = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'person', createMatter: false });
    expect([200, 201]).toContain(res.status);
    await drainEvents();

    const { rows } = await testPool.query(
      `select name, client_type from clients where law_firm_id = $1 and client_type = 'person'`,
      [firm.id],
    );
    expect(rows.map((r: any) => r.name)).toContain('Converting Person');
  });

  it('REUSES an existing organization instead of creating a duplicate', async () => {
    // The bb93b9d6 behaviour. A second Acme Corporation row would scatter roster
    // links, invoices and matters across two records that look identical in the
    // client list.
    const existing = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    const created = await createLead({ name: 'Acme Contact', organization: 'Acme Corporation' });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    const res = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'company', createMatter: false });
    expect([200, 201]).toContain(res.status);
    await drainEvents();

    const { rows } = await testPool.query(
      `select id, name from clients where law_firm_id = $1 and client_type = 'company'`,
      [firm.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existing.id);
  });

  it('matches regardless of case and surrounding whitespace', async () => {
    const existing = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    const created = await createLead({
      name: 'Acme Contact', organization: '  acme corporation  ',
    });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    const converted = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'company', createMatter: false });
    // Asserted BEFORE the row check. Without it this case passed while
    // conversion was failing with 400: only the pre-created organization
    // existed, so "exactly one company" was true for the wrong reason.
    expect([200, 201]).toContain(converted.status);
    await drainEvents();

    const { rows } = await testPool.query(
      `select id from clients where law_firm_id = $1 and client_type = 'company'`,
      [firm.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existing.id);
  });

  it('does NOT match when the internal spacing differs, so a duplicate is created', async () => {
    // CHARACTERISED, NOT ENDORSED. Matching is `lower(btrim(name))`, which
    // handles case and the ends of the string but not runs of whitespace inside
    // it, so "Acme  Corporation" with a double space becomes a second company.
    //
    // Not fixed here, because the fix is larger than it looks: collapsing
    // internal whitespace means `regexp_replace(...)` on both sides, and the
    // current expression is what backs `clients_firm_lower_org_idx`, the index
    // the conflict-of-interest check also relies on. Changing the expression
    // without adding a matching index turns a fast lookup into a scan.
    //
    // This test exists so the gap is visible and so a future fix has something
    // to flip.
    await createOrgClient(firm.id, { name: 'Acme Corporation' });
    const created = await createLead({
      name: 'Acme Contact', organization: 'Acme  Corporation',
    });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    const converted = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'company', createMatter: false });
    expect([200, 201]).toContain(converted.status);
    await drainEvents();

    const { rows } = await testPool.query(
      `select id from clients where law_firm_id = $1 and client_type = 'company'`,
      [firm.id],
    );
    expect(rows).toHaveLength(2);
  });

  it('does not reuse an organization belonging to another firm', async () => {
    const otherFirm = await createFirm();
    await createOrgClient(otherFirm.id, { name: 'Acme Corporation' });
    const created = await createLead({ name: 'Acme Contact', organization: 'Acme Corporation' });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    const converted = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'company', createMatter: false });
    expect([200, 201]).toContain(converted.status);
    await drainEvents();

    // Reuse is scoped to the firm. Matching across firms would link a client
    // record to a company another firm owns.
    const { rows } = await testPool.query(
      `select law_firm_id from clients where client_type = 'company' and law_firm_id = $1`,
      [firm.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('opens the matter for a newly created organization when converting as a company', async () => {
    const created = await createLead({ name: 'Corporate Prospect', organization: 'Acme Logistics LLC' });
    const leadId = created.body.lead.id;

    const res = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'company', createMatter: true, name: 'Acme Contract Dispute' });
    expect(res.status).toBe(200);
    await drainEvents();

    // The organization is created inline with the matter, named from the
    // lead's organization field rather than the contact's own name.
    const { rows } = await testPool.query(
      `select m.name as matter_name, c.name as client_name, c.client_type
         from matters m
         join matter_clients mc on mc.law_firm_id = m.law_firm_id and mc.matter_id = m.id
         join clients c on c.id = mc.client_id
        where m.id = $1`,
      [res.body.matterId],
    );
    expect(rows).toEqual([
      { matter_name: 'Acme Contract Dispute', client_name: 'Acme Logistics LLC', client_type: 'company' },
    ]);
    const lead = await testPool.query(
      'select converted_matter_id, converted_client_id from leads where id = $1', [leadId],
    );
    expect(lead.rows[0]).toEqual({ converted_matter_id: res.body.matterId, converted_client_id: res.body.clientId });
  });

  it('stores a blank roster-contact phone as null, and trims a real one, when converting as a company with a matter', async () => {
    // The lead's own name/email/phone become the organization's first roster
    // person. A whitespace phone stored verbatim is a value that is not empty,
    // so every surface that checks "has a phone" shows a blank one, and a
    // padded number fails an exact match.
    const blank = await createLead({ name: 'Blank Phone', email: 'blank@example.test', organization: 'Blank Phone LLC' });
    const padded = await createLead({ name: 'Padded Phone', email: 'padded@example.test', organization: 'Padded Phone LLC' });
    // Written straight to the row: whatever the create route does to a phone,
    // conversion must not trust that the stored value is already clean.
    await testPool.query('update leads set phone = $2 where id = $1', [blank.body.lead.id, '   ']);
    await testPool.query('update leads set phone = $2 where id = $1', [padded.body.lead.id, '  555-0199  ']);

    for (const [lead, matterName] of [[blank, 'Blank Phone Matter'], [padded, 'Padded Phone Matter']] as const) {
      // eslint-disable-next-line no-await-in-loop -- conversions are sequential on purpose
      const res = await owner.api.post(path(`/${lead.body.lead.id}/convert`))
        .send({ clientType: 'company', createMatter: true, name: matterName });
      expect(res.status).toBe(200);
    }
    await drainEvents();

    const { rows } = await testPool.query(
      `select p.name, p.phone, co.name as company
         from client_company_links l
         join clients p on p.id = l.person_client_id
         join clients co on co.id = l.company_client_id
        where l.law_firm_id = $1
        order by p.name`,
      [firm.id],
    );
    expect(rows).toEqual([
      { name: 'Blank Phone', phone: null, company: 'Blank Phone LLC' },
      { name: 'Padded Phone', phone: '555-0199', company: 'Padded Phone LLC' },
    ]);
  });

  describe('choosing the organization at conversion', () => {
    /** The firm's organizations and the people on each roster, by name. */
    async function organizations() {
      const { rows } = await testPool.query(
        `select co.id, co.name, coalesce(array_agg(p.name order by p.name) filter (where p.id is not null), '{}') as roster
           from clients co
           left join client_company_links l on l.law_firm_id = co.law_firm_id and l.company_client_id = co.id
           left join clients p on p.id = l.person_client_id
          where co.law_firm_id = $1 and co.client_type = 'company'
          group by co.id, co.name
          order by co.name`,
        [firm.id],
      );
      return rows;
    }

    it('converts a lead with no organization into an existing one picked by id, with a matter', async () => {
      // Red before the picker existed: a lead with a blank organization could
      // not be converted as a company at all.
      const org = await createOrgClient(firm.id, { name: 'Northwind Traders' });
      const created = await createLead({ name: 'Sameera Joshi', email: 'sameera@example.test' });
      const leadId = created.body.lead.id;

      const res = await owner.api.post(path(`/${leadId}/convert`)).send({
        clientType: 'company', organizationClientId: org.id, createMatter: true, name: 'Northwind Lease',
      });
      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe(org.id);
      await drainEvents();

      const { rows: linked } = await testPool.query(
        `select client_id from matter_clients where law_firm_id = $1 and matter_id = $2`,
        [firm.id, res.body.matterId],
      );
      expect(linked).toEqual([{ client_id: org.id }]);
      expect(await organizations()).toEqual([{ id: org.id, name: 'Northwind Traders', roster: ['Sameera Joshi'] }]);
    });

    it('converts into a picked organization without a matter, adding the lead to its roster once', async () => {
      const org = await createOrgClient(firm.id, { name: 'Northwind Traders' });
      const first = await createLead({ name: 'Sameera Joshi', email: 'sameera@example.test', organization: 'Some Other Co' });
      const res = await owner.api.post(path(`/${first.body.lead.id}/convert`)).send({
        clientType: 'company', organizationClientId: org.id, createMatter: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe(org.id);

      // The same person arriving again as a second lead is not added twice.
      const second = await createLead({ name: 'Sameera Joshi', email: 'SAMEERA@example.test' });
      const again = await owner.api.post(path(`/${second.body.lead.id}/convert`)).send({
        clientType: 'company', organizationClientId: org.id, createMatter: false,
      });
      expect(again.status).toBe(200);
      await drainEvents();

      // The picked organization wins over the lead's own text, so no
      // "Some Other Co" is created.
      expect(await organizations()).toEqual([{ id: org.id, name: 'Northwind Traders', roster: ['Sameera Joshi'] }]);
      const lead = await testPool.query('select converted_client_id from leads where id = $1', [first.body.lead.id]);
      expect(lead.rows[0].converted_client_id).toBe(org.id);
    });

    it('creates a new organization from a typed name when the lead has none', async () => {
      const created = await createLead({ name: 'Sameera Joshi', email: 'sameera@example.test' });
      const res = await owner.api.post(path(`/${created.body.lead.id}/convert`)).send({
        clientType: 'company', organizationName: '  Joshi Holdings  ', createMatter: false,
      });
      expect(res.status).toBe(200);
      await drainEvents();

      expect(await organizations()).toEqual([
        { id: res.body.clientId, name: 'Joshi Holdings', roster: ['Sameera Joshi'] },
      ]);
    });

    it('reuses an existing organization when the typed name matches it', async () => {
      const org = await createOrgClient(firm.id, { name: 'Northwind Traders' });
      const created = await createLead({ name: 'Sameera Joshi', email: 'sameera@example.test' });
      const res = await owner.api.post(path(`/${created.body.lead.id}/convert`)).send({
        clientType: 'company', organizationName: 'northwind traders', createMatter: true, name: 'Northwind Lease',
      });
      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe(org.id);
      await drainEvents();
      expect(await organizations()).toEqual([{ id: org.id, name: 'Northwind Traders', roster: ['Sameera Joshi'] }]);
    });

    it.each([
      ['another firm\'s organization', async () => (await createOrgClient((await createFirm()).id, { name: 'Rival Co' })).id],
      ['a person client', async () => (await createPersonClient(firm.id, { name: 'Not An Org' })).id],
      ['an id that does not exist', async () => '00000000-0000-4000-8000-000000000000'],
    ])('refuses %s as the organization, converting nothing', async (_label, pick) => {
      const organizationClientId = await pick();
      const created = await createLead({ name: 'Sameera Joshi', email: 'sameera@example.test' });

      const res = await owner.api.post(path(`/${created.body.lead.id}/convert`)).send({
        clientType: 'company', organizationClientId, createMatter: true, name: 'Should Not Exist',
      });
      expect(res.status).toBe(400);
      await drainEvents();

      const lead = await testPool.query('select converted_at, converted_client_id from leads where id = $1', [created.body.lead.id]);
      expect(lead.rows[0]).toEqual({ converted_at: null, converted_client_id: null });
      const matters = await testPool.query(`select id from matters where law_firm_id = $1 and name = 'Should Not Exist'`, [firm.id]);
      expect(matters.rows).toEqual([]);
    });

    it('still refuses an organization conversion with no name and nothing picked', async () => {
      const created = await createLead({ name: 'Sameera Joshi' });
      const res = await owner.api.post(path(`/${created.body.lead.id}/convert`)).send({
        clientType: 'company', organizationName: '   ', createMatter: false,
      });
      expect(res.status).toBe(400);
      expect(await organizations()).toEqual([]);
    });
  });

  it('refuses to convert a lead a second time, creating no second client', async () => {
    const created = await createLead({ name: 'Converted Once' });
    const leadId = created.body.lead.id;
    const first = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'person', createMatter: false });
    expect(first.status).toBe(200);
    await drainEvents();

    const second = await owner.api.post(path(`/${leadId}/convert`))
      .send({ clientType: 'person', createMatter: false });

    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already converted/i);
    const { rows } = await testPool.query(
      'select count(*)::int as n from clients where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses a bare conversion with no createMatter and no matter name', async () => {
    // Documented in the comment above (a bare `{ clientType }` is refused with
    // "Matter name is required") but never actually exercised: the schema
    // defaults `createMatter` to true when it is omitted, and that path then
    // demands a matter `name`.
    const created = await createLead({ name: 'Needs A Matter Name' });
    const leadId = created.body.lead?.id ?? created.body.leadId;

    const res = await owner.api.post(path(`/${leadId}/convert`)).send({ clientType: 'person' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Matter name is required/i);
  });
});

describe('permissions and tenancy', () => {
  it('refuses a member without the lead permission to create one', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path()).send({ name: 'Should not exist' });

    // `leads.view` is in the always-on baseline; creating is not.
    expect(res.status).toBe(403);
  });

  it('lets a member holding the code create one', async () => {
    const writer = await memberWith(firm.id, ['leads.manage', 'leads.create']);

    const res = await writer.api.post(path()).send({ name: 'Allowed Lead' });

    // Paired with the refusal above, so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBeLessThan(400);
  });

  it('does not show one firm another firm leads', async () => {
    await createLead({ name: 'Confidential Prospect' });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/leads`);

    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential Prospect');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(path());

    expect([403, 404]).toContain(res.status);
  });
});

/**
 * B02.2 A13: `listLeadsPaged` matches `search` across name, email and
 * organization through a UNION-of-ids subquery (`leads.repository.ts`), each arm
 * carrying its own `law_firm_id = $lawFirmId` predicate independently of the
 * `scope` the outer `tenantQuery` also applies. Two predicates guarding one read
 * is reassuring but untested: nothing before this proved a search term that
 * matches a row in BOTH firms still returns only the caller's own row, and
 * nothing exercised the separate `count(*)` query `listLeadsPaged` issues when
 * paging kicks in. `totalItems` is only present when `limit` is supplied
 * (`leadsService.listLeads`), so every case below passes one.
 */
describe('search and count never cross a firm boundary', () => {
  let firmB: Firm;
  let ownerB: Actor;

  beforeEach(async () => {
    firmB = await createFirm();
    ownerB = await ownerOf(firmB.id);
  });

  it('matches a NAME fragment only within the caller firm, though both firms have one', async () => {
    await createLead({ name: 'Meridian Prospect' });
    await ownerB.api.post(`/api/lawfirms/${firmB.id}/leads`)
      .send({ name: 'Meridian Rival', email: 'rival@example.test' });

    const res = await owner.api.get(path()).query({ search: 'meridian', limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.leads.map((l: any) => l.name)).toEqual(['Meridian Prospect']);
    expect(res.body.totalItems).toBe(1);
  });

  it('matches an EMAIL fragment only within the caller firm', async () => {
    await createLead({ name: 'Local Lead', email: 'contact@sharedmail.test' });
    await ownerB.api.post(`/api/lawfirms/${firmB.id}/leads`)
      .send({ name: 'Foreign Lead', email: 'contact@sharedmail.test' });

    const res = await owner.api.get(path()).query({ search: 'sharedmail', limit: 10 });

    expect(res.body.leads.map((l: any) => l.name)).toEqual(['Local Lead']);
    expect(res.body.totalItems).toBe(1);
  });

  it('matches an ORGANIZATION fragment only within the caller firm', async () => {
    await createLead({ name: 'Org Lead Local', organization: 'Meridian Group' });
    await ownerB.api.post(`/api/lawfirms/${firmB.id}/leads`)
      .send({ name: 'Org Lead Foreign', email: 'foreign@example.test', organization: 'Meridian Group' });

    const res = await owner.api.get(path()).query({ search: 'meridian', limit: 10 });

    expect(res.body.leads.map((l: any) => l.name)).toEqual(['Org Lead Local']);
    expect(res.body.totalItems).toBe(1);
  });

  it('keeps the paged count scoped to the caller firm with a colliding term and a narrow page', async () => {
    await createLead({ name: 'Meridian One' });
    await createLead({ name: 'Meridian Two' });
    await ownerB.api.post(`/api/lawfirms/${firmB.id}/leads`).send({ name: 'Meridian Rival One' });
    await ownerB.api.post(`/api/lawfirms/${firmB.id}/leads`).send({ name: 'Meridian Rival Two' });
    await ownerB.api.post(`/api/lawfirms/${firmB.id}/leads`).send({ name: 'Meridian Rival Three' });

    // limit=1 forces `listLeadsPaged` down its separate count(*) path, which
    // rebuilds the same `and(scope, ...filters)` predicate independently of the
    // page query. Mutation-tested by dropping `scope` from each path in turn:
    // the audited query context (`tenantQuery`) refuses to run a query whose
    // compiled SQL lost its tenant predicate and throws rather than silently
    // returning the wrong count, which this case still catches as a 500 where
    // it expects 200.
    const res = await owner.api.get(path()).query({ search: 'meridian', limit: 1 });

    expect(res.body.leads.length).toBe(1);
    expect(res.body.totalItems).toBe(2);
  });
});
