/**
 * Fill EXISTING matters with a full spread of demo content, so every matter tab
 * has something in it to test against.
 *
 *   npx tsx backend/db/seed/seed-matter-details.ts
 *   npx tsx backend/db/seed/seed-matter-details.ts --firm <lawFirmId> --actor <userId>
 *   npx tsx backend/db/seed/seed-matter-details.ts --matter <matterId> --matter <matterId>
 *   npx tsx backend/db/seed/seed-matter-details.ts --no-files    # skip the GCS uploads
 *   npx tsx backend/db/seed/seed-matter-details.ts --conversations 0
 *   npx tsx backend/db/seed/seed-matter-details.ts --list        # print the plan, write nothing
 *
 * Unlike seed-local-testdata.ts, which invents its own matters, this attaches to
 * matters that are already there: every matter in the firm by default. Per matter
 * it writes notes, contacts, an activity trail, tasks with subtasks, events, time
 * entries, expenses, flat fees, three invoices (paid / partially paid / open)
 * with their line items and payments, a trust deposit and disbursement, a document
 * request, and a small folder tree of real PDFs. Conversations are capped
 * (`--conversations`, default 5) because they share one firm-wide inbox rather than
 * living under their matter.
 *
 * Time, expenses and flat fees are all rows in `activities`, told apart by `kind`.
 * An activity counts as billed only because an invoice line item's `source_id`
 * points back at it; there is no `billed` column to set.
 *
 * Every row it writes carries a fixed id prefixed with 5eedbeef, so the script is
 * idempotent: it deletes its own previous rows and re-inserts them. Nothing that
 * was already in the firm is modified, with two exceptions, both additive and both
 * left in place on cleanup:
 *   - a matter with no client gets one attached (invoices, trust entries, and
 *     document requests all need a client to hang off)
 *   - the rotating cast of timekeepers is added to each matter's member list
 *
 * File bytes come from `backend/db/seed/fixtures/` (gitignored, so drop your own
 * PDFs there) and go through `seedFiles.ts`, which writes them exactly as the
 * upload route does. A re-run replaces only the folders this script owns.
 *
 * seed-matter-files.ts seeds a deeper tree into five of these matters under the
 * same folder names. Run it after this one, so its version wins where they
 * overlap; running it first means this script overwrites its work.
 *
 * Refuses to run against anything but a local database. Loads env from backend/.env.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl } = require('../../src/shared/database/resolveDbUrl');
const { loadFixtures, seedMatterFiles } = require('./seedFiles');

const DEFAULT_FIRM = '46d9c29f-c2d0-558e-862f-144ec954d01c';

const argOf = (flag: any, fallback: any) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const argsOf = (flag: any) => {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
};

const FIRM = argOf('--firm', DEFAULT_FIRM);
const ACTOR_ARG = argOf('--actor', null);
const ONLY_MATTERS = argsOf('--matter');
const SKIP_FILES = process.argv.includes('--no-files');
const LIST_ONLY = process.argv.includes('--list');
// Conversations are firm-wide, not per-matter: they all land in one inbox, so
// seeding one for every matter drowns the real threads. Only the first N matters
// get one. `--conversations 0` skips them entirely.
const CONVERSATION_LIMIT = Number(argOf('--conversations', '5'));

// Fixed-id namespace. Every seeded row's id starts with this, which is what makes
// the delete-then-insert cleanup below both precise and safe.
const NS = '5eedbeef';
const SEED_MARK = 'seed-matter-details';
const LIKE = `${NS}-%`;

// Ids are handed out in sequence per group, so a group never collides with another
// and the same run always produces the same ids.
const counters: Record<string, number> = {};
const id = (group: any) => {
  counters[group] = (counters[group] || 0) + 1;
  return `${NS}-${group}-4000-8000-${String(counters[group]).padStart(12, '0')}`;
};

const G = {
  expenseCategory: '0001',
  note: '0002',
  contact: '0003',
  task: '0004',
  subtask: '0005',
  event: '0006',
  time: '0007',
  expense: '0008',
  flatFee: '0009',
  invoice: '000a',
  line: '000b',
  payment: '000c',
  trust: '000d',
  docRequest: '000e',
  docItem: '000f',
  conversation: '0010',
  message: '0011',
  notification: '0012',
  directoryContact: '0013',
  activityLog: '0014',
};

// Day offsets resolved against today, so seeded data always straddles "now".
const day = (offset: any) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const ts = (offsetDays: any, hour = 12) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

const pick = (arr: any, i: any) => arr[i % arr.length];
const money = (hours: any, rateCents: any) => Math.round(hours * rateCents);

/* ------------------------------------------------------------------ */
/*  content library                                                     */
/* ------------------------------------------------------------------ */
// Each matter draws one entry from every list, rotating by its position in the
// firm's matter list. The copy is deliberately generic legal work product so it
// reads plausibly against a matter of any practice area.

const NOTE_SETS = [
  [
    ['Initial client meeting', 'Walked the client through the engagement scope, fee structure, and the likely timeline. Client signed the representation agreement and returned the conflict waiver.', true],
    ['Strategy memo', 'Two viable paths: early resolution at a discount, or full workup and a contested hearing. Recommending we price both before the next client call.', false],
    ['Opposing counsel contact', 'Left a voicemail and followed up by email requesting an extension of the response deadline. No answer yet.', false],
  ],
  [
    ['Document review complete', 'Reviewed the production set. Two gaps: the 2024 correspondence file and the signed amendment. Sending a deficiency letter.', false],
    ['Client update call', 'Client is comfortable with the current approach and authorized us to proceed with the filing. Confirmed the budget ceiling.', true],
    ['Deadline calendared', 'Response is due in three weeks. Calendared with a one-week internal draft deadline so there is room for client review.', false],
  ],
  [
    ['Intake summary', 'Facts as related by the client, key dates, and the documents still outstanding. Flagged a potential limitations issue that needs research.', true],
    ['Research note', 'The controlling authority is favorable but distinguishable on the damages question. Full memo to follow.', false],
    ['Settlement posture', 'Other side signaled interest in mediation. Discussed the range with the client; they will not go below the number we set.', false],
  ],
  [
    ['Filing confirmed', 'Filed and served. Proof of service is in the matter file. Docket number recorded on the matter record.', true],
    ['Expert retained', 'Retained the expert and sent the materials packet. Preliminary opinion expected within thirty days.', false],
    ['Billing note', 'Client asked for a mid-engagement cost estimate. Prepared a projection through the next milestone.', false],
  ],
];

const CONTACT_SETS = [
  [
    ['Gregory Hain', 'opposing_counsel', 'Hain & Stroud LLP', 'ghain@hainstroud.example.test', '+1-614-555-0201'],
    ['Hon. Alicia Duran', 'judge', 'County Superior Court', null, null],
    ['Dana Kirby', 'adjuster', 'Meridian Casualty', 'dkirby@meridiancas.example.test', '+1-800-555-0134'],
  ],
  [
    ['Priyanka Shah', 'opposing_counsel', 'Shah Legal Group', 'pshah@shahlegal.example.test', '+1-415-555-0188'],
    ['Marcus Reed', 'witness', null, 'mreed@example.test', '+1-415-555-0190'],
    ['Elena Vasquez', 'mediator', 'Bay Dispute Resolution', 'evasquez@baydr.example.test', null],
  ],
  [
    ['Thomas Ainsley', 'co_counsel', 'Ainsley & Park', 'tainsley@ainsleypark.example.test', '+1-312-555-0144'],
    ['Dr. Naomi Feld', 'expert', 'Feld Forensic Consulting', 'nfeld@feldforensic.example.test', '+1-312-555-0166'],
    ['R. Whitcomb', 'court_clerk', 'Clerk of Court, Division 3', null, '+1-312-555-0100'],
  ],
  [
    ['Sandra Lowell', 'opposing_party', 'Lowell Holdings', null, null],
    ['Bennett Cruz', 'guardian_ad_litem', null, 'bcruz@example.test', '+1-206-555-0121'],
    ['Officer R. Pinsky', 'witness', 'City Police Department', null, null],
  ],
];

const TASK_SETS = [
  [
    ['Draft and file the responsive pleading', 'open', 'urgent', -2],
    ['Follow up with opposing counsel on the extension', 'open', 'high', 1],
    ['Assemble the exhibit index', 'in_progress', 'medium', 6],
    ['Confirm service of process on all parties', 'completed', 'low', -14],
  ],
  [
    ['Prepare the discovery responses', 'in_progress', 'urgent', 0],
    ['Order the certified records', 'open', 'high', 4],
    ['Schedule the client prep session', 'open', 'medium', 9],
    ['Send the engagement letter countersignature', 'completed', 'low', -21],
  ],
  [
    ['Draft the settlement demand', 'open', 'high', 3],
    ['Review the production for privilege', 'blocked', 'urgent', -1],
    ['Update the case chronology', 'in_progress', 'low', 12],
    ['Docket the hearing date', 'completed', 'medium', -8],
  ],
  [
    ['Prepare the motion and supporting memorandum', 'open', 'urgent', 5],
    ['Interview the fact witness', 'open', 'medium', 2],
    ['Reconcile the expense ledger for this matter', 'in_progress', 'low', 15],
    ['File the notice of appearance', 'completed', 'high', -30],
  ],
];

const SUBTASKS = [
  ['Pull the underlying documents', true],
  ['Draft the first pass', false],
  ['Partner review and sign-off', false],
];

// Types must come from MATTER_EVENT_TYPES in matterEvents.validation.js — the
// column is plain text with no check constraint, so a value outside that list
// seeds a row the app itself could never create.
const EVENT_SETS = [
  [
    ['Status conference', 'hearing', 'Courtroom 4B', 4, true],
    ['Deposition of the corporate representative', 'deposition', 'Opposing counsel offices', 11, false],
    ['Response deadline', 'filing_deadline', null, -3, true],
  ],
  [
    ['Client strategy meeting', 'meeting', 'Conference Room A', 2, true],
    ['Motion hearing', 'hearing', 'Courtroom 2A', 18, true],
    ['Discovery cutoff', 'discovery_cutoff', null, 25, false],
  ],
  [
    ['Mediation session', 'mediation', 'Neutral site', 7, true],
    ['Pretrial conference', 'hearing', 'Courtroom 6', 21, true],
    ['Expert disclosure due', 'discovery_cutoff', null, -6, false],
  ],
  [
    ['Witness prep', 'meeting', 'Office', 1, false],
    ['Evidentiary hearing', 'hearing', 'Courtroom 1', 14, true],
    ['Filing deadline', 'filing_deadline', null, 9, true],
  ],
];

// [hours, rateCents, description]. The first two are billed to the paid invoice,
// the third to the partially-paid one, and the last two stay unbilled so the
// "ready to bill" screens have something in them.
const TIME_SETS: any[][][] = [
  [
    [3.4, 35000, 'Draft the initial pleading and supporting declaration'],
    [1.2, 35000, 'Telephone conference with opposing counsel regarding scheduling'],
    [2.6, 15000, 'Assemble and index the document production'],
    [1.8, 35000, 'Legal research on the controlling standard'],
    [0.6, 35000, 'Client update call'],
  ],
  [
    [4.1, 35000, 'Review and analyze the opposing production'],
    [0.9, 45000, 'Court appearance — status conference'],
    [3.2, 35000, 'Draft the discovery responses'],
    [1.5, 15000, 'Prepare the exhibit binder'],
    [0.4, 35000, 'Correspondence with the client regarding next steps'],
  ],
  [
    [2.8, 35000, 'Draft the settlement demand and damages summary'],
    [1.6, 15000, 'Privilege review of the correspondence file'],
    [5.0, 35000, 'Prepare the motion and memorandum in support'],
    [1.1, 45000, 'Court appearance — motion hearing'],
    [0.8, 35000, 'Case strategy conference with co-counsel'],
  ],
  [
    [1.9, 35000, 'Initial consultation and matter intake'],
    [2.3, 35000, 'Draft and revise the engagement documents'],
    [3.7, 35000, 'Fact investigation and witness interviews'],
    [0.7, 15000, 'Calendar the deadlines and docket the matter'],
    [1.4, 35000, 'Review the expert preliminary report'],
  ],
];

// [amountCents, description, vendor]. The first is billed to the paid invoice.
const EXPENSE_SETS: any[][][] = [
  [
    [35500, 'Court filing fee', 'Clerk of Court'],
    [12400, 'Certified records retrieval', 'Records Depot'],
    [8900, 'Mileage — site inspection', null],
  ],
  [
    [42000, 'Filing and service fees', 'Clerk of Court'],
    [26500, 'Deposition transcript', 'Veritext Reporting'],
    [4200, 'Copying and postage', null],
  ],
  [
    [15000, 'Process server', 'Buckeye Process'],
    [250000, 'Expert witness retainer', 'Feld Forensic Consulting'],
    [7500, 'Records subpoena service', 'Buckeye Process'],
  ],
  [
    [30000, 'Petition filing fee', 'Clerk of Court'],
    [18800, 'Travel — out-of-county hearing', null],
    [9600, 'Title and lien search', 'First Search Co.'],
  ],
];

// [amountCents, description]. The first is billed to the partially-paid invoice.
const FLAT_FEE_SETS: any[][][] = [
  [
    [150000, 'Document preparation package — flat engagement'],
    [75000, 'Post-filing compliance review — flat fee'],
  ],
  [
    [250000, 'Contract review and negotiation — flat engagement'],
    [50000, 'Follow-up consultation package'],
  ],
  [
    [350000, 'Representation through the pretrial phase — flat fee'],
    [90000, 'Records collection and summary — flat fee'],
  ],
  [
    [120000, 'Estate document package — flat engagement'],
    [60000, 'Annual review and update — flat fee'],
  ],
];

const EXPENSE_CATEGORIES = [
  ['SEED-FILING', 'Filing Fees'],
  ['SEED-TRAVEL', 'Travel'],
  ['SEED-EXPERT', 'Expert & Consultant'],
  ['SEED-RECORDS', 'Records & Copying'],
];

const DOC_REQUEST_SETS = [
  ['Outstanding client documents', 'Needed before we can finalize the filing.', [
    ['Signed engagement letter', 'received'],
    ['Government-issued photo ID', 'pending'],
    ['Prior correspondence with the other side', 'pending'],
  ]],
  ['Financial disclosures', 'Required for the upcoming conference.', [
    ['Last two years of tax returns', 'received'],
    ['Three months of bank statements', 'pending'],
    ['Statement of income and expenses', 'pending'],
  ]],
  ['Supporting records', 'Please upload whatever you have; we will request the rest by subpoena.', [
    ['Insurance declarations page', 'pending'],
    ['Photographs and other media', 'received'],
    ['Receipts for out-of-pocket costs', 'waived'],
  ]],
];

const MESSAGE_SETS = [
  [
    'Filing went out this morning — the stamped copy is in the matter files.',
    'The other side asked for a two-week extension. Any objection if we agree to one week?',
    'One week is fine. Please confirm the new date once it is entered.',
    'Confirmed. The revised deadline is on the matter calendar.',
  ],
  [
    'Uploaded the documents you asked for to the client documents folder.',
    'Received, thank you. One item is still missing — the signed authorization.',
    'Sending that over tonight.',
    'Got it. Nothing further needed from you this week.',
  ],
];

const FOLDERS = [
  { path: 'Pleadings', color: 'blue' },
  { path: 'Discovery', color: 'purple' },
  { path: 'Correspondence', color: 'green' },
  { path: 'Client Documents', color: 'amber', visible: true },
];

const FILE_SETS = [
  [
    { folder: '', name: 'Matter Intake Summary.pdf', fixture: 'a' },
    { folder: 'Pleadings', name: 'Complaint.pdf', fixture: 'a' },
    { folder: 'Pleadings', name: 'Notice of Appearance.pdf', fixture: 'b' },
    { folder: 'Discovery', name: 'First Set of Interrogatories.pdf', fixture: 'b' },
    { folder: 'Correspondence', name: 'Demand Letter.pdf', fixture: 'agreement', visible: true },
    { folder: 'Client Documents', name: 'Representation Agreement - Signed.pdf', fixture: 'agreement', visible: true },
  ],
  [
    { folder: '', name: 'Case Summary and Timeline.pdf', fixture: 'b' },
    { folder: 'Pleadings', name: 'Answer and Affirmative Defenses.pdf', fixture: 'a' },
    { folder: 'Discovery', name: 'Requests for Production.pdf', fixture: 'b' },
    { folder: 'Discovery', name: 'Document Production Index.pdf', fixture: 'a' },
    { folder: 'Correspondence', name: 'Opposing Counsel Correspondence.pdf', fixture: 'b' },
    { folder: 'Client Documents', name: 'Engagement Letter - Signed.pdf', fixture: 'agreement', visible: true },
  ],
  [
    { folder: '', name: 'Fee Agreement - Signed.pdf', fixture: 'agreement', visible: true },
    { folder: 'Pleadings', name: 'Motion and Memorandum in Support.pdf', fixture: 'a' },
    { folder: 'Pleadings', name: 'Proposed Order.pdf', fixture: 'b' },
    { folder: 'Discovery', name: 'Deposition Transcript Excerpts.pdf', fixture: 'a' },
    { folder: 'Correspondence', name: 'Settlement Communications.pdf', fixture: 'b' },
    { folder: 'Client Documents', name: 'Client Questionnaire.pdf', fixture: 'a', visible: true },
  ],
];

/* ------------------------------------------------------------------ */
/*  files (GCS)                                                         */
/* ------------------------------------------------------------------ */

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURE_FILES = {
  a: 'notice-of-appearance-a.pdf',
  b: 'notice-of-appearance-b.pdf',
  agreement: 'representation-agreement-signed.pdf',
};

/* ------------------------------------------------------------------ */
/*  main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL resolved (DB_TARGET / DATABASE_URL in backend/.env).');
    process.exit(1);
  }
  if (/supabase|pooler\.supabase\.com/i.test(connectionString)) {
    console.error('Refusing to run: this resolves to a hosted Supabase database.');
    console.error('Set DB_TARGET=local (or pass DB_TARGET=local inline) and retry.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  const q = (text: string, params?: any[]) => client.query(text, params);

  try {
    const { rows: firmRows } = await q('select id, name from law_firms where id = $1', [FIRM]);
    if (!firmRows.length) throw new Error(`Law firm ${FIRM} not found.`);
    const firmName = firmRows[0].name;

    const { rows: memberRows } = await q(
      `select m.user_id, coalesce(u.name, u.email, m.user_id) as name
         from members m left join users u on u.id = m.user_id
        where m.law_firm_id = $1
        order by u.name nulls last`,
      [FIRM]
    );
    if (!memberRows.length) throw new Error(`Law firm ${FIRM} has no members.`);
    const actor = ACTOR_ARG || memberRows[0].user_id;
    if (!memberRows.some((m: any) => m.user_id === actor)) {
      throw new Error(`User ${actor} is not a member of ${FIRM}.`);
    }
    const actorName = memberRows.find((m: any) => m.user_id === actor).name;
    // Timekeepers rotate across the firm's members so hours land on more than one
    // person and the "by timekeeper" reports have something to split.
    const timekeepers = memberRows;

    let matterSql = 'select id, name from matters where law_firm_id = $1';
    const matterParams = [FIRM];
    if (ONLY_MATTERS.length) {
      matterSql += ' and id = any($2::uuid[])';
      matterParams.push(ONLY_MATTERS);
    }
    matterSql += ' order by name, id';
    const { rows: matters } = await q(matterSql, matterParams);
    if (!matters.length) throw new Error('No matching matters found.');

    const { rows: clientRows } = await q(
      'select id, name from clients where law_firm_id = $1 order by name',
      [FIRM]
    );
    if (!clientRows.length) throw new Error(`Law firm ${FIRM} has no clients.`);

    const { rows: chargeCodes } = await q(
      `select id, code from billing_codes where law_firm_id = $1 and kind = 'charge' and is_active order by code`,
      [FIRM]
    );

    const { rows: trustAccounts } = await q(
      `select id, book_balance_cents from trust_accounts
        where law_firm_id = $1 and status = 'active' order by created_at limit 1`,
      [FIRM]
    );
    const trustAccount = trustAccounts[0] || null;

    if (LIST_ONLY) {
      console.log(`${firmName} (${FIRM}) — ${matters.length} matters, actor ${actorName}`);
      matters.forEach((m: any, i: any) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${m.name}  (${m.id})`);
      });
      console.log('\nPer matter: 3 notes, 3 contacts, 3 activity entries, 4 tasks (3 subtasks on the first),');
      console.log('3 matter events, 5 time entries, 3 expenses, 2 flat fees, 3 invoices with line items');
      console.log('and payments, 2 trust transactions, 1 document request with 3 items, 4 folders and');
      console.log(`6 PDFs${trustAccount ? '' : ' (no active trust account — trust entries skipped)'}.`);
      console.log(`Plus a matter-scoped conversation with 4 messages on the first ${CONVERSATION_LIMIT} matters.`);
      console.log('\nNothing written (--list).');
      return;
    }

    // Files are written outside the transaction (GCS is not transactional), so
    // resolve the SDK only when they are actually wanted.
    let bucket = null;
    let filesRepo = null;
    let fixtures = null;
    if (!SKIP_FILES) {
      // eslint-disable-next-line global-require
      const { admin } = require('../../src/shared/database/firebase');
      // eslint-disable-next-line global-require
      filesRepo = require('../../src/modules/files/files.repository');
      bucket = admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
      fixtures = loadFixtures(FIXTURE_DIR, FIXTURE_FILES);
    }

    console.log(`Seeding "${firmName}" (${FIRM}) as ${actorName}`);
    console.log(`${matters.length} matters, ${timekeepers.length} timekeepers\n`);

    await q('begin');
    // Lets the cleanup delete seeded trust transactions, which the append-only
    // trust_txn_immutable trigger otherwise refuses to remove.
    await q("set local session_replication_role = 'replica'");

    // ── cleanup: drop everything this script wrote on a previous run ─────────
    const byId = [
      'document_request_items', 'document_requests', 'invoice_payments', 'invoice_line_items',
      'invoices', 'activities', 'task_subtasks', 'tasks',
      'trust_transactions', 'messages', 'conversations', 'events', 'notifications',
      'notes', 'activity_log', 'matter_contacts', 'contacts', 'billing_codes',
    ];
    for (const table of byId) {
      await q(`delete from ${table} where id::text like $1`, [LIKE]);
    }
    await q('delete from task_assignees where task_id::text like $1', [LIKE]);
    await q('delete from conversation_participants where conversation_id::text like $1', [LIKE]);
    await q('delete from conversation_matters where conversation_id::text like $1', [LIKE]);

    // ── expense categories ──────────────────────────────────────────────────
    // Charge codes and expense categories share one table, told apart by `kind`.
    const expenseCategoryIds: string[] = [];
    for (const [code, name] of EXPENSE_CATEGORIES) {
      const cid = id(G.expenseCategory);
      await q(
        `insert into billing_codes (id, law_firm_id, kind, code, name, sort_order, is_active, created_by)
         values ($1,$2,'expense',$3,$4,$5,true,$6)
         on conflict (law_firm_id, kind, code) do update set name = excluded.name`,
        [cid, FIRM, code, name, expenseCategoryIds.length, actor]
      );
      const { rows } = await q(
        `select id from billing_codes where law_firm_id = $1 and kind = 'expense' and code = $2`,
        [FIRM, code]
      );
      expenseCategoryIds.push(rows[0].id);
    }

    // ── trust running balances continue from whatever survived the cleanup ───
    // Anchored on the ledger's tail rather than trust_accounts.book_balance_cents,
    // so a re-run picks up where the pre-existing entries left off instead of
    // compounding on top of the balance the previous run wrote.
    let trustAccountBalance = 0;
    const trustClientBalances = new Map();
    if (trustAccount) {
      const { rows: tail } = await q(
        `select account_balance_after_cents from trust_transactions
          where law_firm_id = $1 and trust_account_id = $2 and status = 'completed'
          order by txn_date desc, created_at desc limit 1`,
        [FIRM, trustAccount.id]
      );
      trustAccountBalance = tail.length
        ? Number(tail[0].account_balance_after_cents || 0)
        : Number(trustAccount.book_balance_cents || 0);

      const { rows } = await q(
        `select distinct on (client_id) client_id, client_balance_after_cents
           from trust_transactions
          where law_firm_id = $1 and trust_account_id = $2 and client_id is not null
          order by client_id, txn_date desc, created_at desc`,
        [FIRM, trustAccount.id]
      );
      for (const r of rows) trustClientBalances.set(r.client_id, Number(r.client_balance_after_cents || 0));
    }
    // Trust entries are collected across every matter and written in one pass at
    // the end: the stored running balances only make sense if they are computed in
    // the same order the ledger is later read back in (txn_date, then created_at).
    const pendingTrust = [];

    const filePlans = [];
    const totals: Record<string, number> = {};
    const bump = (k: any, n = 1) => { totals[k] = (totals[k] || 0) + n; };

    for (let i = 0; i < matters.length; i += 1) {
      const matter = matters[i];
      const M = matter.id;

      // ── client: every matter needs one for invoices, trust, and doc requests ─
      const { rows: existingClients } = await q(
        'select client_id from matter_clients where matter_id = $1 order by client_id limit 1',
        [M]
      );
      let clientId = existingClients[0]?.client_id;
      if (!clientId) {
        clientId = pick(clientRows, i).id;
        await q(
          'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1,$2,$3) on conflict do nothing',
          [M, clientId, FIRM]
        );
        bump('matter_clients attached');
      }
      const clientName = clientRows.find((c: any) => c.id === clientId)?.name || 'Client';

      // ── members: the rotating timekeepers must be on the matter to bill to it ─
      for (const tk of timekeepers) {
        await q(
          `insert into matter_members (matter_id, user_id, law_firm_id, role, hourly_rate_cents, joined_at)
           values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
          [M, tk.user_id, FIRM, tk.user_id === actor ? 'lead' : 'member', 35000, ts(-90)]
        );
      }

      // ── notes ─────────────────────────────────────────────────────────────
      // NOTE_SETS still carries a visibility flag per note, which is unused:
      // notes are firm-internal since migration 0032 dropped notes.client_visible.
      for (const [n, [subject, content]] of pick(NOTE_SETS, i).entries()) {
        // `notes` carries no author name of its own: the display name is joined
        // from `users` at read time.
        await q(
          `insert into notes (id, law_firm_id, matter_id, subject, content, note_type,
                              created_by, note_date, created_at)
           values ($1,$2,$3,$4,$5,'general',$6,$7,$8)`,
          [id(G.note), FIRM, M, subject, content, actor, day(-30 + n * 9), ts(-30 + n * 9)]
        );
        bump('notes');
      }

      // ── contacts ──────────────────────────────────────────────────────────
      // The person goes in the firm-wide directory; the matter row is only the
      // link plus the role they play here.
      for (const [n, [name, role, org, email, phone]] of pick(CONTACT_SETS, i).entries()) {
        const contactId = id(G.directoryContact);
        await q(
          `insert into contacts (id, law_firm_id, name, category, organization, email, phone, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [contactId, FIRM, name, role, org, email, phone, actor]
        );
        bump('contacts');
        await q(
          `insert into matter_contacts (id, law_firm_id, matter_id, contact_id, role, sort_order, created_by)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [id(G.contact), FIRM, M, contactId, role, n, actor]
        );
        bump('matter_contacts');
      }

      // ── activity trail ────────────────────────────────────────────────────
      const activity = [
        ['matter_created', 'Matter opened and conflicts cleared', -90],
        ['note_added', `Note added: ${pick(NOTE_SETS, i)[0][0]}`, -30],
        ['file_uploaded', 'Documents uploaded to the matter file', -12],
      ];
      for (const [type, summary, offset] of activity) {
        await q(
          `insert into activity_log (id, law_firm_id, matter_id, activity_type, actor_user_id, actor_name,
                                     summary, metadata, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id(G.activityLog), FIRM, M, type, actor, actorName, summary,
            JSON.stringify({ seedSource: SEED_MARK }), ts(offset)]
        );
        bump('activity_log');
      }

      // ── tasks + subtasks ──────────────────────────────────────────────────
      for (const [n, [title, status, priority, dueOffset]] of pick(TASK_SETS, i).entries()) {
        const taskId = id(G.task);
        await q(
          `insert into tasks (id, law_firm_id, title, matter_id, status, priority, due_date, due_date_timezone,
                              all_day, source, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,'America/New_York',true,'manual',$8,$9)`,
          [taskId, FIRM, title, M, status, priority, day(dueOffset), actor, ts(-40 + n * 5)]
        );
        const assignee = pick(timekeepers, i + n).user_id;
        await q(
          'insert into task_assignees (law_firm_id, task_id, user_id) values ($1,$2,$3) on conflict do nothing',
          [FIRM, taskId, assignee]
        );
        bump('tasks');

        if (n === 0) {
          for (const [s, [subtitle, done]] of SUBTASKS.entries()) {
            await q(
              `insert into task_subtasks (id, law_firm_id, task_id, title, is_completed, assignee_user_id,
                                          sort_order, created_by, completed_at, completed_by)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [id(G.subtask), FIRM, taskId, subtitle, done, assignee, s, actor,
                done ? ts(-6) : null, done ? actor : null]
            );
            bump('task_subtasks');
          }
        }
      }

      // ── matter events ─────────────────────────────────────────────────────
      // Assignees are their own table now, not two json columns on the event.
      // `ends_at` has to be strictly after `date` (events_ends_after_start).
      for (const [title, type, location, offset, clientVisible] of pick(EVENT_SETS, i)) {
        const eventId = id(G.event);
        await q(
          `insert into events (id, law_firm_id, matter_id, type, title, notes, location_name, status,
                               date, ends_at, all_day, created_by, client_visible, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,'upcoming',$8,$9,false,$10,$11,$12)`,
          [eventId, FIRM, M, type, `${title}: ${matter.name}`, 'Seeded demo event.', location,
            ts(offset, 14), ts(offset, 15), actor, clientVisible, ts(-20)]
        );
        await q(
          'insert into event_assignees (law_firm_id, event_id, user_id) values ($1,$2,$3) on conflict do nothing',
          [FIRM, eventId, actor]
        );
        bump('events');
      }

      // ── invoices are declared first so the billables can point at them ────
      const paidInvoiceId = id(G.invoice);
      const partialInvoiceId = id(G.invoice);
      const openInvoiceId = id(G.invoice);

      // ── time entries ──────────────────────────────────────────────────────
      // Time, expenses and flat fees are all rows in `activities`, told apart by
      // `kind`. The table has no `billed` or `invoice_id` column: an activity
      // counts as billed only because some invoice_line_items.source_id points
      // back at it, so each row keeps its own id for the line items below.
      const timeSet = pick(TIME_SETS, i);
      const timeRows = timeSet.map(([hours, rate, description]: any[], n: any) => ({
        activityId: id(G.time),
        hours,
        rate,
        description,
        amount: money(hours, rate),
        chargeCodeId: chargeCodes.length ? pick(chargeCodes, i + n).id : null,
        userId: pick(timekeepers, i + n).user_id,
        userName: pick(timekeepers, i + n).name,
        invoiceId: n === 0 || n === 1 ? paidInvoiceId : n === 2 ? partialInvoiceId : null,
        offset: -45 + n * 8,
      }));
      // amount_cents is generated (round(hours * rate_cents)), so the local
      // `amount` only mirrors it for the invoice line items and is never inserted.
      for (const t of timeRows) {
        await q(
          `insert into activities (id, law_firm_id, kind, matter_id, user_id, activity_date, description,
                                   billable, hours, rate_cents, billing_code_id, source, created_by, created_at)
           values ($1,$2,'time',$3,$4,$5,$6,true,$7,$8,$9,'manual',$4,$10)`,
          [t.activityId, FIRM, M, t.userId, day(t.offset), t.description, t.hours, t.rate,
            t.chargeCodeId, ts(t.offset)]
        );
        bump('activities (time)');
      }

      // ── expenses ──────────────────────────────────────────────────────────
      const expenseSet = pick(EXPENSE_SETS, i);
      const expenseRows = expenseSet.map(([amount, description, vendor]: any[], n: any) => ({
        activityId: id(G.expense),
        amount,
        description,
        vendor,
        invoiceId: n === 0 ? paidInvoiceId : null,
        offset: -44 + n * 11,
        categoryId: pick(expenseCategoryIds, i + n),
      }));
      // An expense row carries its money in charge_cents, and activities_expense_shape
      // forbids hours, rate_cents and source on it.
      for (const e of expenseRows) {
        await q(
          `insert into activities (id, law_firm_id, kind, matter_id, user_id, activity_date, description,
                                   billable, charge_cents, billing_code_id, vendor, created_by, created_at)
           values ($1,$2,'expense',$3,$4,$5,$6,true,$7,$8,$9,$4,$10)`,
          [e.activityId, FIRM, M, actor, day(e.offset), e.description, e.amount, e.categoryId,
            e.vendor, ts(e.offset)]
        );
        bump('activities (expense)');
      }

      // ── flat fees ─────────────────────────────────────────────────────────
      const flatFeeSet = pick(FLAT_FEE_SETS, i);
      const flatFeeRows = flatFeeSet.map(([amount, description]: any[], n: any) => ({
        activityId: id(G.flatFee),
        amount,
        description,
        invoiceId: n === 0 ? partialInvoiceId : null,
        offset: -42 + n * 20,
      }));
      // activities_flat_fee_shape forbids user_id, billing_code_id and vendor on
      // a flat fee: the fee belongs to the matter, not to a timekeeper.
      for (const f of flatFeeRows) {
        await q(
          `insert into activities (id, law_firm_id, kind, matter_id, activity_date, description,
                                   billable, charge_cents, created_by, created_at)
           values ($1,$2,'flat_fee',$3,$4,$5,true,$6,$7,$8)`,
          [f.activityId, FIRM, M, day(f.offset), f.description, f.amount, actor, ts(f.offset)]
        );
        bump('activities (flat fee)');
      }

      // ── invoices ──────────────────────────────────────────────────────────
      // Totals are summed from the exact billables attached above, so what the
      // invoice claims and what its line items add up to always agree.
      const seq = String(i + 1).padStart(3, '0');
      const paidLines = [
        ...timeRows.filter((t: any) => t.invoiceId === paidInvoiceId).map((t: any) => ({
          kind: 'time_entry', name: t.description, qty: t.hours, rate: t.rate, amount: t.amount,
          userId: t.userId, userName: t.userName, date: day(t.offset),
          sourceId: t.activityId, chargeCodeId: t.chargeCodeId,
        })),
        ...expenseRows.filter((e: any) => e.invoiceId === paidInvoiceId).map((e: any) => ({
          kind: 'expense', name: e.description, qty: 1, rate: e.amount, amount: e.amount,
          userId: actor, userName: actorName, date: day(e.offset),
          sourceId: e.activityId, chargeCodeId: e.categoryId,
        })),
      ];
      const partialLines = [
        ...timeRows.filter((t: any) => t.invoiceId === partialInvoiceId).map((t: any) => ({
          kind: 'time_entry', name: t.description, qty: t.hours, rate: t.rate, amount: t.amount,
          userId: t.userId, userName: t.userName, date: day(t.offset),
          sourceId: t.activityId, chargeCodeId: t.chargeCodeId,
        })),
        ...flatFeeRows.filter((f: any) => f.invoiceId === partialInvoiceId).map((f: any) => ({
          kind: 'flat_fee', name: f.description, qty: 1, rate: f.amount, amount: f.amount,
          userId: null, userName: null, date: day(f.offset),
          sourceId: f.activityId, chargeCodeId: null,
        })),
      ];
      // The open invoice bills work that is not tracked as a separate billable, so
      // it stays editable without disturbing the unbilled queues.
      const openLines = [
        {
          kind: 'time_entry', name: 'Case management and file maintenance', qty: 2.5, rate: 35000,
          amount: money(2.5, 35000), userId: actor, userName: actorName, date: day(-9),
          sourceId: null, chargeCodeId: null,
        },
        {
          kind: 'expense', name: 'Courier and delivery charges', qty: 1, rate: 6500, amount: 6500,
          userId: actor, userName: actorName, date: day(-8),
          sourceId: null, chargeCodeId: null,
        },
      ];

      const sum = (lines: any) => lines.reduce((n: any, l: any) => n + l.amount, 0);
      const hoursOf = (lines: any) => lines.filter((l: any) => l.kind === 'time_entry').reduce((n: any, l: any) => n + Number(l.qty), 0);
      const flatOf = (lines: any) => lines.filter((l: any) => l.kind === 'flat_fee').reduce((n: any, l: any) => n + l.amount, 0);

      // Every fourth matter's open invoice is already past due, so the overdue
      // filters and reminder screens have live examples.
      const openIsOverdue = i % 4 === 3;
      const invoiceSpecs = [
        {
          invoiceId: paidInvoiceId, number: `SEED-${seq}-A`, name: `Invoice ${seq}-A`, lines: paidLines,
          status: 'paid', invoiceDate: day(-38), dueDate: day(-8), paidRatio: 1, invoiceOffset: -38,
        },
        {
          invoiceId: partialInvoiceId, number: `SEED-${seq}-B`, name: `Invoice ${seq}-B`, lines: partialLines,
          status: 'partially_paid', invoiceDate: day(-22), dueDate: day(8), paidRatio: 0.4, invoiceOffset: -22,
        },
        {
          invoiceId: openInvoiceId, number: `SEED-${seq}-C`, name: `Invoice ${seq}-C`, lines: openLines,
          status: openIsOverdue ? 'overdue' : 'outstanding', invoiceDate: day(-6),
          dueDate: openIsOverdue ? day(-2) : day(24), paidRatio: 0, invoiceOffset: -6,
        },
      ];

      for (const spec of invoiceSpecs) {
        const total = sum(spec.lines);
        const paid = Math.round(total * spec.paidRatio);
        await q(
          `insert into invoices (id, law_firm_id, matter_id, client_id, invoice_number, invoice_name, status,
                                 context_type, invoice_date, due_date, total_cents, flat_fees_amount_cents,
                                 amount_paid_cents, total_hours, is_paid, paid_date, notes, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,'matter',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [spec.invoiceId, FIRM, M, clientId, spec.number, spec.name, spec.status, spec.invoiceDate,
            spec.dueDate, total, flatOf(spec.lines), paid, hoursOf(spec.lines) || null,
            spec.paidRatio >= 1, spec.paidRatio >= 1 ? ts(-8) : null,
            `Seeded demo invoice for ${matter.name}.`, actor, ts(spec.invoiceOffset)]
        );
        bump('invoices');

        for (const [n, line] of spec.lines.entries()) {
          // source_id is what marks the underlying activity as billed. The open
          // invoice bills work with no activity behind it, so its lines carry none.
          await q(
            `insert into invoice_line_items (id, invoice_id, law_firm_id, kind, sort_order, source_id, name,
                                             description, line_date, quantity, rate_cents, amount_cents,
                                             user_id, user_name, charge_code_id)
             values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [id(G.line), spec.invoiceId, FIRM, line.kind, n, line.sourceId ? String(line.sourceId) : null,
              line.name, line.date, line.qty, line.rate, line.amount, line.userId, line.userName,
              line.chargeCodeId]
          );
          bump('invoice_line_items');
        }

        if (paid > 0) {
          // A fully paid invoice settles in two instalments; a partial one in a
          // single payment, so both payment histories are represented.
          const instalments = spec.paidRatio >= 1
            ? [[Math.round(paid / 2), day(-20), 'check', 'Check #4471'],
              [paid - Math.round(paid / 2), day(-8), 'ach', 'ACH transfer — balance']]
            : [[paid, day(-11), 'wire', 'Partial payment per client schedule']];
          for (const [n, [amount, date, source, note]] of instalments.entries()) {
            await q(
              `insert into invoice_payments (id, invoice_id, law_firm_id, sort_order, amount_cents,
                                             payment_date, payment_source, note, recorded_by, invoice_number)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [id(G.payment), spec.invoiceId, FIRM, n, amount, date, source, note, actor, spec.number]
            );
            bump('invoice_payments');
          }
        }
      }

      // ── trust: a retainer in, a disbursement out against the paid invoice ──
      // Dated recently so they land after whatever is already on the ledger; the
      // rows themselves are written after the matter loop (see pendingTrust).
      if (trustAccount) {
        const retainer = 500000;
        const disbursement = Math.min(sum(paidLines), retainer);
        pendingTrust.push(
          { type: 'deposit', amount: retainer, txnDate: day(-7), clientId, matterId: M,
            description: 'Initial retainer deposit', source: 'check', reference: `Check #${1100 + i}` },
          { type: 'withdrawal', amount: disbursement, txnDate: day(-3), clientId, matterId: M,
            description: `Applied to invoice SEED-${seq}-A`, source: 'ach', reference: `ACH-${5500 + i}` },
        );
      }

      // ── document request ──────────────────────────────────────────────────
      const [reqTitle, reqNote, reqItems] = pick(DOC_REQUEST_SETS, i);
      const requestId = id(G.docRequest);
      await q(
        `insert into document_requests (id, law_firm_id, matter_id, client_id, title, note, status, due_date,
                                        created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [requestId, FIRM, M, clientId, reqTitle, reqNote, i % 5 === 4 ? 'completed' : 'open',
          day(i % 5 === 4 ? -12 : 10), actor, ts(-18)]
      );
      bump('document_requests');
      for (const [n, [label, status]] of reqItems.entries()) {
        await q(
          `insert into document_request_items (id, law_firm_id, request_id, label, status, sort_order)
           values ($1,$2,$3,$4,$5,$6)`,
          [id(G.docItem), FIRM, requestId, label, i % 5 === 4 ? 'received' : status, n]
        );
        bump('document_request_items');
      }

      // ── conversation + messages ───────────────────────────────────────────
      // Only the first CONVERSATION_LIMIT matters get one: every thread lands in
      // the same firm-wide inbox, so one per matter buries the real conversations.
      if (i < CONVERSATION_LIMIT) {
        const conversationId = id(G.conversation);
        const messageSet = pick(MESSAGE_SETS, i);
        // Mirrors createGroupConversation: the label is `title`, and the matter
        // scope lives in conversation_matters with conversations.matter_id
        // carrying the primary matter for routing. A group with neither reads as
        // its participant list, which makes every seeded thread look identical.
        // `client_id` stays null: it holds a client's Firebase uid and is what
        // makes a conversation that client's one direct thread.
        await q(
          `insert into conversations (id, law_firm_id, client_id, conversation_type, title,
                                      matter_id, created_by, last_message_at, last_sender_user_id, created_at)
           values ($1,$2,null,'group',$3,$4,$5,$6,$5,$7)`,
          [conversationId, FIRM, `${matter.name}: case updates`, M, actor, ts(-1, 15), ts(-25)]
        );
        await q(
          `insert into conversation_matters (conversation_id, law_firm_id, matter_id, position)
           values ($1,$2,$3,0) on conflict do nothing`,
          [conversationId, FIRM, M]
        );
        bump('conversations');
        for (const tk of timekeepers) {
          await q(
            `insert into conversation_participants (conversation_id, law_firm_id, participant_user_id,
                                                    participant_type, added_by, added_at, last_read_at)
             values ($1,$2,$3,'firm_member',$4,$5,$6) on conflict do nothing`,
            [conversationId, FIRM, tk.user_id, actor, ts(-25), tk.user_id === actor ? ts(-1, 16) : null]
          );
        }
        for (const [n, content] of messageSet.entries()) {
          const sender = pick(timekeepers, i + n);
          await q(
            `insert into messages (id, law_firm_id, conversation_id, sender_user_id, content, sender_type,
                                   sender_name, read_by_firm, matter_id, status, kind, created_at)
             values ($1,$2,$3,$4,$5,'firm_member',$6,true,$7,'sent','user',$8)`,
            [id(G.message), FIRM, conversationId, sender.user_id, content, sender.name, M,
              ts(-18 + n * 5, 10 + n)]
          );
          bump('messages');
        }
      }

      // ── notifications: a light sprinkle, not one per matter ───────────────
      if (i % 4 === 0) {
        await q(
          `insert into notifications (id, law_firm_id, user_id, type, title, body, read, entity_type,
                                      entity_id, matter_id, action_url, created_by, created_at)
           values ($1,$2,$3,'invoice_sent','Invoice sent',$4,false,'invoice',$5,$6,$7,$3,$8)`,
          [id(G.notification), FIRM, actor,
            `Invoice SEED-${seq}-C was sent to ${clientName} on ${matter.name}.`,
            openInvoiceId, M, `${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${FIRM}/billing`, ts(-6)]
        );
        bump('notifications');
      }

      if (!SKIP_FILES) filePlans.push({ matterId: M, name: matter.name, plan: pick(FILE_SETS, i) });
    }

    // ── trust ledger: one ordered pass so the running balances read correctly ──
    if (trustAccount && pendingTrust.length) {
      pendingTrust.sort((a, b) => (a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1 : 0));
      for (const [n, txn] of pendingTrust.entries()) {
        const delta = txn.type === 'deposit' ? txn.amount : -txn.amount;
        trustAccountBalance += delta;
        const clientBalance = (trustClientBalances.get(txn.clientId) || 0) + delta;
        trustClientBalances.set(txn.clientId, clientBalance);
        // created_at increments with the sort position so ties on txn_date resolve
        // in the same order the balances were accumulated.
        const createdAt = new Date(`${txn.txnDate}T09:00:00Z`);
        createdAt.setUTCMinutes(createdAt.getUTCMinutes() + n);
        await q(
          `insert into trust_transactions (id, law_firm_id, trust_account_id, type, amount_cents, client_id,
                                           matter_id, txn_date, description, reference_number, source, status,
                                           client_balance_after_cents, account_balance_after_cents,
                                           created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12,$13,$14,$15)`,
          [id(G.trust), FIRM, trustAccount.id, txn.type, txn.amount, txn.clientId, txn.matterId,
            txn.txnDate, txn.description, txn.reference, txn.source, clientBalance,
            trustAccountBalance, actor, createdAt.toISOString()]
        );
        bump('trust_transactions');
      }
      await q('update trust_accounts set book_balance_cents = $1 where id = $2',
        [trustAccountBalance, trustAccount.id]);
    }

    await q('commit');

    // ── files: GCS is not transactional, so it runs after the commit ────────
    if (!SKIP_FILES) {
      // eslint-disable-next-line global-require
      const { adjustStorageUsageByDelta } = require('../../src/shared/utils/storageUsage');
      let addedBytes = 0;
      let removedBytes = 0;
      for (const fp of filePlans) {
        const res = await seedMatterFiles({
          bucket,
          filesRepo,
          query: (text: string, params?: any[]) => client.query(text, params),
          lawFirmId: FIRM,
          matterId: fp.matterId,
          actor,
          folders: FOLDERS,
          plan: fp.plan,
          fixtures,
          seedMark: SEED_MARK,
        });
        addedBytes += res.addedBytes;
        removedBytes += res.removedBytes;
        bump('files', fp.plan.length);
        bump('folders', FOLDERS.length);
      }
      await adjustStorageUsageByDelta(FIRM, addedBytes - removedBytes);
      totals.storageMB = Number((addedBytes / 1024 / 1024).toFixed(1));
    }

    console.log('Seeded:');
    for (const key of Object.keys(totals).sort()) {
      console.log(`  ${key.padEnd(26)} ${totals[key]}`);
    }
    if (trustAccount) {
      console.log(`\nTrust book balance: $${(trustAccountBalance / 100).toFixed(2)}`);
    } else {
      console.log('\nNo active trust account on this firm — trust entries were skipped.');
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

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
