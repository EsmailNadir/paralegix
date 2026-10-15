/**
 * Layer volume and edge cases on top of the demo firm, so every list, empty
 * state, overflow and money state has something to show.
 *
 *   DB_TARGET=local npx tsx backend/db/seed/seed-scenarios.ts
 *   DB_TARGET=local npx tsx backend/db/seed/seed-scenarios.ts --firm <lawFirmId>
 *   DB_TARGET=staging npx tsx backend/db/seed/seed-scenarios.ts --allow-remote
 *
 * Run seed-local-testdata.ts first: this script reuses its practice-area
 * pipelines, stages and billing codes and refuses to run without them.
 * `--firm` defaults to the one firm named "Paralegix Demo Firm"; the owner is
 * the firm's owning member, and the first other firm member (the demo
 * Attorney) becomes the second timekeeper, assignee and message sender.
 *
 * What it adds, beyond plain volume (about 50 clients, 50 matters, 200 tasks,
 * 300 time entries, 30 invoices, 100 events):
 *   - clients: unicode, apostrophe, very long and single-word names, missing
 *     contact details, inactive and archived, pending, failed and resent portal
 *     invitations, and organizations with zero, one and four linked people
 *   - matters: every status and billing method, statute of limitations passed,
 *     today and in three days, a blown budget, a three-way billing split, no
 *     client at all, a completely empty matter, a very long name and
 *     description, and one "big" matter with hundreds of rows behind it
 *   - billing: every derived invoice status, write-offs and discounts, a void,
 *     a 40-line invoice, a client-level invoice, a payment plan with a missed
 *     installment, payments drawn from trust, and unbilled work left behind
 *   - trust: a second IOLTA, a settlement account with a lien, fee transfer and
 *     client distribution, an inactive zero-balance account, a pending and a
 *     voided deposit, a refund, and a client left with $12.50
 *   - calendar: a crowded day with overlapping events, all-day and multi-day
 *     events, late-night and past-midnight events, cancelled and completed ones
 *   - messages: a 120-message thread with unread tail, edits and a deletion, an
 *     archived thread and a single-message thread
 *   - leads across every lead stage, notes (pinned, retracted, long), document
 *     requests in every state, and an unread notification backlog
 *
 * Every row carries a fixed id prefixed with 5ce4a210, scoped to the firm, so
 * the script is idempotent: it deletes its own previous rows and re-inserts
 * them. Generated values come from a seeded PRNG, so each run writes the same
 * data, shifted to stay relative to today.
 *
 * Refuses DB_TARGET=prod, and refuses a hosted Supabase database unless
 * --allow-remote says so on purpose. Loads env from backend/.env.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl, needsSsl } = require('../../src/shared/database/resolveDbUrl');

const argOf = (flag: string, fallback: any) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const FIRM_ARG = argOf('--firm', null);
const ALLOW_REMOTE = process.argv.includes('--allow-remote');

// Fixed-id namespace, distinct from seed-local-testdata.ts (7e57da7a), so the
// two scripts never delete each other's rows.
const NS = '5ce4a210';

// Same per-firm id fragment scheme as seed-local-testdata.ts: the id carries a
// bare sequence number, so without it two firms would collide on `id`.
function firmFragment(firmId: string) {
  let hash = 2166136261;
  for (let i = 0; i < firmId.length; i++) {
    hash ^= firmId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Deterministic PRNG (mulberry32), so a re-run writes identical data.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261006);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;

// Day offsets resolved against today, so seeded data always straddles "now".
const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
// A wall-clock time in US Eastern, written as an instant. A fixed four-hour
// offset is close enough for demo data and keeps "9am" looking like 9am.
const et = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour + 4, minute, 0, 0);
  return d.toISOString();
};
// Noon UTC, which is how the app stores an all-day event's start and exclusive
// end: midnight UTC reads as the previous day anywhere west of Greenwich.
const dayAnchor = (offsetDays: number) => `${day(offsetDays)}T12:00:00.000Z`;

// The status the app would derive for an invoice today. Mirrors
// deriveInvoiceStatus in src/modules/billing/shared/invoiceStatus.ts, so the
// stored column agrees with what the billing screens compute.
function deriveStatus(inv: { total: number; paid: number; writtenOff: number; credits: number; isPaid: boolean; due: string | null; nextPayment: string | null }) {
  const remaining = Math.max(0, inv.total - inv.paid - inv.writtenOff);
  if (remaining <= 0 && (inv.total > 0 || inv.paid > 0 || inv.writtenOff > 0 || inv.isPaid)) {
    if (inv.isPaid) return 'paid';
    if (inv.writtenOff > 0 || inv.credits > 0) return 'credited';
    return 'paid';
  }
  if (inv.paid > 0) return 'partially_paid';
  const dueDay = inv.nextPayment || inv.due;
  if (remaining > 0 && dueDay && dueDay < day(0)) return 'overdue';
  return 'outstanding';
}

// ── name and text pools ─────────────────────────────────────────────────────
const FIRST = ['Olivia', 'Liam', 'Ava', 'Noah', 'Sophia', 'Ethan', 'Isabella', 'Mason', 'Mia', 'Lucas',
  'Harper', 'Elijah', 'Amelia', 'James', 'Evelyn', 'Benjamin', 'Abigail', 'Henry', 'Emily', 'Alexander',
  'Grace', 'Daniel', 'Chloe', 'Samuel', 'Nora', 'Owen', 'Layla', 'Caleb', 'Riley', 'Isaac', 'Zoe', 'Wyatt'];
const LAST = ['Anderson', 'Brooks', 'Carver', 'Dalton', 'Ellison', 'Fischer', 'Gallagher', 'Hollis', 'Ingram',
  'Jensen', 'Kowalski', 'Lindqvist', 'Moreno', 'Nakamura', 'Ostrowski', 'Patel', 'Quinlan', 'Rasmussen',
  'Sato', 'Thornton', 'Underwood', 'Valdez', 'Whitaker', 'Xu', 'Yilmaz', 'Zimmerman', 'Abernathy',
  'Beaumont', 'Castellano', 'Dimitriou', 'Eriksen', 'Fontaine'];
const CITIES = ['Columbus, OH 43215', 'Dayton, OH 45402', 'Cincinnati, OH 45202', 'Cleveland, OH 44114',
  'Toledo, OH 43604', 'Akron, OH 44308', 'Dublin, OH 43017', 'Westerville, OH 43081', 'Mason, OH 45040'];
const STREETS = ['Maple Ave', 'High St', 'Riverside Dr', 'Elm St', 'Oak Ridge Rd', 'Lakeview Blvd', 'Main St', 'Cedar Ln'];
const DEFENDANTS = ['Buckeye Freight Lines', 'Kroger Co.', 'City of Columbus', 'Allstate Fire & Casualty',
  'Midwest Rideshare LLC', 'OhioHealth Riverside', 'Sunrise Apartments LLC', 'Tri-County Paving', 'Amazon Logistics'];
const COMPANIES = ['Harbor Point Marine', 'Greenfield Organics', 'Summit Ridge Builders', 'Lantern Software',
  'Copperline Electric', 'Westgate Dental Group'];

const TASK_TITLES: Record<string, string[]> = {
  'Personal Injury': ['Request police report', 'Send preservation letter to defendant', 'Collect medical bills',
    'Calendar IME', 'Draft demand letter', 'Follow up with adjuster', 'Prepare deposition outline',
    'Review lien notices', 'Answer interrogatories', 'Schedule mediation'],
  'Family Law': ['Draft parenting plan', 'Collect financial affidavits', 'Prepare for custody evaluation',
    'Serve discovery requests', 'Review QDRO language', 'File temporary orders motion', 'Client prep for hearing'],
  'Criminal Defense': ['Request discovery from prosecutor', 'Review body cam footage', 'Draft motion to suppress',
    'Interview witness', 'Prepare plea memo', 'Subpoena records', 'Client jail visit'],
  'Estate Planning': ['Draft will', 'Draft durable POA', 'Fund revocable trust', 'Schedule signing ceremony',
    'Update beneficiary designations', 'Prepare asset inventory'],
  'Business Law': ['Redline MSA', 'Draft operating agreement', 'File annual report', 'Review NDA',
    'Prepare board consent', 'Trademark clearance search', 'Respond to demand letter'],
};
const TIME_DESCS = ['Telephone conference with client', 'Draft correspondence to opposing counsel',
  'Legal research and memo', 'Review and analyze documents produced', 'Prepare for hearing',
  'Attend hearing', 'Revise draft agreement', 'Email exchange with client re: status',
  'Review medical records', 'Conference with co-counsel', 'Draft motion and proposed order',
  'Review court docket and calendar deadlines', 'Prepare discovery responses', 'Travel to and from courthouse'];
const HOURS = [0.1, 0.2, 0.3, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 3.4, 4.2, 6.0, 7.5];
const EXPENSES: [string, string, number, number][] = [
  // [description, vendor, minCents, maxCents]
  ['Court filing fee', 'Franklin County Clerk', 7500, 40000],
  ['Process server', 'Buckeye Process', 4500, 12500],
  ['Deposition transcript', 'Veritext', 35000, 180000],
  ['Medical records copy fee', 'OhioHealth HIM', 1500, 9500],
  ['Mileage', '', 1200, 9000],
  ['Expert review fee', 'Vance Forensics', 75000, 450000],
  ['Courier', 'FedEx', 2500, 6500],
];
const EVENT_TYPES = ['court_date', 'hearing', 'deposition', 'filing_deadline', 'mediation', 'meeting', 'meeting', 'other'];
const MESSAGE_LINES = [
  'Just following up on this.',
  'I sent the revised draft over this morning, let me know if you have comments.',
  'Opposing counsel called, they want to push the deposition by a week.',
  'Can you pull the docket and confirm the hearing time?',
  'Client signed the authorization, uploading it now.',
  'Thanks!',
  'Got it 👍',
  'The adjuster is asking for the full billing ledger again. I think we already sent it on the 3rd but I will resend.',
  'Reminder: the response brief is due Friday at 5pm.',
  'Can we talk at 2? I want to go over the settlement numbers before we call the client.',
  'Filed. Confirmation number is in the matter notes.',
  'Heads up: judge moved the status conference to the afternoon docket.',
];

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL resolved (DB_TARGET / DATABASE_URL in backend/.env).');
    process.exit(1);
  }
  if (String(process.env.DB_TARGET).toLowerCase() === 'prod') {
    console.error('Refusing to run against DB_TARGET=prod. This script is for local and staging only.');
    process.exit(1);
  }
  if (/supabase|pooler\.supabase\.com/i.test(connectionString) && !ALLOW_REMOTE) {
    console.error('Refusing to run: this resolves to a hosted Supabase database.');
    console.error('Set DB_TARGET=local, or pass --allow-remote to seed staging on purpose.');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const q = (text: string, params?: any[]) => client.query(text, params);

  try {
    // ── resolve the firm, its two people, and the base seeder's catalogs ────
    const { rows: firms } = FIRM_ARG
      ? await q('select id, name from law_firms where id = $1', [FIRM_ARG])
      : await q("select id, name from law_firms where name = 'Paralegix Demo Firm'");
    if (firms.length !== 1) {
      throw new Error(FIRM_ARG ? `Law firm ${FIRM_ARG} not found.` : 'Expected exactly one "Paralegix Demo Firm"; pass --firm <id>.');
    }
    const FIRM = firms[0].id;
    const { rows: people } = await q(
      `select m.user_id, m.is_owner, coalesce(u.name, u.email::text) as name
         from members m join users u on u.id = m.user_id
        where m.law_firm_id = $1 and u.user_type = 'firm_member'
        order by m.is_owner desc, m.created_at`,
      [FIRM]
    );
    if (!people.length || !people[0].is_owner) throw new Error(`Firm ${FIRM} has no owning member.`);
    const OWNER: string = people[0].user_id;
    const OWNER_NAME: string = people[0].name;
    const ATTY: string = (people[1] || people[0]).user_id;
    const ATTY_NAME: string = (people[1] || people[0]).name;
    const nameOf = (uid: string) => (uid === OWNER ? OWNER_NAME : ATTY_NAME);
    const rateOf = (uid: string) => (uid === OWNER ? 35000 : 27500);

    const { rows: stageRows } = await q(
      `select s.id, s.name, s.is_closed, s.pipeline_id, p.practice_area_id, pa.name as pa_name
         from matter_stages s
         join matter_stage_pipelines p on p.id = s.pipeline_id
         join practice_areas pa on pa.id = p.practice_area_id
        where s.law_firm_id = $1 and s.id::text like '7e57da7a-%'
        order by s.sort_order`,
      [FIRM]
    );
    const { rows: codeRows } = await q(
      "select id, code from billing_codes where law_firm_id = $1 and code like 'TEST-%'",
      [FIRM]
    );
    if (!stageRows.length || !codeRows.length) {
      throw new Error('Run seed-local-testdata.ts for this firm first: its stages and billing codes are reused here.');
    }
    const PA_NAMES = ['Personal Injury', 'Family Law', 'Criminal Defense', 'Estate Planning', 'Business Law'];
    const pipelineOf: Record<string, { paId: string; pipelineId: string; open: any[]; closed: any[] }> = {};
    for (const paName of PA_NAMES) {
      const stages = stageRows.filter((s: any) => s.pa_name === paName);
      pipelineOf[paName] = {
        paId: stages[0].practice_area_id,
        pipelineId: stages[0].pipeline_id,
        open: stages.filter((s: any) => !s.is_closed),
        closed: stages.filter((s: any) => s.is_closed),
      };
    }
    const code = (c: string) => codeRows.find((r: any) => r.code === c)?.id || null;
    const CODE_ATTY = code('TEST-ATTY');
    const CODE_PARA = code('TEST-PARA');
    const CODE_COURT = code('TEST-COURT');
    const CODE_FILING = code('TEST-FILING');
    const CODE_TRAVEL = code('TEST-TRAVEL');
    const CODE_EXPERT = code('TEST-EXPERT');
    const CODE_COPY = code('TEST-COPY');

    // tasks.ends_at arrived in migration 0039. A database that has not had it
    // applied yet still seeds, just without task ends.
    const { rows: endCol } = await q(
      "select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'ends_at'",
    );
    const hasTaskEnds = endCol.length > 0;

    const { rows: leadStages } = await q(
      'select id, name, is_closed from lead_stages where law_firm_id = $1 order by sort_order',
      [FIRM]
    );

    const frag = firmFragment(FIRM);
    const counters: Record<string, number> = {};
    // One id generator per table group; each call returns the next id in it.
    const idOf = (group: string) => {
      counters[group] = (counters[group] || 0) + 1;
      return `${NS}-${group}-4${frag.slice(0, 3)}-8${frag.slice(3, 6)}-${String(counters[group]).padStart(12, '0')}`;
    };
    const G = {
      client: '0001', link: '0002', matter: '0003', task: '0004', subtask: '0005', activity: '0006',
      invoice: '0007', line: '0008', payment: '0009', adjustment: '000a', expected: '000b', trustAcct: '000c',
      trustTxn: '000d', conv: '000e', msg: '000f', event: '0010', note: '0011', notif: '0012', lead: '0013',
      docreq: '0014', docitem: '0015', contact: '0016', mcontact: '0017', actlog: '0018', participant: '0019',
    };

    console.log(`Seeding scenarios into "${firms[0].name}" (${FIRM})`);
    console.log(`  owner ${OWNER_NAME}, second timekeeper ${ATTY_NAME}\n`);

    await q('begin');
    // Same trade as seed-local-testdata.ts: lets the cleanup delete append-only
    // trust rows and billed activities, and skips every trigger (FK checks
    // included) for this transaction, so insert order is chosen for reading.
    await q("set local session_replication_role = 'replica'");

    // ── cleanup: drop everything this script wrote on a previous run ─────────
    const like = `${NS}-%`;
    const byId = [
      'document_request_items', 'document_requests', 'invoice_expected_payments', 'invoice_adjustments',
      'invoice_payments', 'invoice_line_items', 'invoices', 'activities', 'task_subtasks', 'tasks',
      'trust_transactions', 'trust_accounts', 'messages', 'conversation_participants', 'conversations',
      'events', 'notifications', 'activity_log', 'notes', 'matter_contacts', 'contacts', 'leads',
      'client_company_links', 'matters', 'clients',
    ];
    for (const table of byId) {
      await q(`delete from ${table} where id::text like $1 and law_firm_id = $2`, [like, FIRM]);
    }
    await q('delete from matter_clients where matter_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from matter_members where matter_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from task_assignees where task_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from event_assignees where event_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from conversation_matters where conversation_id::text like $1 and law_firm_id = $2', [like, FIRM]);

    // ── clients ─────────────────────────────────────────────────────────────
    type ClientRow = { id: string; name: string; type: 'person' | 'company' };
    const clients: ClientRow[] = [];
    const insertClient = async (c: {
      name: string; type?: 'person' | 'company'; email?: string | null; phone?: string | null;
      address?: string | null; org?: string | null; status?: string; createdOffset?: number;
      invitePending?: boolean; invitedOffset?: number | null; inviteFailed?: boolean; resendCount?: number;
    }) => {
      const cid = idOf(G.client);
      const invited = c.invitedOffset != null;
      await q(
        `insert into clients (id, law_firm_id, client_type, name, email, phone, organization, address, status,
                              preferred_contact_method, portal_invite_pending, invited_at, invited_by,
                              invitation_sent_at, invitation_failed, invitation_resend_count, last_resend_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'email',$10,$11,$12,$13,$14,$15,$16,$17)`,
        [cid, FIRM, c.type || 'person', c.name, c.email ?? null, c.phone ?? null, c.org ?? null, c.address ?? null,
          c.status || 'active', Boolean(c.invitePending), invited ? et(c.invitedOffset!, 10) : null,
          invited ? OWNER : null, invited ? et(c.invitedOffset!, 10) : null, Boolean(c.inviteFailed),
          c.resendCount || 0, c.resendCount ? et(-1, 9) : null, et(c.createdOffset ?? -int(5, 400), 9)]
      );
      const row: ClientRow = { id: cid, name: c.name, type: c.type || 'person' };
      clients.push(row);
      return row;
    };

    // Thirty-two ordinary people, with gaps in their contact details.
    const people32: ClientRow[] = [];
    for (let i = 0; i < 32; i++) {
      const first = FIRST[i];
      const last = LAST[(i * 7) % LAST.length];
      people32.push(await insertClient({
        name: `${first} ${last}`,
        email: i % 9 === 4 ? null : `${first}.${last}@example.test`.toLowerCase(),
        phone: i % 5 === 0 ? null : `+1-614-555-${String(1000 + i * 37).slice(-4)}`,
        address: i % 7 === 3 ? null : `${int(10, 9999)} ${pick(STREETS)}, ${pick(CITIES)}`,
        status: i % 11 === 10 ? 'inactive' : i % 13 === 12 ? 'archived' : 'active',
      }));
    }

    // Names and contact states that stress layout, sorting and search.
    const cLong = await insertClient({ name: 'Maximilian Alexander Wolfgang Fitzgerald-Montgomery-Vanderbilt III', email: 'maximilian.fitzgerald-montgomery-vanderbilt.the.third@extremely-long-domain-name.example.test', phone: '+1-614-555-0901', address: 'Apartment 4417, Building C, The Residences at Scioto Mile Riverfront Commons, 1500 West Long Street Extension, Columbus, OH 43215-1234' });
    const cViet = await insertClient({ name: 'Nguyễn Thị Minh Khai', email: 'minhkhai.nguyen@example.test', phone: '+1-614-555-0902', address: '12 Kenny Rd, Columbus, OH 43210' });
    const cJose = await insertClient({ name: 'José Ñúñez-García', email: 'jose.nunez@example.test', phone: '+1-937-555-0903' });
    const cSean = await insertClient({ name: "Seán O'Connor-Łukasiewicz", email: 'sean.oconnor@example.test', phone: '+1-216-555-0904' });
    const cMono = await insertClient({ name: 'Cher', email: null, phone: null, address: null });
    await insertClient({ name: 'Priyanka Venkataraman', email: 'priyanka.v@example.test', invitePending: true, invitedOffset: -3 });
    await insertClient({ name: 'Bartholomew Kinsley', email: 'bart.kinsley@bounce.example.test', invitePending: true, invitedOffset: -9, inviteFailed: true });
    await insertClient({ name: 'Rosalind Achterberg', email: 'rosalind.a@example.test', invitePending: true, invitedOffset: -21, resendCount: 3 });
    await insertClient({ name: 'Prospect - No Matters Yet', email: 'prospect@example.test', createdOffset: -1 });
    await insertClient({ name: 'Dormant Former Client', email: 'dormant@example.test', status: 'archived', createdOffset: -1400 });

    // Organizations: four people, one person, nobody, and a very long name.
    const coAcme = await insertClient({ name: 'Acme Logistics Holdings, Inc.', type: 'company', email: 'legal@acmelogistics.example.test', phone: '+1-614-555-0950', address: '4000 Logistics Pkwy, Groveport, OH 43125', org: 'Acme Logistics Holdings, Inc.' });
    const coNorth = await insertClient({ name: 'Northside Medical Group, PLLC', type: 'company', email: 'admin@northsidemed.example.test', phone: '+1-614-555-0951', org: 'Northside Medical Group, PLLC' });
    await insertClient({ name: 'Bluebird Bakery & Café LLC', type: 'company', email: null, phone: '+1-614-555-0952', org: 'Bluebird Bakery & Café LLC' });
    const coLong = await insertClient({ name: 'The Greater Columbus Regional Association of Independent Hardware Retailers and Distributors, Inc.', type: 'company', email: 'office@gcrahrd.example.test', org: 'The Greater Columbus Regional Association of Independent Hardware Retailers and Distributors, Inc.' });
    const companyPeople: [ClientRow, ClientRow, string, boolean, boolean, boolean][] = [
      // [person, company, relationship, isPrimary, isEmailRecipient, canViewBilling]
      [people32[0], coAcme, 'General Counsel', true, true, true],
      [people32[1], coAcme, 'CFO', false, true, true],
      [people32[2], coAcme, 'Operations Manager', false, false, false],
      [people32[3], coAcme, 'HR Director', false, false, false],
      [people32[4], coNorth, 'Practice Administrator', true, true, true],
      [people32[5], coLong, 'Executive Director', true, true, false],
    ];
    for (const [person, company, rel, primary, emailRecipient, billing] of companyPeople) {
      await q(
        `insert into client_company_links (id, law_firm_id, person_client_id, company_client_id, relationship,
                                           is_primary, is_email_recipient, can_view_billing, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [idOf(G.link), FIRM, person.id, company.id, rel, primary, emailRecipient, billing, OWNER]
      );
    }

    // ── matters ─────────────────────────────────────────────────────────────
    type MatterRow = {
      id: string; name: string; pa: string; status: string; billing: string; openOffset: number;
      clientIds: string[]; members: string[]; lead: string;
    };
    const matters: MatterRow[] = [];
    let matterSeq = 0;
    const insertMatter = async (m: {
      name: string; pa: string; status: string; billing?: string; clientIds: string[]; desc?: string | null;
      budget?: number | null; openOffset: number; closeOffset?: number | null; solOffset?: number | null;
      lead?: string; members?: string[]; contingency?: number | null; split?: number[]; paymentOngoing?: boolean;
    }) => {
      const mid = idOf(G.matter);
      matterSeq += 1;
      const pipe = pipelineOf[m.pa];
      const terminal = ['completed', 'closed', 'archived'].includes(m.status);
      const stage = terminal && pipe.closed.length ? pipe.closed[0] : pipe.open[matterSeq % pipe.open.length];
      const billing = m.billing || 'hourly';
      const lead = m.lead || OWNER;
      const members = m.members || [lead];
      await q(
        `insert into matters (id, law_firm_id, name, matter_number, matter_reference_id, description, status,
                              practice_area_id, stage_id, stage_pipeline_id, billing_method, is_billable,
                              budget_cents, budget_includes_expenses, contingency_percent, payment_ongoing,
                              open_date, close_date, statute_of_limitations_date, lead_user_id, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [mid, FIRM, m.name, `SCN-${String(matterSeq).padStart(3, '0')}`, `SCN-REF-${String(matterSeq).padStart(3, '0')}`,
          m.desc === undefined ? null : m.desc, m.status, pipe.paId, stage.id, pipe.pipelineId, billing,
          billing !== 'pro_bono', m.budget ?? null, billing === 'contingency' ? m.contingency ?? 33.33 : null,
          Boolean(m.paymentOngoing), day(m.openOffset), m.closeOffset == null ? null : day(m.closeOffset),
          m.solOffset == null ? null : day(m.solOffset), lead, OWNER, et(m.openOffset, 9)]
      );
      for (const [n, cid] of m.clientIds.entries()) {
        await q(
          'insert into matter_clients (matter_id, client_id, law_firm_id, billing_portion_bp) values ($1,$2,$3,$4)',
          [mid, cid, FIRM, m.split ? m.split[n] : null]
        );
      }
      for (const uid of new Set([lead, ...members])) {
        await q(
          `insert into matter_members (matter_id, user_id, law_firm_id, role, hourly_rate_cents, joined_at)
           values ($1,$2,$3,$4,$5,$6)`,
          [mid, uid, FIRM, uid === lead ? 'lead' : 'member', rateOf(uid), et(m.openOffset, 9)]
        );
      }
      const row: MatterRow = { id: mid, name: m.name, pa: m.pa, status: m.status, billing, openOffset: m.openOffset, clientIds: m.clientIds, members: [...new Set([lead, ...members])], lead };
      matters.push(row);
      return row;
    };

    // Thirty-six generated matters over the first 28 people, so some clients
    // carry two or three matters and the last four carry none.
    const STATUS_CYCLE = ['active', 'active', 'active', 'pending', 'active', 'on_hold', 'active', 'completed',
      'active', 'closed', 'blocked', 'active', 'archived'];
    const generated: MatterRow[] = [];
    for (let i = 0; i < 36; i++) {
      const pa = PA_NAMES[i % 5];
      const person = people32[i % 28];
      const last = person.name.split(' ')[1];
      const status = STATUS_CYCLE[i % STATUS_CYCLE.length];
      const name = {
        'Personal Injury': `${last} v. ${DEFENDANTS[i % DEFENDANTS.length]}`,
        'Family Law': i % 2 ? `In re Marriage of ${last}` : `${last} Custody Modification`,
        'Criminal Defense': `State of Ohio v. ${person.name}`,
        'Estate Planning': i % 2 ? `${last} Revocable Trust` : `Estate of ${last} (Probate)`,
        'Business Law': `${COMPANIES[i % COMPANIES.length]} - ${pick(['Operating Agreement', 'Contract Dispute', 'Asset Purchase', 'Lease Review'])}`,
      }[pa]!;
      const openOffset = -int(3, 700);
      const terminal = ['completed', 'closed', 'archived'].includes(status);
      const billing = i % 13 === 6 ? 'pro_bono'
        : pa === 'Personal Injury' ? 'contingency' : pa === 'Criminal Defense' ? 'flat' : 'hourly';
      const lead = i % 3 === 0 ? ATTY : OWNER;
      generated.push(await insertMatter({
        name, pa, status, billing,
        clientIds: [person.id],
        desc: chance(0.8) ? `${pa} matter for ${person.name}. ${pick(['Client referred by a former client.', 'Walk-in consultation converted to engagement.', 'Referred by co-counsel.', 'Came in through the website intake form.'])}` : null,
        budget: chance(0.6) ? int(5, 120) * 10000 : null,
        openOffset,
        closeOffset: terminal ? Math.min(-1, openOffset + int(30, 300)) : null,
        solOffset: pa === 'Personal Injury' ? int(20, 900) : null,
        lead,
        members: i % 4 === 1 ? [OWNER, ATTY] : [lead],
        contingency: i % 2 ? 40 : 33.33,
      }));
    }

    // The deliberate edge cases.
    const mSol3 = await insertMatter({ name: `${people32[29].name.split(' ')[1]} v. Allstate Fire & Casualty`, pa: 'Personal Injury', status: 'active', billing: 'contingency', clientIds: [people32[29].id], desc: 'Statute of limitations runs in three days and the complaint is not filed yet.', openOffset: -700, solOffset: 3 });
    const mSolPast = await insertMatter({ name: `${people32[30].name.split(' ')[1]} v. Tri-County Paving`, pa: 'Personal Injury', status: 'active', billing: 'contingency', clientIds: [people32[30].id], desc: 'Statute of limitations passed two days ago. Should be flagged everywhere a deadline is shown.', openOffset: -760, solOffset: -2 });
    const mSolToday = await insertMatter({ name: `${people32[31].name.split(' ')[1]} v. Midwest Rideshare LLC`, pa: 'Personal Injury', status: 'active', billing: 'contingency', clientIds: [people32[31].id], desc: 'Statute of limitations is today.', openOffset: -720, solOffset: 0 });
    const mOverBudget = await insertMatter({ name: 'Fontaine Commercial Lease Dispute', pa: 'Business Law', status: 'active', clientIds: [people32[6].id], desc: 'Budget was $1,500. Time already logged is far past it.', budget: 150000, openOffset: -120, members: [OWNER, ATTY] });
    const mLong = await insertMatter({
      name: 'In re the Consolidated Proceedings Concerning the Dissolution, Equitable Division of Marital Property, and Allocation of Parental Rights and Responsibilities of Fitzgerald-Montgomery-Vanderbilt',
      pa: 'Family Law', status: 'active', clientIds: [cLong.id], budget: 2500000, openOffset: -300,
      desc: [
        'This matter involves the dissolution of a 22-year marriage with substantial marital and separate property, including two closely held businesses, a vacation property in Hilton Head, a deferred compensation plan, and a disputed inheritance that the client maintains was never commingled.',
        'Opposing counsel has signalled a contested custody position for the two minor children (ages 9 and 14). The 14-year-old has expressed a preference to the guardian ad litem. A custody evaluation has been ordered and the evaluator has requested records from both parents, the children\'s school, and two treating therapists.',
        'Key open issues: (1) valuation date for the businesses; (2) tracing of the inheritance; (3) temporary spousal support; (4) whether the deferred compensation vested before or during the marriage; (5) holiday and summer parenting schedule.',
        'Next steps: retain a forensic accountant, file the motion for temporary orders, serve the second set of interrogatories, and prepare the client for the GAL interview.',
      ].join('\n\n'),
    });
    const mSplit = await insertMatter({ name: 'Castellano Siblings - Family Farm Partition', pa: 'Estate Planning', status: 'active', clientIds: [people32[7].id, people32[8].id, people32[9].id], split: [5000, 3000, 2000], desc: 'Three siblings share the fees 50 / 30 / 20.', budget: 800000, openOffset: -90, members: [OWNER, ATTY] });
    const mNoClient = await insertMatter({ name: 'Firm Internal - Conflicts Policy Update', pa: 'Business Law', status: 'active', clientIds: [], desc: 'No client attached. Internal administrative matter.', openOffset: -15 });
    const mEmpty = await insertMatter({ name: 'Brand New Matter (empty)', pa: 'Family Law', status: 'pending', clientIds: [cMono.id], desc: null, openOffset: 0 });
    const mPayOngoing = await insertMatter({ name: `${people32[10].name.split(' ')[1]} Divorce - Post-Decree`, pa: 'Family Law', status: 'closed', clientIds: [people32[10].id], desc: 'Closed, but the client is on a payment plan for the final invoice.', openOffset: -400, closeOffset: -60, paymentOngoing: true });
    const mAcme = await insertMatter({ name: 'Acme Logistics - Fleet Acquisition', pa: 'Business Law', status: 'active', clientIds: [coAcme.id], desc: 'Asset purchase of a 140-truck regional fleet.', budget: 15000000, openOffset: -75, lead: ATTY, members: [OWNER, ATTY] });
    const mNorth = await insertMatter({ name: 'Northside Medical - HIPAA Breach Response', pa: 'Business Law', status: 'active', clientIds: [coNorth.id], openOffset: -20 });
    const mProBono = await insertMatter({ name: 'Ñúñez-García Eviction Defense (Pro Bono)', pa: 'Business Law', status: 'active', billing: 'pro_bono', clientIds: [cJose.id], desc: 'Pro bono referral from the Legal Aid Society.', openOffset: -40 });
    const mViet = await insertMatter({ name: 'Nguyễn Thị Minh Khai v. Kroger Co.', pa: 'Personal Injury', status: 'active', billing: 'contingency', clientIds: [cViet.id], desc: 'Interpreter required for all client meetings (Vietnamese).', openOffset: -50, solOffset: 680 });
    const mSean = await insertMatter({ name: "State of Ohio v. Seán O'Connor-Łukasiewicz", pa: 'Criminal Defense', status: 'on_hold', billing: 'flat', clientIds: [cSean.id], openOffset: -65 });
    const mBig = await insertMatter({ name: 'Patel v. Buckeye Freight Lines (Big Matter)', pa: 'Personal Injury', status: 'active', billing: 'hourly', clientIds: [people32[11].id], desc: 'Truck collision with catastrophic injuries. This matter has a lot of everything: long task list, long message thread, dozens of notes and time entries, a 40-line invoice and a settlement in trust.', budget: 9000000, openOffset: -540, solOffset: 190, members: [OWNER, ATTY] });

    // ── directory contacts on a few matters ─────────────────────────────────
    const contactDefs: [MatterRow, string, string, string | null, string | null][] = [
      [mBig, 'Gwendolyn Harcourt', 'opposing_counsel', 'Harcourt Simmons LLP', 'gharcourt@hslaw.example.test'],
      [mBig, 'Hon. Theodore Blackwell', 'judge', 'Franklin County Common Pleas', null],
      [mBig, 'Dr. Ingrid Solberg', 'expert', 'Midwest Biomechanics', 'isolberg@midwestbio.example.test'],
      [mBig, 'Carla Mendes', 'adjuster', 'Great West Casualty', 'cmendes@gwc.example.test'],
      [mBig, 'Ray Tolliver', 'witness', null, null],
      [mBig, 'Pamela Ruiz, RPR', 'court_reporter' as any, 'Veritext', 'pruiz@veritext.example.test'],
      [mLong, 'Margaret Ellsworth, GAL', 'guardian_ad_litem', null, 'mellsworth@example.test'],
      [mLong, 'Hon. Felicia Ward', 'judge', 'Franklin County Domestic Relations', null],
      [mAcme, 'Jordan Pike', 'opposing_counsel', 'Pike & Associates', 'jpike@pikelaw.example.test'],
      [mSplit, 'Harold Bennett', 'mediator', 'Ohio Mediation Partners', 'hbennett@omp.example.test'],
    ];
    for (const [m, name, role, org, email] of contactDefs) {
      const contactId = idOf(G.contact);
      await q(
        `insert into contacts (id, law_firm_id, name, category, organization, email, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [contactId, FIRM, name, role, org, email, OWNER]
      );
      // court_reporter is a directory category but not a matter role.
      await q(
        `insert into matter_contacts (id, law_firm_id, matter_id, contact_id, role, created_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [idOf(G.mcontact), FIRM, m.id, contactId, role === 'court_reporter' ? 'other' : role, OWNER]
      );
    }

    // ── tasks ───────────────────────────────────────────────────────────────
    let taskCount = 0;
    let subtaskCount = 0;
    const insertTask = async (t: {
      title: string; matterId: string | null; status: string; priority: string; dueOffset: number | null;
      assignees: string[]; description?: string | null; dueHour?: number | null; subtasks?: [string, boolean][];
      createdOffset?: number;
      /** Timed: [days after the due day, hour, minute]. All-day: the number of days covered. */
      end?: [number, number, number] | number;
    }) => {
      const tid = idOf(G.task);
      const timed = t.dueOffset != null && t.dueHour != null;
      // A timed end is an instant; an all-day end is the exclusive day after
      // the last day, at noon UTC, as the app stores it.
      let endsAt: string | null = null;
      if (hasTaskEnds && t.end != null && t.dueOffset != null) {
        endsAt = Array.isArray(t.end)
          ? et(t.dueOffset + t.end[0], t.end[1], t.end[2])
          : dayAnchor(t.dueOffset + t.end);
      }
      await q(
        `insert into tasks (id, law_firm_id, title, description, matter_id, status, priority, due_date,
                            due_date_timezone, due_at, all_day, created_by, created_at${hasTaskEnds ? ', ends_at' : ''})
         values ($1,$2,$3,$4,$5,$6,$7,$8,'America/New_York',$9,$10,$11,$12${hasTaskEnds ? ',$13' : ''})`,
        [tid, FIRM, t.title, t.description ?? null, t.matterId, t.status, t.priority,
          t.dueOffset == null ? null : day(t.dueOffset), timed ? et(t.dueOffset!, t.dueHour!) : null,
          !timed && t.dueOffset != null, OWNER, et(t.createdOffset ?? -int(1, 60), 9),
          ...(hasTaskEnds ? [endsAt] : [])]
      );
      for (const uid of t.assignees) {
        await q('insert into task_assignees (law_firm_id, task_id, user_id) values ($1,$2,$3)', [FIRM, tid, uid]);
      }
      for (const [n, [title, done]] of (t.subtasks || []).entries()) {
        await q(
          `insert into task_subtasks (id, law_firm_id, task_id, title, is_completed, sort_order, assignee_user_id,
                                      created_by, completed_at, completed_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [idOf(G.subtask), FIRM, tid, title, done, n, n % 3 === 2 ? ATTY : null, OWNER,
            done ? et(-int(1, 10), 11) : null, done ? OWNER : null]
        );
        subtaskCount += 1;
      }
      taskCount += 1;
      return tid;
    };
    const ASSIGNEE_SETS = [[OWNER], [OWNER], [ATTY], [OWNER, ATTY], []];
    const PRIORITIES = ['low', 'medium', 'medium', 'high', 'urgent'];
    for (const m of generated) {
      const pool = TASK_TITLES[m.pa];
      const terminal = ['completed', 'closed', 'archived'].includes(m.status);
      for (let n = 0; n < int(2, 5); n++) {
        const dueOffset = chance(0.12) ? null : int(-45, 90);
        const status = terminal ? 'completed'
          : dueOffset != null && dueOffset < -10 && chance(0.6) ? 'completed'
          : pick(['open', 'open', 'open', 'in_progress', 'in_progress', 'blocked', 'completed']);
        await insertTask({
          title: pool[(n + matters.indexOf(m)) % pool.length], matterId: m.id, status, priority: pick(PRIORITIES),
          dueOffset, assignees: pick(ASSIGNEE_SETS),
          subtasks: chance(0.25) ? [['Gather documents', true], ['Draft', chance(0.5)], ['Partner review', false]] : [],
        });
      }
    }
    // Deadline-driven tasks on the SOL matters.
    await insertTask({ title: 'FILE COMPLAINT - statute runs in 3 days', matterId: mSol3.id, status: 'in_progress', priority: 'urgent', dueOffset: 2, assignees: [OWNER, ATTY] });
    await insertTask({ title: 'Statute of limitations passed - notify carrier and client', matterId: mSolPast.id, status: 'open', priority: 'urgent', dueOffset: -2, assignees: [OWNER] });
    await insertTask({ title: 'File complaint today before the clerk closes', matterId: mSolToday.id, status: 'open', priority: 'urgent', dueOffset: 0, dueHour: 16, assignees: [ATTY] });
    // Edge shapes.
    await insertTask({ title: 'Prepare the comprehensive pretrial statement including the stipulated facts, contested issues of law, witness list with anticipated testimony summaries, exhibit list with authentication foundations, and proposed jury instructions for the court', matterId: mBig.id, status: 'open', priority: 'high', dueOffset: 12, assignees: [OWNER, ATTY] });
    await insertTask({
      title: 'Trial prep checklist', matterId: mBig.id, status: 'in_progress', priority: 'urgent', dueOffset: 30, assignees: [OWNER, ATTY],
      description: 'Everything that has to be done before the final pretrial. Subtasks are in order.\n\n- Motions in limine are due 14 days before.\n- Exhibit binders: 3 copies plus one for the witness stand.\n- Confirm the interpreter for Dr. Solberg is NOT needed.',
      subtasks: [['Finalize witness list', true], ['Serve trial subpoenas', true], ['Prepare exhibit binders', true],
        ['Motions in limine', true], ['Jury instructions draft', false], ['Deposition designations', false],
        ['Expert prep session - Dr. Solberg', false], ['Client prep session', false], ['Order daily transcripts', false],
        ['Reserve war room', true], ['Demonstratives to vendor', false], ['Final settlement authority memo', false]],
    });
    await insertTask({ title: 'Call client back', matterId: mBig.id, status: 'open', priority: 'high', dueOffset: 0, dueHour: 15, assignees: [OWNER], end: [0, 15, 30] });
    // Tasks with an end: a block of time, a multi-day stretch, and one past midnight.
    await insertTask({ title: 'Deposition prep block - Dr. Solberg', matterId: mBig.id, status: 'open', priority: 'high', dueOffset: 2, dueHour: 9, assignees: [OWNER, ATTY], end: [0, 12, 0] });
    await insertTask({ title: 'Document review sprint (3 days)', matterId: mBig.id, status: 'in_progress', priority: 'medium', dueOffset: 5, assignees: [ATTY], end: 3 });
    await insertTask({ title: 'Overnight e-filing window', matterId: mAcme.id, status: 'open', priority: 'urgent', dueOffset: 4, dueHour: 22, assignees: [OWNER], end: [1, 1, 0] });
    await insertTask({ title: 'Client meeting prep', matterId: mLong.id, status: 'open', priority: 'medium', dueOffset: 1, dueHour: 13, assignees: [OWNER], end: [0, 14, 30] });
    await insertTask({ title: 'Ancient overdue task nobody closed', matterId: mBig.id, status: 'open', priority: 'low', dueOffset: -120, assignees: [ATTY] });
    await insertTask({ title: 'Renew malpractice insurance', matterId: null, status: 'open', priority: 'high', dueOffset: 365, assignees: [OWNER] });
    await insertTask({ title: 'Someday: reorganize the shared drive', matterId: null, status: 'open', priority: 'low', dueOffset: null, assignees: [] });
    await insertTask({ title: 'Blocked on court reporter invoice', matterId: mBig.id, status: 'blocked', priority: 'medium', dueOffset: -4, assignees: [ATTY] });
    await insertTask({ title: 'Unassigned intake follow-up', matterId: mNorth.id, status: 'open', priority: 'medium', dueOffset: 1, assignees: [] });
    await insertTask({ title: 'Tomorrow morning: confirm hearing room', matterId: mLong.id, status: 'open', priority: 'medium', dueOffset: 1, dueHour: 8, assignees: [OWNER] });
    await insertTask({ title: 'Ask interpreter availability (Vietnamese)', matterId: mViet.id, status: 'open', priority: 'medium', dueOffset: 3, assignees: [ATTY] });
    // A long task list on the big matter.
    for (let n = 0; n < 22; n++) {
      const dueOffset = int(-60, 60);
      await insertTask({
        title: `${pick(TASK_TITLES['Personal Injury'])} (${n + 1})`, matterId: mBig.id,
        status: dueOffset < -5 ? pick(['completed', 'completed', 'open']) : pick(['open', 'in_progress']),
        priority: pick(PRIORITIES), dueOffset, assignees: pick(ASSIGNEE_SETS),
      });
    }
    // A pile of firm-level tasks for the owner's "My tasks".
    for (let n = 0; n < 12; n++) {
      await insertTask({
        title: pick(['Review billing pre-bills', 'Approve time entries', 'Sign trust reconciliation', 'Update website bio',
          'Team meeting agenda', 'Return vendor call', 'CLE webinar', 'Check conflicts on new referral']),
        matterId: null, status: pick(['open', 'open', 'completed', 'in_progress']), priority: pick(PRIORITIES),
        dueOffset: int(-20, 40), assignees: [OWNER],
      });
    }

    // ── activities: time, expenses, flat fees ───────────────────────────────
    type Act = { id: string; kind: 'time' | 'expense' | 'flat_fee'; matterId: string | null; clientId: string | null;
      userId: string | null; date: number; name: string | null; desc: string; hours: number | null;
      rate: number | null; amount: number; codeId: string | null; billable: boolean };
    const acts: Act[] = [];
    const insertAct = async (a: Omit<Act, 'id' | 'amount'> & { vendor?: string | null }) => {
      const aid = idOf(G.activity);
      const amount = a.kind === 'time' ? Math.round((a.hours || 0) * (a.rate || 0)) : (a as any).charge;
      if (a.kind === 'time') {
        await q(
          `insert into activities (id, law_firm_id, kind, matter_id, client_id, user_id, activity_date, name, description,
                                   billable, hours, rate_cents, billing_code_id, source, created_by, created_at)
           values ($1,$2,'time',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$5,$13)`,
          [aid, FIRM, a.matterId, a.clientId, a.userId, day(a.date), a.name, a.desc, a.billable, a.hours, a.rate,
            a.codeId, et(a.date, 17)]
        );
      } else if (a.kind === 'expense') {
        await q(
          `insert into activities (id, law_firm_id, kind, matter_id, client_id, user_id, activity_date, description,
                                   billable, charge_cents, billing_code_id, vendor, created_by, created_at)
           values ($1,$2,'expense',$3,$4,$5,$6,$7,$8,$9,$10,$11,$5,$12)`,
          [aid, FIRM, a.matterId, a.clientId, a.userId, day(a.date), a.desc, a.billable, amount, a.codeId,
            a.vendor || null, et(a.date, 17)]
        );
      } else {
        await q(
          `insert into activities (id, law_firm_id, kind, matter_id, client_id, activity_date, description,
                                   billable, charge_cents, created_by, created_at)
           values ($1,$2,'flat_fee',$3,$4,$5,$6,$7,$8,$9,$10)`,
          [aid, FIRM, a.matterId, a.clientId, day(a.date), a.desc, a.billable, amount, OWNER, et(a.date, 17)]
        );
      }
      const row: Act = { ...a, id: aid, amount };
      acts.push(row);
      return row;
    };
    const timeFor = async (m: MatterRow, count: number, fromOffset: number, opts: { billable?: boolean } = {}) => {
      for (let n = 0; n < count; n++) {
        const uid = pick(m.members);
        const desc = pick(TIME_DESCS);
        await insertAct({
          kind: 'time', matterId: m.id, clientId: null, userId: uid, date: int(Math.max(fromOffset, m.openOffset), 0),
          name: desc.split(' ').slice(0, 3).join(' '), desc, hours: pick(HOURS), rate: rateOf(uid),
          codeId: desc.startsWith('Attend') ? CODE_COURT : uid === OWNER ? CODE_ATTY : CODE_PARA,
          billable: opts.billable ?? (m.billing !== 'pro_bono' && !chance(0.08)),
        });
      }
    };
    const expenseFor = async (m: MatterRow, count: number) => {
      for (let n = 0; n < count; n++) {
        const [desc, vendor, lo, hi] = pick(EXPENSES);
        await insertAct({
          kind: 'expense', matterId: m.id, clientId: null, userId: OWNER, date: int(Math.max(-200, m.openOffset), 0),
          name: null, desc, hours: null, rate: null, vendor: vendor || null, billable: true,
          codeId: desc.includes('filing') ? CODE_FILING : desc === 'Mileage' ? CODE_TRAVEL : desc.startsWith('Expert') ? CODE_EXPERT : CODE_COPY,
          charge: int(lo, hi),
        } as any);
      }
    };
    for (const m of generated) {
      if (m.status === 'pending') continue;
      if (m.billing === 'flat') {
        await insertAct({ kind: 'flat_fee', matterId: m.id, clientId: null, userId: null, date: m.openOffset + 1, name: null, desc: `${m.pa} flat-fee engagement`, hours: null, rate: null, codeId: null, billable: true, charge: int(15, 60) * 10000 } as any);
        await timeFor(m, int(1, 3), -180, { billable: false });
      } else {
        await timeFor(m, int(3, 10), -180);
      }
      if (chance(0.6)) await expenseFor(m, int(1, 3));
    }
    await timeFor(mOverBudget, 14, -120, { billable: true });
    await timeFor(mLong, 12, -300);
    await timeFor(mSplit, 9, -90);
    await timeFor(mPayOngoing, 8, -400);
    await timeFor(mAcme, 10, -75);
    await timeFor(mNorth, 4, -20);
    await timeFor(mProBono, 6, -40, { billable: false });
    await timeFor(mViet, 3, -50);
    await timeFor(mSol3, 2, -30);
    await timeFor(mBig, 60, -540);
    await expenseFor(mBig, 8);
    await expenseFor(mAcme, 2);
    await insertAct({ kind: 'flat_fee', matterId: mSean.id, clientId: null, userId: null, date: -64, name: null, desc: 'OVI defense through trial - flat fee', hours: null, rate: null, codeId: null, billable: true, charge: 500000 } as any);
    await insertAct({ kind: 'flat_fee', matterId: mAcme.id, clientId: null, userId: null, date: -70, name: null, desc: 'Fleet acquisition - closing fixed fee', hours: null, rate: null, codeId: null, billable: true, charge: 12500000 } as any);
    // Odd sizes: the smallest increment, a full day, and a long description.
    await insertAct({ kind: 'time', matterId: mBig.id, clientId: null, userId: OWNER, date: 0, name: 'Quick email', desc: 'Read and file email from adjuster', hours: 0.1, rate: 35000, codeId: CODE_ATTY, billable: true });
    await insertAct({ kind: 'time', matterId: mBig.id, clientId: null, userId: ATTY, date: -1, name: 'Trial prep marathon', desc: 'Full-day trial preparation session: exhibit review, witness outlines, demonstratives, and jury instructions', hours: 12, rate: 27500, codeId: CODE_ATTY, billable: true });
    await insertAct({ kind: 'time', matterId: mLong.id, clientId: null, userId: OWNER, date: -2, name: 'Forensic accountant conference', desc: 'Lengthy conference with the forensic accountant regarding the valuation methodology for both closely held businesses, the appropriate valuation date given the parties\' separation timeline, the treatment of the deferred compensation plan, and the tracing analysis for the disputed inheritance funds, followed by a summary email to the client outlining next steps and anticipated costs.', hours: 2.3, rate: 35000, codeId: CODE_ATTY, billable: true });
    // Client-level work, billed on a client invoice rather than a matter one.
    for (const [n, [desc, hours]] of ([['General corporate advice call', 1.0], ['Board minutes review', 1.6], ['Annual compliance checklist', 2.2]] as [string, number][]).entries()) {
      await insertAct({ kind: 'time', matterId: null, clientId: coAcme.id, userId: OWNER, date: -40 + n * 5, name: desc, desc, hours, rate: 35000, codeId: CODE_ATTY, billable: true });
    }

    // ── invoices ────────────────────────────────────────────────────────────
    let invoiceSeq = 2000;
    let lineCount = 0;
    let paymentCount = 0;
    const invoiceSummary: [string, string, number, number][] = [];
    type Payment = { amount: number; offset: number; source: string; note: string; trustTxnId?: string | null; trustAcctId?: string | null };
    type Credit = { amount: number; kind: 'write_off' | 'discount' | 'adjustment'; desc: string };
    const insertInvoice = async (inv: {
      matter?: MatterRow | null; clientContextId?: string | null; billToClientId?: string | null; lines: Act[];
      invOffset: number; dueOffset: number; payments?: Payment[]; credits?: Credit[]; voided?: boolean;
      isPaid?: boolean; name?: string | null; plan?: { installment: number; frequency: number; startOffset: number;
        down: number; schedule: { offset: number; amount: number; status: 'paid' | 'pending' | 'unpaid'; down?: boolean }[] };
    }) => {
      const iid = idOf(G.invoice);
      invoiceSeq += 1;
      const number = `SCN-${invoiceSeq}`;
      const total = inv.lines.reduce((s, a) => s + a.amount, 0);
      const hours = inv.lines.reduce((s, a) => s + (a.kind === 'time' ? a.hours || 0 : 0), 0);
      const flat = inv.lines.reduce((s, a) => s + (a.kind === 'flat_fee' ? a.amount : 0), 0);
      const payments = inv.payments || [];
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      const credits = inv.credits || [];
      const writtenOff = credits.reduce((s, c) => s + c.amount, 0);
      const nextPayment = inv.plan?.schedule.find((s) => s.status !== 'paid')?.offset;
      const isPaid = inv.isPaid ?? (paid >= total && writtenOff === 0 && total > 0);
      const status = inv.voided ? 'voided' : deriveStatus({
        total, paid, writtenOff, credits: credits.length, isPaid, due: day(inv.dueOffset),
        nextPayment: nextPayment == null ? null : day(nextPayment),
      });
      const clientId = inv.billToClientId ?? inv.matter?.clientIds[0] ?? inv.clientContextId ?? null;
      await q(
        `insert into invoices (id, law_firm_id, matter_id, client_context_id, client_id, context_type, invoice_number,
                               invoice_name, status, invoice_date, due_date, total_cents, flat_fees_amount_cents,
                               total_hours, amount_paid_cents, total_written_off_cents, is_paid, paid_date,
                               next_payment_date, payment_plan_enabled, plan_installment_cents, plan_frequency_days,
                               plan_start_date, plan_down_payment_cents, notes, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [iid, FIRM, inv.matter?.id ?? null, inv.clientContextId ?? null, clientId,
          inv.matter ? 'matter' : 'client', number, inv.name ?? null, status, day(inv.invOffset), day(inv.dueOffset),
          total, flat, hours ? Math.round(hours * 100) / 100 : null, paid, writtenOff, isPaid,
          isPaid && payments.length ? `${day(payments[payments.length - 1].offset)}T12:00:00.000Z` : null,
          nextPayment == null ? null : day(nextPayment), Boolean(inv.plan), inv.plan?.installment ?? null,
          inv.plan?.frequency ?? null, inv.plan ? day(inv.plan.startOffset) : null, inv.plan?.down ?? null,
          inv.voided ? 'Voided: issued against the wrong matter.' : null, OWNER, et(inv.invOffset, 10)]
      );
      for (const [n, a] of inv.lines.entries()) {
        await q(
          `insert into invoice_line_items (id, invoice_id, law_firm_id, kind, sort_order, source_id, name, description,
                                           line_date, quantity, rate_cents, amount_cents, user_id, user_name, charge_code_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [idOf(G.line), iid, FIRM, a.kind === 'time' ? 'time_entry' : a.kind, n, a.id, a.kind === 'time' ? a.name : null,
            a.desc, day(a.date), a.kind === 'time' ? a.hours : 1, a.kind === 'time' ? a.rate : a.amount, a.amount,
            a.userId, a.userId ? nameOf(a.userId) : null, a.codeId]
        );
        lineCount += 1;
      }
      // payment_source is 'trust', 'stripe' or null (a manually recorded payment),
      // matching what the app writes; the method a person would record goes in the note.
      for (const [n, p] of payments.entries()) {
        await q(
          `insert into invoice_payments (id, invoice_id, law_firm_id, sort_order, amount_cents, payment_date, payment_source,
                                         note, recorded_by, invoice_number, trust_transaction_id, trust_account_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [idOf(G.payment), iid, FIRM, n, p.amount, day(p.offset), p.trustTxnId ? 'trust' : null,
            `${p.note} (${p.source.replace('_', ' ')})`, OWNER, number,
            p.trustTxnId ?? null, p.trustAcctId ?? null]
        );
        paymentCount += 1;
      }
      for (const [n, c] of credits.entries()) {
        await q(
          `insert into invoice_adjustments (id, law_firm_id, invoice_id, direction, kind, amount_cents, description, sort_order, created_by)
           values ($1,$2,$3,'credit',$4,$5,$6,$7,$8)`,
          [idOf(G.adjustment), FIRM, iid, c.kind, c.amount, c.desc, n, OWNER]
        );
      }
      for (const [n, s] of (inv.plan?.schedule || []).entries()) {
        const paymentIndex = s.status === 'paid' ? inv.plan!.schedule.slice(0, n).filter((x) => x.status === 'paid').length : null;
        await q(
          `insert into invoice_expected_payments (id, invoice_id, law_firm_id, sort_order, installment_id, due_date,
                                                  amount_cents, status, matched_payment_index, is_down_payment)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [idOf(G.expected), iid, FIRM, n, `inst_${frag}${String(n).padStart(4, '0')}`, day(s.offset), s.amount,
            s.status, paymentIndex, Boolean(s.down)]
        );
      }
      invoiceSummary.push([number, status, total, paid]);
      return { id: iid, number, total, status };
    };

    // Bill the oldest billable work on a matter, leaving the newest unbilled.
    const billable = (m: MatterRow, max: number, beforeOffset = -15) =>
      acts.filter((a) => a.matterId === m.id && a.billable && a.date < beforeOffset && !billed.has(a.id))
        .sort((x, y) => x.date - y.date).slice(0, max);
    const billed = new Set<string>();
    const take = (lines: Act[]) => { lines.forEach((a) => billed.add(a.id)); return lines; };

    const SCENARIOS = ['paid', 'outstanding', 'overdue', 'partial', 'overdue_old', 'credited', 'discounted', 'voided', 'paid_two'];
    let scenarioIdx = 0;
    for (const m of generated) {
      if (m.billing === 'pro_bono') continue;
      const lines = billable(m, 8);
      if (lines.length < 2) continue;
      take(lines);
      const total = lines.reduce((s, a) => s + a.amount, 0);
      const scenario = SCENARIOS[scenarioIdx++ % SCENARIOS.length];
      const base = { matter: m, lines };
      switch (scenario) {
        case 'paid':
          await insertInvoice({ ...base, invOffset: -60, dueOffset: -30, payments: [{ amount: total, offset: -35, source: 'check', note: `Check #${int(1000, 9999)}` }] });
          break;
        case 'paid_two':
          await insertInvoice({ ...base, invOffset: -90, dueOffset: -60, payments: [
            { amount: Math.round(total / 2), offset: -70, source: 'credit_card', note: 'Card ending 4242' },
            { amount: total - Math.round(total / 2), offset: -50, source: 'ach', note: 'ACH transfer' }] });
          break;
        case 'outstanding':
          await insertInvoice({ ...base, invOffset: -5, dueOffset: 25 });
          break;
        case 'overdue':
          await insertInvoice({ ...base, invOffset: -40, dueOffset: -10 });
          break;
        case 'overdue_old':
          await insertInvoice({ ...base, invOffset: -150, dueOffset: -120 });
          break;
        case 'partial':
          await insertInvoice({ ...base, invOffset: -30, dueOffset: 0, payments: [
            { amount: Math.round(total * 0.3), offset: -20, source: 'check', note: 'Partial payment' },
            { amount: Math.round(total * 0.2), offset: -6, source: 'cash', note: 'Cash at office' }] });
          break;
        case 'credited':
          await insertInvoice({ ...base, invOffset: -100, dueOffset: -70,
            payments: [{ amount: Math.round(total * 0.4), offset: -80, source: 'check', note: 'Final payment the client could make' }],
            credits: [{ amount: total - Math.round(total * 0.4), kind: 'write_off', desc: 'Balance written off as uncollectible' }] });
          break;
        case 'discounted':
          await insertInvoice({ ...base, invOffset: -12, dueOffset: 18,
            credits: [{ amount: Math.round(total * 0.1), kind: 'discount', desc: '10% courtesy discount' }] });
          break;
        case 'voided':
          await insertInvoice({ ...base, invOffset: -25, dueOffset: 5, voided: true });
          // The void freed its lines, so they can be billed again.
          lines.forEach((a) => billed.delete(a.id));
          break;
      }
    }

    // The edge-case invoices.
    // Forty lines on one invoice.
    const bigLines = take(acts.filter((a) => a.matterId === mBig.id && a.billable && a.date < -30).sort((x, y) => x.date - y.date).slice(0, 40));
    const bigInvoice = await insertInvoice({ matter: mBig, lines: bigLines, invOffset: -28, dueOffset: 2, name: 'Pre-trial fees through last month' });
    // A blown budget, billed and overdue.
    await insertInvoice({ matter: mOverBudget, lines: take(billable(mOverBudget, 10, -5)), invOffset: -20, dueOffset: -5 });
    // A three-way split matter, partly paid by one sibling.
    const splitLines = take(billable(mSplit, 6, -5));
    await insertInvoice({ matter: mSplit, lines: splitLines, invOffset: -18, dueOffset: 12,
      payments: [{ amount: Math.round(splitLines.reduce((s, a) => s + a.amount, 0) * 0.5), offset: -10, source: 'check', note: 'Paid by the 50% sibling' }] });
    // A payment plan with a down payment, two paid installments and one missed.
    const planLines = take(billable(mPayOngoing, 8, -60));
    const planTotal = planLines.reduce((s, a) => s + a.amount, 0);
    const down = Math.round(planTotal * 0.2);
    const inst = Math.round((planTotal - down) / 4);
    await insertInvoice({
      matter: mPayOngoing, lines: planLines, invOffset: -100, dueOffset: 50,
      payments: [
        { amount: down, offset: -95, source: 'check', note: 'Down payment' },
        { amount: inst, offset: -65, source: 'ach', note: 'Installment 1' },
        { amount: inst, offset: -35, source: 'ach', note: 'Installment 2' },
      ],
      plan: { installment: inst, frequency: 30, startOffset: -65, down, schedule: [
        { offset: -95, amount: down, status: 'paid', down: true },
        { offset: -65, amount: inst, status: 'paid' },
        { offset: -35, amount: inst, status: 'paid' },
        { offset: -5, amount: inst, status: 'unpaid' },
        { offset: 25, amount: planTotal - down - inst * 3, status: 'pending' },
      ] },
    });
    // A large fixed fee for an organization, unpaid.
    await insertInvoice({ matter: mAcme, lines: take(acts.filter((a) => a.matterId === mAcme.id && a.kind === 'flat_fee')), invOffset: -3, dueOffset: 27, name: 'Fleet acquisition - closing' });
    // Client-level (no matter) invoice for an organization.
    await insertInvoice({ clientContextId: coAcme.id, lines: take(acts.filter((a) => a.clientId === coAcme.id)), invOffset: -8, dueOffset: 22, name: 'General corporate - Q3' });
    // Fully written off without a cent collected.
    const woLines = take(billable(mLong, 3, -100));
    await insertInvoice({ matter: mLong, lines: woLines, invOffset: -200, dueOffset: -170,
      credits: [{ amount: woLines.reduce((s, a) => s + a.amount, 0), kind: 'write_off', desc: 'Written off: billing error on retainer application' }] });

    // ── trust accounting ────────────────────────────────────────────────────
    const acctLit = idOf(G.trustAcct);
    const acctSettle = idOf(G.trustAcct);
    const acctOld = idOf(G.trustAcct);
    const trustAccounts: [string, string, string, string, string, string][] = [
      [acctLit, 'IOLTA - Litigation Retainers', 'JPMorgan Chase', '9031', 'iolta', 'active'],
      [acctSettle, 'Settlement Trust', 'PNC Bank', '5582', 'trust', 'active'],
      [acctOld, 'Old IOLTA - Fifth Third (closed)', 'Fifth Third Bank', '1177', 'iolta', 'inactive'],
    ];
    for (const [aid, name, bank, last4, type, status] of trustAccounts) {
      await q(
        `insert into trust_accounts (id, law_firm_id, name, bank_name, account_number_last4, account_type,
                                     interest_beneficiary, status, book_balance_cents, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)`,
        [aid, FIRM, name, bank, last4, type, type === 'iolta' ? 'bar_foundation' : 'client', status, OWNER]
      );
    }
    type Txn = { acct: string; type: string; amount: number; clientId: string; matterId: string | null; offset: number;
      desc: string; source: string; ref: string; payee?: string | null; status?: string; invoiceId?: string | null;
      transferTo?: string | null; voidReason?: string | null };
    const txns: (Txn & { id: string })[] = [];
    const addTxn = (t: Txn) => { const row = { ...t, id: idOf(G.trustTxn) }; txns.push(row); return row.id; };

    // Retainers for a dozen generated matters, a few partly drawn down.
    for (const m of generated.filter((g) => g.clientIds.length && g.billing === 'hourly' && g.status === 'active').slice(0, 12)) {
      const deposit = int(10, 80) * 10000;
      addTxn({ acct: acctLit, type: 'deposit', amount: deposit, clientId: m.clientIds[0], matterId: m.id, offset: m.openOffset + 2 > 0 ? -1 : m.openOffset + 2, desc: 'Initial retainer', source: pick(['check', 'wire', 'ach', 'credit_card']), ref: `DEP-${int(10000, 99999)}` });
      if (chance(0.5)) {
        addTxn({ acct: acctLit, type: 'withdrawal', amount: Math.round(deposit * 0.35), clientId: m.clientIds[0], matterId: m.id, offset: -int(1, 20), desc: 'Applied to fees', source: 'check', ref: `CHK-${int(3000, 3999)}` });
      }
    }
    // The low-balance client: $2,500 in, $2,487.50 out.
    addTxn({ acct: acctLit, type: 'deposit', amount: 250000, clientId: mOverBudget.clientIds[0], matterId: mOverBudget.id, offset: -110, desc: 'Retainer', source: 'check', ref: 'CHK-IN-5520' });
    addTxn({ acct: acctLit, type: 'withdrawal', amount: 248750, clientId: mOverBudget.clientIds[0], matterId: mOverBudget.id, offset: -30, desc: 'Applied to fees - retainer nearly exhausted', source: 'check', ref: 'CHK-3101' });
    // Not yet settled and voided: both are shown on the ledger but count for nothing.
    addTxn({ acct: acctLit, type: 'deposit', amount: 500000, clientId: mNorth.clientIds[0], matterId: mNorth.id, offset: -1, desc: 'Retainer - ACH still clearing', source: 'ach', ref: 'ACH-PENDING-01', status: 'pending' });
    addTxn({ acct: acctLit, type: 'deposit', amount: 300000, clientId: mSplit.clientIds[1], matterId: mSplit.id, offset: -40, desc: 'Retainer - check bounced', source: 'check', ref: 'CHK-IN-7781', status: 'void', voidReason: 'Returned for insufficient funds' });
    // A retainer returned in full when the client went elsewhere.
    const refunded = generated.find((g) => g.status === 'closed')!;
    addTxn({ acct: acctLit, type: 'deposit', amount: 300000, clientId: refunded.clientIds[0], matterId: refunded.id, offset: -200, desc: 'Retainer', source: 'wire', ref: 'WIRE-60231' });
    addTxn({ acct: acctLit, type: 'refund', amount: 300000, clientId: refunded.clientIds[0], matterId: refunded.id, offset: -150, desc: 'Unused retainer returned to client', source: 'check', ref: 'CHK-3050', payee: 'Client' });
    // Acme's large fixed fee is half funded from trust; the payment is tied to the withdrawal.
    addTxn({ acct: acctLit, type: 'deposit', amount: 10000000, clientId: coAcme.id, matterId: mAcme.id, offset: -72, desc: 'Closing escrow retainer', source: 'wire', ref: 'WIRE-88001' });
    // The settlement: in, lien, fee to operating, client distribution, holdback left.
    const bigClient = mBig.clientIds[0];
    addTxn({ acct: acctSettle, type: 'deposit', amount: 15000000, clientId: bigClient, matterId: mBig.id, offset: -14, desc: 'Settlement proceeds - Great West Casualty', source: 'wire', ref: 'WIRE-GWC-2210' });
    addTxn({ acct: acctSettle, type: 'withdrawal', amount: 1850000, clientId: bigClient, matterId: mBig.id, offset: -10, desc: 'Medical lien payoff', source: 'check', ref: 'CHK-S-1001', payee: 'OhioHealth Recovery Services' });
    addTxn({ acct: acctSettle, type: 'transfer', amount: 5000000, clientId: bigClient, matterId: mBig.id, offset: -9, desc: 'Earned attorney fee per settlement statement', source: 'other', ref: 'XFER-OP-0091', transferTo: 'operating' });
    addTxn({ acct: acctSettle, type: 'withdrawal', amount: 7650000, clientId: bigClient, matterId: mBig.id, offset: -7, desc: 'Client net distribution', source: 'check', ref: 'CHK-S-1002', payee: people32[11].name });
    // Big matter invoice paid in part from the held-back balance.
    const bigPayTxn = addTxn({ acct: acctSettle, type: 'withdrawal', amount: 250000, clientId: bigClient, matterId: mBig.id, offset: -5, desc: `Applied to invoice ${bigInvoice.number}`, source: 'other', ref: 'XFER-INV-0001', invoiceId: bigInvoice.id });
    // The closed account: funded once, moved out, zero now.
    addTxn({ acct: acctOld, type: 'deposit', amount: 420000, clientId: people32[12].id, matterId: null, offset: -900, desc: 'Legacy retainer', source: 'check', ref: 'CHK-OLD-77' });
    addTxn({ acct: acctOld, type: 'transfer', amount: 420000, clientId: people32[12].id, matterId: null, offset: -800, desc: 'Moved to new IOLTA at account closure', source: 'other', ref: 'XFER-CLOSE', transferTo: 'other' });

    // Running balances per account and per client-in-account, completed rows only.
    const acctBal = new Map<string, number>();
    const clientBal = new Map<string, number>();
    for (const t of [...txns].sort((x, y) => x.offset - y.offset)) {
      const counts = (t.status || 'completed') === 'completed';
      const delta = counts ? (t.type === 'deposit' ? t.amount : -t.amount) : 0;
      const ab = (acctBal.get(t.acct) || 0) + delta;
      const ck = `${t.acct}:${t.clientId}`;
      const cb = (clientBal.get(ck) || 0) + delta;
      acctBal.set(t.acct, ab);
      clientBal.set(ck, cb);
      await q(
        `insert into trust_transactions (id, law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id,
                                         txn_date, description, reference_number, payee, transfer_to, source, status,
                                         invoice_id, client_balance_after_cents, account_balance_after_cents,
                                         voided_by, voided_at, void_reason, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [t.id, FIRM, t.acct, t.type, t.amount, t.clientId, t.matterId, day(t.offset), t.desc, t.ref, t.payee ?? null,
          t.transferTo ?? null, t.source, t.status || 'completed', t.invoiceId ?? null, counts ? cb : null, counts ? ab : null,
          t.status === 'void' ? OWNER : null, t.status === 'void' ? et(t.offset + 3, 10) : null, t.voidReason ?? null,
          OWNER, et(t.offset, 11)]
      );
    }
    for (const [aid, bal] of acctBal) {
      await q('update trust_accounts set book_balance_cents = $1 where id = $2', [bal, aid]);
    }
    // Record the trust-funded payment on the big invoice now that its withdrawal exists.
    await q(
      `insert into invoice_payments (id, invoice_id, law_firm_id, sort_order, amount_cents, payment_date, payment_source,
                                     note, recorded_by, invoice_number, trust_transaction_id, trust_account_id)
       values ($1,$2,$3,0,250000,$4,'trust','Paid from settlement trust',$5,$6,$7,$8)`,
      [idOf(G.payment), bigInvoice.id, FIRM, day(-5), OWNER, bigInvoice.number, bigPayTxn, acctSettle]
    );
    paymentCount += 1;
    {
      const bigStatus = deriveStatus({ total: bigInvoice.total, paid: 250000, writtenOff: 0, credits: 0, isPaid: false, due: day(2), nextPayment: null });
      await q('update invoices set amount_paid_cents = 250000, status = $1 where id = $2', [bigStatus, bigInvoice.id]);
      const row = invoiceSummary.find((r) => r[0] === bigInvoice.number)!;
      row[1] = bigStatus;
      row[3] = 250000;
    }

    // ── calendar ────────────────────────────────────────────────────────────
    let eventCount = 0;
    const insertEvent = async (e: {
      matterId?: string | null; clientId?: string | null; type: string; title: string; start: string; end: string | null;
      allDay?: boolean; location?: string | null; status?: string; notes?: string | null; assignees?: string[];
      cancelReason?: string | null;
    }) => {
      const eid = idOf(G.event);
      await q(
        `insert into events (id, law_firm_id, matter_id, client_id, type, title, notes, date, ends_at, all_day,
                             location_name, status, cancellation_reason, cancelled_by, cancelled_at, time_zone,
                             created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'America/New_York',$16,now())`,
        [eid, FIRM, e.matterId ?? null, e.clientId ?? null, e.type, e.title, e.notes ?? null, e.start, e.end,
          Boolean(e.allDay), e.location ?? null, e.status || 'upcoming', e.cancelReason ?? null,
          e.status === 'cancelled' ? OWNER : null, e.status === 'cancelled' ? et(-1, 10) : null, OWNER]
      );
      for (const uid of e.assignees || [OWNER]) {
        await q('insert into event_assignees (law_firm_id, event_id, user_id) values ($1,$2,$3)', [FIRM, eid, uid]);
      }
      eventCount += 1;
    };
    const LOCATIONS = ['Franklin County Courthouse, Courtroom 6A', 'Office - Conference Room B', 'Zoom', 'Opposing counsel office', 'Montgomery County Courthouse', null];
    for (const m of generated.filter((g) => !['completed', 'closed', 'archived'].includes(g.status))) {
      for (let n = 0; n < int(1, 3); n++) {
        const offset = int(-45, 90);
        const hour = int(8, 16);
        const type = pick(EVENT_TYPES);
        const deadline = type === 'filing_deadline';
        await insertEvent({
          matterId: m.id, type, title: `${type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())} - ${m.name}`,
          start: et(offset, deadline ? 17 : hour), end: deadline ? null : et(offset, hour + int(1, 2)),
          location: deadline ? null : pick(LOCATIONS),
          status: offset < 0 ? (chance(0.8) ? 'completed' : 'upcoming') : chance(0.07) ? 'cancelled' : 'upcoming',
          cancelReason: 'Continued by the court',
          assignees: pick([[OWNER], [ATTY], [OWNER, ATTY]]),
        });
      }
    }
    // A crowded tomorrow: five overlapping 9am items plus the rest of the day.
    for (const [n, title] of ['Status conference - Patel', 'Call with adjuster Mendes', 'Team huddle', 'Deposition prep - Dr. Solberg', 'Intake call - new referral'].entries()) {
      await insertEvent({ matterId: n === 2 || n === 4 ? null : mBig.id, clientId: n === 2 || n === 4 ? people32[13 + n].id : null, type: n === 0 ? 'court_date' : 'meeting', title, start: et(1, 9, n * 10), end: et(1, 10, n * 10), location: n === 0 ? 'Franklin County Courthouse, Courtroom 6A' : 'Zoom', assignees: n % 2 ? [ATTY] : [OWNER, ATTY] });
    }
    for (const [h, title] of ([[11, 'Mediation call - Castellano siblings'], [13, 'Lunch with referral source'], [14, 'Hearing - temporary orders'], [16, 'Client signing - trust documents']] as [number, string][])) {
      await insertEvent({ matterId: title.includes('Castellano') ? mSplit.id : title.includes('Hearing') ? mLong.id : null, clientId: title.includes('Lunch') || title.includes('signing') ? people32[20].id : null, type: title.includes('Hearing') ? 'hearing' : 'meeting', title, start: et(1, h), end: et(1, h + 1) });
    }
    // Today, so the dashboard has something now, later and already over.
    await insertEvent({ matterId: mBig.id, type: 'meeting', title: 'Morning case review - Patel', start: et(0, 8), end: et(0, 9), location: 'Office - Conference Room B' });
    await insertEvent({ matterId: mSolToday.id, type: 'filing_deadline', title: 'Complaint must be filed TODAY', start: et(0, 17), end: null });
    await insertEvent({ matterId: mLong.id, type: 'meeting', title: 'Call with forensic accountant', start: et(0, 15), end: et(0, 16, 30), location: 'Phone' });
    // All-day and multi-day.
    await insertEvent({ matterId: mBig.id, type: 'trial', title: 'Jury trial - Patel v. Buckeye Freight Lines', start: et(30, 9), end: et(33, 17), location: 'Franklin County Courthouse, Courtroom 6A', assignees: [OWNER, ATTY], notes: 'Four-day trial. War room booked at the Hilton across the street.' });
    await insertEvent({ matterId: mLong.id, type: 'other', title: 'Custody evaluation home visit window', start: dayAnchor(6), end: dayAnchor(9), allDay: true });
    await insertEvent({ matterId: mSplit.id, type: 'other', title: 'Farm appraisal (all day)', start: dayAnchor(4), end: dayAnchor(5), allDay: true });
    await insertEvent({ clientId: coAcme.id, type: 'meeting', title: 'Acme annual meeting', start: dayAnchor(10), end: dayAnchor(11), allDay: true });
    // Odd hours.
    await insertEvent({ matterId: mSean.id, type: 'meeting', title: 'Jail visit - late slot', start: et(2, 21, 30), end: et(2, 22, 45), location: 'Franklin County Jail' });
    await insertEvent({ matterId: mAcme.id, type: 'meeting', title: 'Overnight closing call (crosses midnight)', start: et(5, 23), end: et(6, 1), location: 'Zoom' });
    await insertEvent({ matterId: mAcme.id, type: 'meeting', title: 'Quick check-in', start: et(3, 10), end: et(3, 10, 15) });
    // Cancelled and completed history on the big matter.
    await insertEvent({ matterId: mBig.id, type: 'deposition', title: 'Deposition of driver - CANCELLED', start: et(-3, 10), end: et(-3, 13), status: 'cancelled', cancelReason: 'Witness unavailable, rescheduling', location: 'Harcourt Simmons LLP' });
    await insertEvent({ matterId: mBig.id, type: 'deposition', title: 'Deposition of driver (rescheduled)', start: et(8, 10), end: et(8, 13), location: 'Harcourt Simmons LLP', assignees: [OWNER, ATTY] });
    for (let n = 1; n <= 8; n++) {
      await insertEvent({ matterId: mBig.id, type: pick(['hearing', 'meeting', 'deposition']), title: `Past ${pick(['hearing', 'meeting', 'deposition'])} #${n}`, start: et(-n * 20, 10), end: et(-n * 20, 11), status: 'completed' });
    }
    // Statute dates as calendar items for the three SOL matters.
    for (const [m, offset] of [[mSol3, 3], [mSolPast, -2], [mSolToday, 0]] as [MatterRow, number][]) {
      await insertEvent({ matterId: m.id, type: 'statute_of_limitations', title: `Statute of limitations - ${m.name}`, start: et(offset, 17), end: null });
    }
    // Client-level events (no matter).
    for (let n = 0; n < 6; n++) {
      const c = people32[14 + n];
      const offset = int(-20, 30);
      await insertEvent({ clientId: c.id, type: 'meeting', title: `Consultation - ${c.name}`, start: et(offset, 10 + (n % 5)), end: et(offset, 11 + (n % 5)), location: 'Office', status: offset < 0 ? 'completed' : 'upcoming' });
    }

    // ── messaging ───────────────────────────────────────────────────────────
    let messageCount = 0;
    const insertConversation = async (c: { title: string; matter: MatterRow; offset: number; archived?: boolean; ownerReadOffset?: number }) => {
      const cid = idOf(G.conv);
      await q(
        `insert into conversations (id, law_firm_id, conversation_type, title, matter_id, created_by, last_message_at,
                                    last_sender_user_id, archived_at, archived_by, created_at)
         values ($1,$2,'group',$3,$4,$5,$6,$5,$7,$8,$9)`,
        [cid, FIRM, c.title, c.matter.id, OWNER, et(c.offset, 9), c.archived ? et(-2, 10) : null, c.archived ? OWNER : null, et(c.offset, 9)]
      );
      for (const uid of new Set([OWNER, ATTY])) {
        await q(
          `insert into conversation_participants (id, conversation_id, law_firm_id, participant_user_id, participant_type,
                                                  added_by, added_at, last_read_at)
           values ($1,$2,$3,$4,'firm_member',$5,$6,$7)`,
          [idOf(G.participant), cid, FIRM, uid, OWNER, et(c.offset, 9),
            uid === OWNER && c.ownerReadOffset != null ? et(c.ownerReadOffset, 8) : et(0, 23)]
        );
      }
      await q(
        `insert into conversation_matters (conversation_id, law_firm_id, matter_id, position, created_at)
         values ($1,$2,$3,0,$4)`,
        [cid, FIRM, c.matter.id, et(c.offset, 9)]
      );
      return cid;
    };
    const insertMessage = async (convId: string, matterId: string, sender: string, content: string, at: string, extra: { edited?: boolean; deleted?: boolean } = {}) => {
      await q(
        `insert into messages (id, law_firm_id, conversation_id, sender_user_id, content, sender_type, sender_name,
                               read_by_firm, matter_id, status, kind, edited_at, deleted_at, deleted_by, created_at)
         values ($1,$2,$3,$4,$5,'firm_member',$6,true,$7,'sent','user',$8,$9,$10,$11)`,
        [idOf(G.msg), FIRM, convId, sender, content, nameOf(sender), matterId,
          extra.edited ? at : null, extra.deleted ? at : null, extra.deleted ? sender : null, at]
      );
      messageCount += 1;
    };
    // 120 messages over two months; the owner last read two days ago.
    const bigConv = await insertConversation({ title: 'Patel trial team', matter: mBig, offset: -60, ownerReadOffset: -2 });
    let lastAt = '';
    for (let n = 0; n < 120; n++) {
      const offset = -60 + Math.floor(n / 2);
      const sender = n % 3 === 0 ? OWNER : ATTY;
      lastAt = et(offset, 8 + (n % 9), (n * 7) % 60);
      await insertMessage(bigConv, mBig.id, sender, pick(MESSAGE_LINES), lastAt, { edited: n === 40, deleted: n === 77 });
    }
    await insertMessage(bigConv, mBig.id, ATTY, 'Long one, sorry. ' + 'Here is where everything stands before trial: the driver deposition is rescheduled, Dr. Solberg confirmed for the 2nd day, exhibit binders are at the vendor, and the motions in limine are drafted but need your review. The defense still has not answered our supplemental interrogatories and I think we need to file a motion to compel this week or we lose the ability to use the answers at trial. '.repeat(4), et(0, 7));
    await q('update conversations set last_message_at = $1, last_sender_user_id = $2 where id = $3', [et(0, 7), ATTY, bigConv]);
    const splitConv = await insertConversation({ title: 'Castellano partition - internal', matter: mSplit, offset: -20 });
    for (let n = 0; n < 6; n++) {
      await insertMessage(splitConv, mSplit.id, n % 2 ? ATTY : OWNER, pick(MESSAGE_LINES), et(-20 + n * 3, 11));
    }
    await q('update conversations set last_message_at = $1 where id = $2', [et(-5, 11), splitConv]);
    const oldConv = await insertConversation({ title: 'Post-decree payment plan (archived)', matter: mPayOngoing, offset: -90, archived: true });
    await insertMessage(oldConv, mPayOngoing.id, OWNER, 'Payment plan set up. Archiving this thread.', et(-90, 9));
    const oneConv = await insertConversation({ title: 'Acme - quick question', matter: mAcme, offset: -1, ownerReadOffset: -3 });
    await insertMessage(oneConv, mAcme.id, ATTY, 'Do we have the signed LOI yet? 📎', et(-1, 9));

    // ── notes ───────────────────────────────────────────────────────────────
    let noteCount = 0;
    const insertNote = async (n: { matterId?: string | null; clientId?: string | null; subject: string; content: string; offset: number; author?: string; pinned?: boolean; retracted?: boolean; type?: string }) => {
      const author = n.author || OWNER;
      await q(
        `insert into notes (id, law_firm_id, matter_id, client_id, subject, content, note_type, created_by, note_date,
                            pinned_at, pinned_by, retracted_at, retracted_by, retraction_reason, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [idOf(G.note), FIRM, n.matterId ?? null, n.clientId ?? null, n.subject, n.content, n.type || 'general', author,
          day(n.offset), n.pinned ? et(n.offset, 12) : null, n.pinned ? author : null,
          n.retracted ? et(n.offset + 1, 9) : null, n.retracted ? author : null, n.retracted ? 'Entered on the wrong matter' : null,
          et(n.offset, 11)]
      );
      noteCount += 1;
    };
    await insertNote({ matterId: mBig.id, subject: 'READ FIRST - case summary', content: 'Liability is strong (driver cited, ELD logs show HOS violation). Damages: two lumbar surgeries, future care plan $1.2M. Defense theme will be pre-existing degeneration. Settlement authority from client: do not go below $150k without a call.', offset: -200, pinned: true });
    await insertNote({ matterId: mBig.id, subject: 'Wrong matter', content: 'This note was meant for the Castellano file.', offset: -30, retracted: true });
    await insertNote({ matterId: mBig.id, subject: 'Deposition summary - corporate rep', content: Array.from({ length: 12 }, (_, i) => `${i + 1}. ${pick(['Witness confirmed the dispatch policy was not followed.', 'Witness could not recall the maintenance schedule.', 'Witness admitted the ELD was unplugged for 3 hours.', 'Objection to form; witness answered.', 'Counsel instructed not to answer on privilege grounds.'])}`).join('\n'), offset: -45, author: ATTY });
    for (let n = 0; n < 14; n++) {
      await insertNote({ matterId: mBig.id, subject: pick(['Call with client', 'Adjuster update', 'Research note', 'Strategy', 'Voicemail']), content: pick(MESSAGE_LINES), offset: -int(1, 500), author: pick([OWNER, ATTY]) });
    }
    for (const m of generated.slice(0, 20)) {
      await insertNote({ matterId: m.id, subject: 'Intake notes', content: `Initial consultation with the client. ${pick(['Strong case.', 'Needs more documentation.', 'Client is anxious about cost.', 'Conflict check cleared.'])}`, offset: m.openOffset });
    }
    await insertNote({ clientId: cLong.id, subject: 'Client preferences', content: 'Prefers email only. Do not call the work number. Spouse is opposing party; never leave voicemail at home.', offset: -100, pinned: true });
    await insertNote({ clientId: coAcme.id, subject: 'Billing contact', content: 'Invoices go to the CFO, copy General Counsel.', offset: -60 });

    // ── leads ───────────────────────────────────────────────────────────────
    let leadCount = 0;
    if (leadStages.length) {
      const open = leadStages.filter((s: any) => !s.is_closed);
      const closed = leadStages.filter((s: any) => s.is_closed);
      const leadDefs: [string, string | null, string | null, string, string, number][] = [
        ['Harold Finch', 'harold.finch@example.test', '+1-614-555-1101', 'Google search', 'Rear-end collision last week, has photos.', 0],
        ['Sameera Joshi', 'sameera.j@example.test', null, 'Referral - Dr. Patel', 'Wants a will and healthcare POA.', 0],
        ['Tobias Grünewald', null, '+1-937-555-1103', 'Walk-in', 'No email. Prefers phone after 6pm.', 1],
        ['Fernanda Lima', 'fernanda.lima@example.test', '+1-216-555-1104', 'Avvo', 'Custody question, spoke for 10 minutes.', 1],
        ['Big Rig Lead (urgent)', 'urgent.lead@example.test', '+1-614-555-1105', 'Billboard', 'Semi-truck collision yesterday, client in hospital. Call ASAP.', 0],
        ['Kenji Watanabe', 'kenji.w@example.test', '+1-614-555-1106', 'Website form', 'LLC formation for a food truck.', 2],
        ['Olga Petrova', 'olga.p@example.test', '+1-614-555-1107', 'Referral - former client', 'Probate of mother\'s estate, house in Bexley.', 2],
        ['Duplicate Lead (same as Harold)', 'harold.finch@example.test', '+1-614-555-1101', 'Google search', 'Submitted the web form twice.', 0],
        ['Marcus Bell', 'marcus.bell@example.test', null, 'Facebook ad', 'Wants to sue a neighbour over a fence. Very long story: '.concat('the fence was built 3 feet onto his property, the neighbour refuses to move it, the HOA sided with the neighbour, and the survey from 1998 conflicts with the 2019 survey. '.repeat(3)), 1],
      ];
      for (const [name, email, phone, source, notes, stageIdx] of leadDefs) {
        const stage = open.length ? open[Math.min(stageIdx, open.length - 1)] : leadStages[0];
        await q(
          `insert into leads (id, law_firm_id, stage_id, stage_date, name, email, phone, referral_source, notes, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [idOf(G.lead), FIRM, stage.id, day(-int(0, 20)), name, email, phone, source, notes, OWNER, et(-int(0, 30), 10)]
        );
        leadCount += 1;
      }
      if (closed.length) {
        await q(
          `insert into leads (id, law_firm_id, stage_id, stage_date, name, email, referral_source, notes, disqualify_reason, created_by, created_at)
           values ($1,$2,$3,$4,'Conflicted Out Prospect','conflict@example.test','Referral','Wanted to sue an existing client.','Conflict of interest with existing client',$5,$6)`,
          [idOf(G.lead), FIRM, closed[closed.length - 1].id, day(-12), OWNER, et(-15, 10)]
        );
        await q(
          `insert into leads (id, law_firm_id, stage_id, stage_date, name, email, referral_source, notes,
                              converted_client_id, converted_matter_id, converted_at, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,'Website form','Converted to a client and matter.',$7,$8,$9,$10,$11)`,
          [idOf(G.lead), FIRM, closed[0].id, day(-50), cViet.name, 'minhkhai.nguyen@example.test', cViet.id, mViet.id, et(-50, 12), OWNER, et(-55, 10)]
        );
        leadCount += 2;
      }
    }

    // ── document requests ───────────────────────────────────────────────────
    const docReqs: [MatterRow, string, string, string, number, [string, string][]][] = [
      [mBig, 'Medical records and bills', 'Everything since the collision. Overdue: please send what you have.', 'open', -7,
        [['ER records', 'received'], ['Surgery records - Dr. Kim', 'received'], ['Physical therapy notes', 'pending'], ['Pharmacy receipts', 'pending'], ['Health insurance EOBs', 'waived'], ['Wage loss letter', 'pending']]],
      [mLong, 'Financial disclosure package', 'Required by local rule before the temporary orders hearing.', 'open', 21,
        [['3 years tax returns', 'pending'], ['Business valuations', 'pending'], ['Retirement statements', 'pending']]],
      [mSplit, 'Deed and survey', 'Copies of the farm deed and any surveys.', 'completed', -30, [['Deed', 'received'], ['Survey', 'received']]],
      [mAcme, 'Fleet titles', 'No longer needed after the deal structure changed.', 'cancelled', -10, [['Vehicle titles (140)', 'pending']]],
    ];
    for (const [m, title, note, status, dueOffset, items] of docReqs) {
      const rid = idOf(G.docreq);
      await q(
        `insert into document_requests (id, law_firm_id, matter_id, client_id, title, note, status, due_date, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rid, FIRM, m.id, m.clientIds[0], title, note, status, day(dueOffset), OWNER]
      );
      for (const [n, [label, itemStatus]] of items.entries()) {
        await q(
          `insert into document_request_items (id, law_firm_id, request_id, label, status, sort_order)
           values ($1,$2,$3,$4,$5,$6)`,
          [idOf(G.docitem), FIRM, rid, label, itemStatus, n]
        );
      }
    }

    // ── activity log on the big matter ──────────────────────────────────────
    const logDefs: [string, string, number][] = [
      ['matter_created', 'Matter opened', -540], ['stage_changed', 'Stage moved from Intake to Investigation', -500],
      ['stage_changed', 'Stage moved from Investigation to Demand', -300], ['stage_changed', 'Stage moved from Demand to Litigation', -200],
      ['note_added', 'Note added: READ FIRST - case summary', -200], ['status_changed', 'Status changed to active', -199],
    ];
    for (const [type, summary, offset] of logDefs) {
      await q(
        `insert into activity_log (id, law_firm_id, matter_id, activity_type, actor_user_id, actor_name, summary, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [idOf(G.actlog), FIRM, mBig.id, type, OWNER, OWNER_NAME, summary, et(offset, 10)]
      );
    }

    // ── notifications: an unread backlog for both people ────────────────────
    const APP_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    const FIRM_URL = `${APP_URL}/lawfirm/${FIRM}`;
    let notifCount = 0;
    const notifKinds: [string, string, (m: MatterRow) => string, string][] = [
      ['task_due', 'Task due today', (m) => `A task on ${m.name} is due today.`, 'matter'],
      ['task_overdue', 'Overdue task', (m) => `A task on ${m.name} is overdue.`, 'matter'],
      ['message_received', 'New message', (m) => `New message in ${m.name}.`, 'matter'],
      ['invoice_overdue', 'Invoice overdue', (m) => `An invoice on ${m.name} is past due.`, 'matter'],
      ['task_assigned', 'Task assigned to you', (m) => `You were assigned a task on ${m.name}.`, 'matter'],
      ['matter_assigned', 'Added to matter', (m) => `You were added to ${m.name}.`, 'matter'],
    ];
    for (const uid of new Set([OWNER, ATTY])) {
      for (let n = 0; n < (uid === OWNER ? 40 : 15); n++) {
        const m = pick([...generated, mBig, mSplit, mLong]);
        const [type, title, body] = pick(notifKinds);
        await q(
          `insert into notifications (id, law_firm_id, user_id, type, title, body, read, entity_type, entity_id, matter_id,
                                      action_url, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,'matter',$8,$8,$9,$10,$11)`,
          [idOf(G.notif), FIRM, uid, type, title, body(m), n > 25 || chance(0.2), m.id, `${FIRM_URL}/matters/${m.id}`,
            uid === OWNER ? ATTY : OWNER, et(-Math.floor(n / 3), 8 + (n % 10), (n * 13) % 60)]
        );
        notifCount += 1;
      }
    }

    await q('commit');

    // ── summary ─────────────────────────────────────────────────────────────
    const unbilled = acts.filter((a) => a.billable && !billed.has(a.id)).length;
    console.log('Seeded:');
    const lines: [string, number][] = [
      ['clients', clients.length], ['matters', matters.length], ['tasks', taskCount], ['subtasks', subtaskCount],
      ['activities', acts.length], ['  of which unbilled', unbilled], ['invoices', invoiceSummary.length],
      ['invoice lines', lineCount], ['invoice payments', paymentCount], ['trust transactions', txns.length],
      ['events', eventCount], ['messages', messageCount], ['notes', noteCount], ['leads', leadCount],
      ['notifications', notifCount],
    ];
    for (const [k, v] of lines) console.log(`  ${k.padEnd(22)} ${v}`);
    const byStatus = new Map<string, number>();
    for (const [, status] of invoiceSummary) byStatus.set(status, (byStatus.get(status) || 0) + 1);
    console.log('\nInvoice statuses:', [...byStatus].map(([s, n]) => `${s} ${n}`).join(', '));
    console.log('Trust balances:');
    for (const [aid, name] of trustAccounts.map((t) => [t[0], t[1]])) {
      console.log(`  ${name.padEnd(34)} $${((acctBal.get(aid) || 0) / 100).toFixed(2)}`);
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nSEED FAILED:', err.message);
  if (err.detail) console.error('  detail:', err.detail);
  process.exit(1);
});

export {};
