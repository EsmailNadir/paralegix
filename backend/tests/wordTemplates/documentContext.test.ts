/**
 * GET /word-templates/document-context: the values a matter (and a picked
 * client) fills into a template, assembled from the firm's own records.
 *
 * Every figure here is printed into a document that leaves the firm, so the
 * spec seeds each source and asserts the exact printed value, and proves the
 * read never crosses into another firm's matter or client.
 *
 *   npx jest tests/wordTemplates/documentContext.test.ts
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createFirmMember,
  createPersonClient,
  createTrustDeposit,
  freezeClockAt,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { WT, addMatterMember, linkClient, seedCourt, seedMatter, seedMatterContact } from './helpers';

let firmA: Firm;
let firmB: Firm;
let ownerA: Actor;
let ownerB: Actor;

beforeEach(async () => {
  freezeClockAt('2026-03-04T15:00:00-05:00');
  firmA = await createFirm();
  firmB = await createFirm();
  ownerA = await ownerOf(firmA.id);
  ownerB = await ownerOf(firmB.id);
  await testPool.query(
    `update law_firms set name = 'Wayfield Defense Group', address = '100 E. Harbor View Blvd', city = 'Columbus',
       state = 'OH', zip = '43235', phone = '(614) 555-0182', email = 'office@wayfield.test',
       settings = jsonb_build_object('timezone', 'America/Chicago')
     where id = $1`,
    [firmA.id],
  );
});

const context = (actor: Actor, lawFirmId: string, query: Record<string, string>) =>
  actor.api.get(`${WT(lawFirmId)}/document-context`).query(query);

async function setClientDetails(clientId: string) {
  await testPool.query(
    `update clients set email = 'corwin@example.test', phone = '(614) 555-0100', address = '12 Elm St',
       organization = 'Thistlewood LLC', preferred_contact_method = 'email' where id = $1`,
    [clientId],
  );
}

async function seedInvoice(lawFirmId: string, matterId: string, clientId: string, fields: {
  status: string; totalCents: number; amountPaidCents?: number; createdAt?: string; dueDate?: string; downPaymentCents?: number;
}): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, status,
                           total_cents, amount_paid_cents, total_hours, invoice_date, due_date, created_at,
                           plan_down_payment_cents, is_paid)
     values ($1, $2, $3, $4, 'matter', $5, $6, $7, $8, 1.5, '2026-02-01', $9, $10, $11, $12)`,
    [id, lawFirmId, matterId, clientId, `INV-${id.slice(0, 6)}`, fields.status, fields.totalCents,
      fields.amountPaidCents ?? 0, fields.dueDate ?? '2026-03-01', fields.createdAt ?? '2026-02-01T12:00:00Z',
      fields.downPaymentCents ?? null, fields.status === 'paid'],
  );
  return id;
}

describe('access', () => {
  it('refuses a matter of another firm as not found', async () => {
    const matterB = await seedMatter(firmB.id, { name: 'Firm B matter' });
    const res = await context(ownerA, firmA.id, { matterId: matterB });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Firm B matter');
  });

  it('refuses a client of another firm as not found', async () => {
    const clientB = await createPersonClient(firmB.id, { name: 'Bartholomew Okonkwo' });
    const res = await context(ownerA, firmA.id, { clientId: clientB.id });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Okonkwo');
  });

  it('refuses a picked client of another firm even beside a firm A matter', async () => {
    const matterA = await seedMatter(firmA.id, { name: 'Matter A' });
    const clientB = await createPersonClient(firmB.id, { name: 'Bartholomew Okonkwo' });
    const res = await context(ownerA, firmA.id, { matterId: matterA, clientId: clientB.id });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Okonkwo');
  });

  it('refuses a member who is not on the matter', async () => {
    const matter = await seedMatter(firmA.id, { name: 'Walled matter' });
    const outsider = await memberWith(firmA.id, []);
    const res = await context(outsider, firmA.id, { matterId: matter });
    expect(res.status).toBe(403);
  });

  it('serves a member who is on the matter', async () => {
    const matter = await seedMatter(firmA.id, { name: 'Staffed matter' });
    const member = await memberWith(firmA.id, []);
    await addMatterMember(firmA.id, matter, member.uid);
    const res = await context(member, firmA.id, { matterId: matter });
    expect(res.status).toBe(200);
    expect(res.body.context.values.case_name).toBe('Staffed matter');
  });

  it('needs a matter or a client', async () => {
    const res = await context(ownerA, firmA.id, {});
    expect(res.status).toBe(400);
  });

  it('answers a malformed matter id as not found', async () => {
    const res = await context(ownerA, firmA.id, { matterId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('matter, client, court and firm fields', () => {
  it('fills the caption, identity, signature block and client fields', async () => {
    const lead = await createFirmMember(firmA.id, { name: 'Jordan Wayfield' });
    await testPool.query("update users set email = 'jordan@wayfield.test' where id = $1", [lead.uid]);
    const court = await seedCourt(firmA.id, { name: 'Franklin County Municipal Court', address: '375 S High St', city: 'Columbus', state: 'OH' });
    const matter = await seedMatter(firmA.id, {
      name: 'State v. Thistlewood', matterNumber: '2026 CRB 004821', courtId: court, leadUserId: lead.uid,
      description: 'OVI defense', status: 'on_hold', openDate: '2026-01-15', matterReferenceId: 'MAT-0042',
    });
    const client = await createPersonClient(firmA.id, { name: 'Corwin Thistlewood' });
    await setClientDetails(client.id);
    await linkClient(firmA.id, matter, client.id);
    await seedMatterContact(firmA.id, matter, 'judge', { name: 'Judge Amelia Grant' });
    await seedMatterContact(firmA.id, matter, 'opposing_party', { name: 'Whetstone Care Center' });
    await seedMatterContact(firmA.id, matter, 'opposing_counsel', { name: 'Dana Prosecutor', email: 'dana@city.test' });

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.status).toBe(200);
    expect(res.body.context.values).toMatchObject({
      case_name: 'State v. Thistlewood',
      case_number: '2026 CRB 004821',
      case_reference_id: 'MAT-0042',
      case_description: 'OVI defense',
      case_status: 'On Hold',
      case_open_date: 'January 15, 2026',
      court_name: 'Franklin County Municipal Court',
      court_name_caps: 'FRANKLIN COUNTY MUNICIPAL COURT',
      court_address: '375 S High St',
      court_city: 'Columbus',
      court_state: 'OH',
      judge_name: 'Amelia Grant',
      judge_name_caps: 'AMELIA GRANT',
      opposing_party: 'Whetstone Care Center',
      facility_name: 'Whetstone Care Center',
      service_recipient: 'Dana Prosecutor',
      service_recipient_email: 'dana@city.test',
      attorney_name: 'Jordan Wayfield',
      attorney_email: 'jordan@wayfield.test',
      firm_name: 'Wayfield Defense Group',
      firm_address: '100 E. Harbor View Blvd',
      firm_city_state_zip: 'Columbus, OH 43235',
      firm_full_address: '100 E. Harbor View Blvd, Columbus, OH, 43235',
      firm_phone: '(614) 555-0182',
      firm_email: 'office@wayfield.test',
      client_name: 'Corwin Thistlewood',
      client_salutation: 'Corwin',
      client_last_name: 'Thistlewood',
      client_email: 'corwin@example.test',
      client_phone: '(614) 555-0100',
      client_address: '12 Elm St',
      client_organization: 'Thistlewood LLC',
      defendant_name_caps: 'CORWIN THISTLEWOOD',
    });
    expect(res.body.context.billingIncomplete).toBe(false);
  });

  it('prints today in the firm\'s time zone, not the server\'s', async () => {
    // 2026-03-04 23:30 in Chicago is already March 5 in UTC.
    freezeClockAt('2026-03-04T23:30:00-06:00');
    const matter = await seedMatter(firmA.id, { name: 'M' });
    const res = await context(ownerA, firmA.id, { matterId: matter });
    expect(res.body.context.values).toMatchObject({
      letter_date: 'March 4, 2026',
      date: '3/4/2026',
      day: '4',
      service_date_legal: '4th day of March 2026',
    });
  });

  it('fills a picked client that is not on the matter from its own record', async () => {
    const matter = await seedMatter(firmA.id, { name: 'M' });
    const onMatter = await createPersonClient(firmA.id, { name: 'First Client' });
    await linkClient(firmA.id, matter, onMatter.id);
    const picked = await createPersonClient(firmA.id, { name: 'Picked Person' });
    const res = await context(ownerA, firmA.id, { matterId: matter, clientId: picked.id });
    expect(res.body.context.values.client_name).toBe('Picked Person');
  });

  it('fills client, firm and date fields for a client with no matter', async () => {
    const client = await createPersonClient(firmA.id, { name: 'Corwin Thistlewood' });
    const res = await context(ownerA, firmA.id, { clientId: client.id });
    expect(res.status).toBe(200);
    expect(res.body.context.values).toMatchObject({ client_name: 'Corwin Thistlewood', firm_name: 'Wayfield Defense Group' });
    expect(res.body.context.values).not.toHaveProperty('case_name');
  });

  it('merges the firm\'s custom matter fields under keys the built-ins do not use', async () => {
    const defId = randomUUID();
    await testPool.query(
      `insert into matter_field_defs (id, law_firm_id, label, field_type) values ($1, $2, 'Arrest Date', 'date')`,
      [defId, firmA.id],
    );
    const matter = await seedMatter(firmA.id, { name: 'M', customFields: { [defId]: '2026-02-10' } });
    const res = await context(ownerA, firmA.id, { matterId: matter });
    expect(res.body.context.values.arrest_date).toBe('February 10, 2026');
  });
});

describe('calendar fields', () => {
  async function seedEvent(matterId: string, type: string, title: string, date: string, status = 'upcoming') {
    await testPool.query(
      `insert into events (law_firm_id, matter_id, type, title, date, status, location_name)
       values ($1, $2, $3, $4, $5, $6, 'Courtroom 4B')`,
      [firmA.id, matterId, type, title, date, status],
    );
  }

  it('fills the next hearing, the trial, the next deadline and the statute of limitations', async () => {
    const matter = await seedMatter(firmA.id, { name: 'M', statuteOfLimitationsDate: '2027-06-30' });
    await seedEvent(matter, 'hearing', 'Pretrial', '2026-02-01T15:00:00Z');
    await seedEvent(matter, 'hearing', 'Cancelled hearing', '2026-03-10T15:00:00Z', 'cancelled');
    await seedEvent(matter, 'hearing', 'Pretrial', '2026-03-12T15:00:00Z');
    await seedEvent(matter, 'filing_deadline', 'Motion deadline', '2026-03-20T22:00:00Z');
    await seedEvent(matter, 'trial', 'Jury trial', '2026-05-04T14:00:00Z');

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.body.context.values).toMatchObject({
      hearing_type: 'Hearing',
      hearing_date: 'March 12, 2026',
      hearing_date_legal: '12th day of March 2026',
      hearing_time: '10:00 AM',
      hearing_location: 'Courtroom 4B',
      next_deadline_date: 'March 20, 2026',
      next_deadline_title: 'Motion deadline',
      trial_date: 'May 4, 2026',
      statute_of_limitations_date: 'June 30, 2027',
    });
  });
});

describe('billing fields', () => {
  async function billedMatter() {
    const lead = await createFirmMember(firmA.id, { name: 'Jordan Wayfield' });
    const matter = await seedMatter(firmA.id, { name: 'Billed', leadUserId: lead.uid });
    const client = await createPersonClient(firmA.id, { name: 'Corwin Thistlewood' });
    await linkClient(firmA.id, matter, client.id);
    return { matter, client: client.id, lead: lead.uid };
  }

  it('sums issued invoices, leaving drafts and voided ones out', async () => {
    const { matter, client } = await billedMatter();
    await seedInvoice(firmA.id, matter, client, { status: 'outstanding', totalCents: 300000, amountPaidCents: 100000 });
    await seedInvoice(firmA.id, matter, client, { status: 'paid', totalCents: 50000, amountPaidCents: 50000 });
    await seedInvoice(firmA.id, matter, client, { status: 'draft', totalCents: 999900 });
    await seedInvoice(firmA.id, matter, client, { status: 'voided', totalCents: 777700 });

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.body.context.values).toMatchObject({
      total_invoiced_amount: '$3,500.00',
      total_paid_amount: '$1,500.00',
      outstanding_balance: '$2,000.00',
      total_hours_billed: '3.00',
    });
    expect(res.body.context.billingIncomplete).toBe(false);
  });

  it('prints no balance for a matter with no invoices', async () => {
    const { matter } = await billedMatter();
    const res = await context(ownerA, firmA.id, { matterId: matter });
    expect(res.body.context.values).not.toHaveProperty('outstanding_balance');
    expect(res.body.context.values).not.toHaveProperty('total_invoiced_amount');
  });

  it('builds the payment plan from the newest invoice with a schedule, listing only payments still to come', async () => {
    const { matter, client } = await billedMatter();
    const older = await seedInvoice(firmA.id, matter, client, { status: 'outstanding', totalCents: 100, createdAt: '2026-01-01T12:00:00Z' });
    const plan = await seedInvoice(firmA.id, matter, client, {
      status: 'outstanding', totalCents: 200000, createdAt: '2026-02-01T12:00:00Z', downPaymentCents: 100000,
    });
    const rows: Array<[string, number, string, string]> = [
      [older, 1, '2026-01-05', 'pending'],
      [plan, 50000 * 2, '2026-03-06', 'paid'],
      [plan, 50000, '2026-04-01', 'pending'],
      [plan, 50000, '2026-05-01', 'pending'],
    ];
    for (const [i, [invoiceId, cents, due, status]] of rows.entries()) {
      await testPool.query(
        `insert into invoice_expected_payments (law_firm_id, invoice_id, amount_cents, due_date, status, sort_order)
         values ($1, $2, $3, $4, $5, $6)`,
        [firmA.id, invoiceId, cents, due, status, i],
      );
    }

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.body.context.values).toMatchObject({
      initial_payment_amount: '$1,000.00',
      initial_payment_date: 'March 6, 2026',
      installment_count: '3',
      final_payment_date: 'May 1, 2026',
      next_payment_amount: '$500.00',
      next_payment_due_date: 'April 1, 2026',
      flat_fee_amount: '$2,000.00',
      down_payment_amount: '$1,000.00',
    });
    expect(res.body.context.repeaterValues.payment_plan).toEqual([
      { initial_payment_amount: '$1,000.00', initial_payment_date: 'March 6, 2026' },
    ]);
    expect(res.body.context.repeaterValues.payments).toEqual([
      { payment_date: 'April 1, 2026', payment_amount: '$500.00' },
      { payment_date: 'May 1, 2026', payment_amount: '$500.00' },
    ]);
  });

  it('lists payments received, line items, the trust balance and the retainer', async () => {
    const { matter, client } = await billedMatter();
    const invoice = await seedInvoice(firmA.id, matter, client, { status: 'outstanding', totalCents: 100000 });
    await testPool.query(
      `insert into invoice_payments (law_firm_id, invoice_id, amount_cents, payment_date, payment_source)
       values ($1, $2, 25000, '2026-02-10', 'check')`,
      [firmA.id, invoice],
    );
    await testPool.query(
      `insert into activities (law_firm_id, matter_id, kind, activity_date, description, hours, rate_cents, billable)
       values ($1, $2, 'time', '2026-02-02', 'Court appearance', 2, 15000, true),
              ($1, $2, 'time', '2026-02-03', 'Unbilled research', 1, 15000, false)`,
      [firmA.id, matter],
    );
    await testPool.query(
      `insert into activities (law_firm_id, matter_id, kind, activity_date, description, charge_cents, billable)
       values ($1, $2, 'expense', '2026-02-04', 'Filing fee', 7500, true),
              ($1, $2, 'flat_fee', '2026-02-01', 'Representation', 250000, true)`,
      [firmA.id, matter],
    );
    await createTrustDeposit(firmA.id, client, { amountCents: 412600 });
    await testPool.query(
      `insert into billing_plans (law_firm_id, matter_id, name, plan_type, status, amount_cents)
       values ($1, $2, 'Monthly retainer', 'retainer', 'active', 150000)`,
      [firmA.id, matter],
    );

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.body.context.repeaterValues.payment_history).toEqual([
      { payment_received_date: 'February 10, 2026', payment_received_amount: '$250.00', payment_method: 'Check' },
    ]);
    expect(res.body.context.repeaterValues.line_items).toEqual([
      { line_item_date: 'February 1, 2026', line_item_description: 'Representation', line_item_amount: '$2,500.00' },
      { line_item_date: 'February 2, 2026', line_item_description: 'Court appearance', line_item_amount: '$300.00' },
      { line_item_date: 'February 4, 2026', line_item_description: 'Filing fee', line_item_amount: '$75.00' },
    ]);
    expect(res.body.context.values).toMatchObject({
      flat_fee_amount: '$2,500.00',
      trust_balance: '$4,126.00',
      retainer_amount: '$1,500.00',
    });
  });

  it('never reads another firm\'s billing for a same-named client', async () => {
    const { matter, client } = await billedMatter();
    const clientB = await createPersonClient(firmB.id, { name: 'Corwin Thistlewood' });
    await createTrustDeposit(firmB.id, clientB.id, { amountCents: 99900 });
    await seedInvoice(firmA.id, matter, client, { status: 'outstanding', totalCents: 1000 });
    const res = await context(ownerA, firmA.id, { matterId: matter });
    expect(res.body.context.values).not.toHaveProperty('trust_balance');
    expect(JSON.stringify(res.body)).not.toContain('999.00');
  });

  it('leaves billing out for a member without billing permissions', async () => {
    const { matter, client } = await billedMatter();
    await seedInvoice(firmA.id, matter, client, { status: 'outstanding', totalCents: 300000 });
    await createTrustDeposit(firmA.id, client, { amountCents: 412600 });
    const member = await memberWith(firmA.id, []);
    await addMatterMember(firmA.id, matter, member.uid);

    const res = await context(member, firmA.id, { matterId: matter });

    expect(res.status).toBe(200);
    expect(res.body.context.values.case_name).toBe('Billed');
    expect(res.body.context.values).not.toHaveProperty('total_invoiced_amount');
    expect(res.body.context.values).not.toHaveProperty('trust_balance');
  });

  it('marks the context incomplete when a billing read fails', async () => {
    const { matter, client } = await billedMatter();
    await seedInvoice(firmA.id, matter, client, { status: 'outstanding', totalCents: 300000 });
    const repo = require('../../src/modules/wordTemplates/documentContext.repository');
    const spy = jest.spyOn(repo, 'listMatterInvoices').mockRejectedValue(new Error('connection reset'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.status).toBe(200);
    expect(res.body.context.billingIncomplete).toBe(true);
    expect(res.body.context.values.case_name).toBe('Billed');
    expect(res.body.context.values).not.toHaveProperty('total_invoiced_amount');
    spy.mockRestore();
    errors.mockRestore();
  });

  it('marks the context incomplete when the trust balance cannot be read', async () => {
    const { matter, client } = await billedMatter();
    await createTrustDeposit(firmA.id, client, { amountCents: 412600 });
    const repo = require('../../src/modules/wordTemplates/documentContext.repository');
    const spy = jest.spyOn(repo, 'clientTrustBalanceCents').mockRejectedValue(new Error('timeout'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await context(ownerA, firmA.id, { matterId: matter });

    expect(res.body.context.billingIncomplete).toBe(true);
    expect(res.body.context.values).not.toHaveProperty('trust_balance');
    spy.mockRestore();
    errors.mockRestore();
  });
});
