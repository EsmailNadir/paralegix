/**
 * Seed a broad slice of demo data into ONE law firm on the LOCAL Postgres clone.
 *
 *   npx tsx backend/db/seed/seed-local-testdata.ts
 *   npx tsx backend/db/seed/seed-local-testdata.ts --firm <lawFirmId> --owner <userId>
 *   npx tsx backend/db/seed/seed-local-testdata.ts --portal-user <uid> --portal-email <email>
 *   DB_TARGET=staging npx tsx backend/db/seed/seed-local-testdata.ts ... --allow-remote
 *
 * The firm and the owner have to exist already. On an empty database, create
 * them first with bootstrap-demo-firm.ts, which prints the exact command to run
 * next.
 *
 * `--portal-user` turns the first seeded client, Marcus Whitfield, into a
 * working client-portal login for that Firebase uid. It is the client with the
 * most attached to it, so the portal gets two matters, a paid invoice, a trust
 * ledger, a two-sided conversation, a document request, client-visible notes
 * and calendar events, and its own notification feed. Portal Documents stays
 * empty either way: files need real bytes in GCS and are seeded separately.
 *
 * Every row it writes carries a fixed id prefixed with 7e57da7a ("testdata"), so the
 * script is idempotent: it deletes its own previous rows and re-inserts them. Nothing
 * that was cloned from staging is touched, apart from the firm's `plan` column (see
 * below).
 *
 * The seeded firm is switched to the enterprise plan with `unlimitedOverride`, because
 * the starter tier caps matters at 25 and gates off trust accounting, templates,
 * analytics, calendar sync, and e-signature - none of which could be exercised locally
 * otherwise.
 *
 * Refuses to run against a hosted Supabase database unless --allow-remote says
 * so on purpose, and refuses DB_TARGET=prod outright. Loads env from
 * backend/.env.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl, needsSsl } = require('../../src/shared/database/resolveDbUrl');

const DEFAULT_FIRM = '271a8a01-12fe-534a-9a5e-d2d0cbc72a8b';
const DEFAULT_OWNER = 'rioHoxMeFbTIy7dW9CsNrnKUBYZ2';

const argOf = (flag: any, fallback: any) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const FIRM = argOf('--firm', DEFAULT_FIRM);
const OWNER = argOf('--owner', DEFAULT_OWNER);

// Opt-in to writing to a hosted Supabase database, which is how staging gets
// seeded. Without it the guard in main() refuses any non-local URL.
const ALLOW_REMOTE = process.argv.includes('--allow-remote');

// When set, the first seeded client becomes a working client-portal login for
// this Firebase uid. Portal access is `clients.user_id` and nothing else, so
// stamping the uid onto a client that already owns matters, invoices, trust
// entries, a conversation and a document request is what gives the portal
// something to show.
const PORTAL_USER = argOf('--portal-user', null);
const PORTAL_EMAIL = argOf('--portal-email', null);

// Fixed-id namespace. Every seeded row's id starts with this, which is what makes
// the delete-then-insert cleanup below both precise and safe.
const NS = '7e57da7a';

// Deterministic per-firm fragment folded into every generated id below, so seeding two
// different --firm values never produces the same id twice: ids carry a bare sequence
// number (PA(1), MATTER(1), ...) that would otherwise collide across firms on the `id`
// primary key the moment this script is run for a second firm. FNV-1a is just a cheap,
// stable hash; nothing about it needs to be cryptographic for dev-tooling ids.
function firmFragment(firmId: string) {
  let hash = 2166136261;
  for (let i = 0; i < firmId.length; i++) {
    hash ^= firmId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
const FIRM_FRAGMENT = firmFragment(FIRM);
const id = (group: any, n: any) =>
  `${NS}-${group}-4${FIRM_FRAGMENT.slice(0, 3)}-8${FIRM_FRAGMENT.slice(3, 6)}-${String(n).padStart(12, '0')}`;

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

const PA = (n: any) => id('0001', n);
const STAGE = (n: any) => id('0002', n);
const CLIENT = (n: any) => id('0003', n);
const MATTER = (n: any) => id('0004', n);
const TASK = (n: any) => id('0005', n);
const TIME = (n: any) => id('0006', n);
const EXPENSE = (n: any) => id('0007', n);
const INVOICE = (n: any) => id('0008', n);
const TRUST_ACCT = (n: any) => id('0009', n);
const CONV = (n: any) => id('000a', n);
const MSG = (n: any) => id('000b', n);
const EVENT = (n: any) => id('000c', n);
const NOTIF = (n: any) => id('000d', n);
const CHARGE = (n: any) => id('000e', n);
const EXPCAT = (n: any) => id('000f', n);
const DOCREQ = (n: any) => id('0010', n);
const CONTACT = (n: any) => id('0011', n);
const MNOTE = (n: any) => id('0012', n);
const SUBTASK = (n: any) => id('0013', n);
const LINE = (n: any) => id('0014', n);
const PAYMENT = (n: any) => id('0015', n);
const TRUST_TXN = (n: any) => id('0016', n);
const FLATFEE = (n: any) => id('0017', n);
const DOCITEM = (n: any) => id('0018', n);
const CCONTACT = (n: any) => id('0019', n);
const DIRCONTACT = (n: any) => id('001a', n);
const PIPELINE = (n: any) => id('001b', n);
const ACTLOG = (n: any) => id('001c', n);

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
    const { rows: firmRows } = await q('select id, name from law_firms where id = $1', [FIRM]);
    if (!firmRows.length) throw new Error(`Law firm ${FIRM} not found.`);
    const { rows: ownerRows } = await q(
      'select user_id from members where law_firm_id = $1 and user_id = $2',
      [FIRM, OWNER]
    );
    if (!ownerRows.length) throw new Error(`User ${OWNER} is not a member of ${FIRM}.`);

    console.log(`Seeding "${firmRows[0].name}" (${FIRM}) as ${OWNER}\n`);

    await q('begin');
    // Lets the cleanup delete seeded trust transactions and billed activities, which
    // their respective append-only / freeze-on-invoice triggers otherwise refuse to
    // touch, and skips every other trigger (updated_at bumps, etc.) for this
    // transaction. Referential integrity is NOT checked while this is set (FK
    // enforcement is itself trigger-based), so insert/delete order below is chosen
    // for readability, not correctness.
    await q("set local session_replication_role = 'replica'");

    // ── cleanup: drop everything this script wrote on a previous run ─────────
    // Every delete is scoped to THIS firm as well as the id prefix: the id prefix
    // (NS) is the same fixed namespace for every firm this script ever seeds, so
    // without the law_firm_id filter, re-running for a second --firm would delete
    // the first firm's already-seeded rows too (they'd all match `like`, just not
    // the same firm). The per-firm id fragment above stops the two firms' rows
    // from colliding on insert; this stops the cleanup from cross-deleting them.
    const like = `${NS}-%`;
    const byId = [
      'document_request_items', 'document_requests', 'invoice_payments', 'invoice_line_items',
      'invoices', 'activities', 'task_subtasks', 'tasks', 'trust_transactions', 'trust_accounts',
      'messages', 'conversations', 'events', 'notifications', 'activity_log', 'notes',
      'matter_contacts', 'contact_clients', 'contacts', 'matters', 'matter_stages',
      'matter_stage_pipelines', 'clients', 'billing_codes', 'practice_areas',
    ];
    for (const table of byId) {
      await q(`delete from ${table} where id::text like $1 and law_firm_id = $2`, [like, FIRM]);
    }
    // Client contact links predating this script are not id-prefixed: migration
    // 0136 folded the old `client_contacts` rows into `contact_clients` with
    // fresh ids. Left behind, one of them holds the single-primary index for a
    // seeded client and the re-insert below collides with it.
    await q('delete from contact_clients where client_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from contact_clients where contact_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from matter_clients where matter_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from matter_members where matter_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from task_assignees where task_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from conversation_participants where conversation_id::text like $1 and law_firm_id = $2', [like, FIRM]);
    await q('delete from conversation_matters where conversation_id::text like $1 and law_firm_id = $2', [like, FIRM]);

    // ── plan: lift the starter caps so every module is reachable locally ─────
    await q(
      `update law_firms
          set plan_id = 'enterprise',
              billing_status = 'comped',
              plan = coalesce(plan, '{}'::jsonb)
                     || jsonb_build_object('planId','enterprise','comped',true,'unlimitedOverride',true)
        where id = $1`,
      [FIRM]
    );

    // ── practice areas ──────────────────────────────────────────────────────
    const practiceAreas: any[][] = [
      [PA(1), 'Personal Injury', 0],
      [PA(2), 'Family Law', 1],
      [PA(3), 'Criminal Defense', 2],
      [PA(4), 'Estate Planning', 3],
      [PA(5), 'Business Law', 4],
    ];
    // A firm created through signup already carries these five names among its
    // ten default practice areas, and the table has no unique (law_firm_id,
    // name). Inserting blind would leave every picker showing "Personal Injury"
    // twice, so reuse the firm's own row when the name is already taken and
    // remember which id the matters below have to point at.
    const paIds = new Map<string, string>();
    for (const [pid, name, sort] of practiceAreas) {
      const { rows: taken } = await q(
        'select id from practice_areas where law_firm_id = $1 and lower(name) = lower($2) limit 1',
        [FIRM, name]
      );
      if (taken.length) {
        paIds.set(pid, taken[0].id);
        continue;
      }
      await q(
        `insert into practice_areas (id, law_firm_id, name, sort_order, created_by)
         values ($1,$2,$3,$4,$5)`,
        [pid, FIRM, name, sort, OWNER]
      );
      paIds.set(pid, pid);
    }
    // Resolves a PA(n) placeholder to whichever row the matters and pipelines
    // must actually reference: the seeded one, or the firm's pre-existing one.
    const paRef = (pid: string) => paIds.get(pid) || pid;

    // ── matter stage pipelines (one default pipeline per practice area) ─────
    const pipelines = [
      [PIPELINE(1), PA(1), 'Personal Injury Pipeline'],
      [PIPELINE(2), PA(2), 'Family Law Pipeline'],
      [PIPELINE(3), PA(3), 'Criminal Defense Pipeline'],
      [PIPELINE(4), PA(4), 'Estate Planning Pipeline'],
      [PIPELINE(5), PA(5), 'Business Law Pipeline'],
    ];
    for (const [plid, paId, name] of pipelines) {
      await q(
        `insert into matter_stage_pipelines (id, law_firm_id, practice_area_id, name, is_default)
         values ($1,$2,$3,$4,true)`,
        [plid, FIRM, paRef(paId), name]
      );
    }

    // ── matter stages (branching tree via parent_stage_id, one pipeline each) ─
    const stages = [
      [STAGE(1), PIPELINE(1), 'Intake', null, '#64748b', 0, false],
      [STAGE(2), PIPELINE(1), 'Investigation', STAGE(1), '#0ea5e9', 1, false],
      [STAGE(3), PIPELINE(1), 'Demand', STAGE(2), '#f59e0b', 2, false],
      [STAGE(4), PIPELINE(1), 'Litigation', STAGE(3), '#ef4444', 3, false],
      [STAGE(5), PIPELINE(1), 'Settlement', STAGE(3), '#22c55e', 4, true],
      [STAGE(6), PIPELINE(2), 'Consultation', null, '#64748b', 0, false],
      [STAGE(7), PIPELINE(2), 'Filing', STAGE(6), '#0ea5e9', 1, false],
      [STAGE(8), PIPELINE(2), 'Final Decree', STAGE(7), '#22c55e', 2, true],
      [STAGE(9), PIPELINE(3), 'Arraignment', null, '#64748b', 0, false],
      [STAGE(10), PIPELINE(3), 'Pretrial', STAGE(9), '#f59e0b', 1, false],
      [STAGE(11), PIPELINE(3), 'Trial', STAGE(10), '#ef4444', 2, false],
      [STAGE(12), PIPELINE(4), 'Drafting', null, '#64748b', 0, false],
      [STAGE(13), PIPELINE(4), 'Execution', STAGE(12), '#0ea5e9', 1, false],
      [STAGE(14), PIPELINE(4), 'Complete', STAGE(13), '#22c55e', 2, true],
      [STAGE(15), PIPELINE(5), 'Engagement', null, '#64748b', 0, false],
      [STAGE(16), PIPELINE(5), 'Review', STAGE(15), '#0ea5e9', 1, false],
      [STAGE(17), PIPELINE(5), 'Resolution', STAGE(16), '#22c55e', 2, true],
    ];
    for (const [sid, plid, name, parent, color, sort, isClosed] of stages) {
      await q(
        `insert into matter_stages (id, law_firm_id, pipeline_id, name, parent_stage_id, color, sort_order, is_closed)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sid, FIRM, plid, name, parent, color, sort, isClosed]
      );
    }

    // ── billing catalogs (one table, kind = 'charge' | 'expense') ────────────
    const chargeCodes: any[][] = [
      [CHARGE(1), 'TEST-ATTY', 'Attorney Time', 35000, 0],
      [CHARGE(2), 'TEST-PARA', 'Paralegal Time', 15000, 1],
      [CHARGE(3), 'TEST-COURT', 'Court Appearance', 45000, 2],
      [CHARGE(4), 'TEST-ADMIN', 'Administrative', 9000, 3],
    ];
    for (const [cid, code, name, rateCents, sort] of chargeCodes) {
      await q(
        `insert into billing_codes (id, law_firm_id, kind, code, name, sort_order, is_active, default_rate_cents, created_by)
         values ($1,$2,'charge',$3,$4,$5,true,$6,$7)`,
        [cid, FIRM, code, name, sort, rateCents, OWNER]
      );
    }
    const expenseCats = [
      [EXPCAT(1), 'TEST-FILING', 'Filing Fees', 0],
      [EXPCAT(2), 'TEST-TRAVEL', 'Travel', 1],
      [EXPCAT(3), 'TEST-EXPERT', 'Expert Witness', 2],
      [EXPCAT(4), 'TEST-COPY', 'Copying & Postage', 3],
    ];
    for (const [eid, code, name, sort] of expenseCats) {
      await q(
        `insert into billing_codes (id, law_firm_id, kind, code, name, sort_order, is_active, created_by)
         values ($1,$2,'expense',$3,$4,$5,true,$6)`,
        [eid, FIRM, code, name, sort, OWNER]
      );
    }

    // ── clients ─────────────────────────────────────────────────────────────
    const clients = [
      [CLIENT(1), 'Marcus Whitfield', 'marcus.whitfield@example.test', '+1-614-555-0142', null, '88 Oakhurst Ln, Columbus, OH 43215'],
      [CLIENT(2), 'Priya Raman', 'priya.raman@example.test', '+1-614-555-0177', 'Raman Design Co.', '410 Broad St, Columbus, OH 43215'],
      [CLIENT(3), 'Delgado Freight LLC', 'ap@delgadofreight.example.test', '+1-937-555-0110', 'Delgado Freight LLC', '2200 Industrial Pkwy, Dayton, OH 45402'],
      [CLIENT(4), 'Aisha Bello', 'aisha.bello@example.test', '+1-513-555-0163', null, '77 Vine St, Cincinnati, OH 45202'],
      [CLIENT(5), 'Thomas Okafor', 'thomas.okafor@example.test', '+1-216-555-0198', null, '15 Lakeside Ave, Cleveland, OH 44114'],
      [CLIENT(6), 'Elena Nguyen', 'elena.nguyen@example.test', '+1-614-555-0119', null, '203 Maple Grove Rd, Columbus, OH 43220'],
      [CLIENT(7), 'Marcus Harrington', 'marcus.harrington@example.test', '+1-937-555-0184', null, '55 Riverbend Dr, Dayton, OH 45409'],
      [CLIENT(8), 'Javier Vasquez', 'javier.vasquez@example.test', '+1-216-555-0155', null, '981 Shoreline Blvd, Cleveland, OH 44113'],
    ];
    for (const [cid, name, email, phone, org, address] of clients) {
      // The first client doubles as the portal login when --portal-user is set.
      // It is the one with the most to look at: two matters, a paid invoice, a
      // trust ledger, a conversation, a document request and client-visible
      // notes. `user_id` is the whole of portal access; `joined_at` and
      // `portal_invite_pending` only mirror that state back to the firm's
      // client list.
      const isPortal = PORTAL_USER && cid === CLIENT(1);
      await q(
        `insert into clients (id, law_firm_id, name, email, phone, organization, address, status,
                              preferred_contact_method, user_id, joined_at, portal_invite_pending, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,'active','email',$8,$9,false,$10)`,
        [cid, FIRM, name, isPortal && PORTAL_EMAIL ? PORTAL_EMAIL : email, phone, org, address,
          isPortal ? PORTAL_USER : null, isPortal ? ts(-118) : null, ts(-120)]
      );
    }
    // A client's people are directory contacts linked through contact_clients.
    const clientPeople = [
      [CCONTACT(1), DIRCONTACT(10), CLIENT(3), 'Renata Delgado', 'renata@delgadofreight.example.test', '+1-937-555-0111', 'Operations Director', 'primary_contact', true],
      [CCONTACT(2), DIRCONTACT(11), CLIENT(1), 'Sam Whitfield', 'sam.whitfield@example.test', '+1-614-555-0143', null, 'spouse', false],
    ];
    for (const [linkId, contactId, clientId, name, email, phone, title, relationship, isPrimary] of clientPeople) {
      await q(
        `insert into contacts (id, law_firm_id, name, category, email, phone, title, created_by)
         values ($1,$2,$3,'other',$4,$5,$6,$7)`,
        [contactId, FIRM, name, email, phone, title, OWNER]
      );
      await q(
        `insert into contact_clients (id, law_firm_id, contact_id, client_id, relationship, is_primary, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [linkId, FIRM, contactId, clientId, relationship, isPrimary, OWNER]
      );
    }

    // ── matters ─────────────────────────────────────────────────────────────
    // [id, name, number, ref, paId, stageId, pipelineId, status, billing, clientId, desc, budget, openOffset, closeOffset, solOffset]
    const matters: any[][] = [
      [MATTER(1), 'Whitfield v. Ridgeline Transport', 'TEST-2026-001', 'CP-TEST01', PA(1), STAGE(3), PIPELINE(1), 'active', 'hourly', CLIENT(1), 'Rear-end collision on I-70; policy limits demand pending.', 950000, -95, null, 660],
      [MATTER(2), 'Nguyen v. QuickMart Grocers', 'TEST-2026-002', 'CP-TEST02', PA(1), STAGE(2), PIPELINE(1), 'active', 'contingency', CLIENT(6), 'Slip and fall in the produce aisle; liability contested.', 0, -35, null, 720],
      [MATTER(3), 'Bello Dissolution', 'TEST-2026-003', 'CP-TEST03', PA(2), STAGE(7), PIPELINE(2), 'active', 'hourly', CLIENT(4), 'Contested dissolution with minor children and a shared business.', 600000, -150, null, null],
      [MATTER(4), 'Harrington Custody Modification', 'TEST-2026-004', 'CP-TEST04', PA(2), STAGE(6), PIPELINE(2), 'pending', 'hourly', CLIENT(7), 'Petition to modify the existing parenting schedule.', 200000, -10, null, null],
      [MATTER(5), 'State v. Okafor', 'TEST-2026-005', 'CP-TEST05', PA(3), STAGE(10), PIPELINE(3), 'on_hold', 'flat', CLIENT(5), 'Misdemeanor OVI; suppression motion pending.', 350000, -30, null, 200],
      [MATTER(6), 'State v. Vasquez', 'TEST-2026-006', 'CP-TEST06', PA(3), STAGE(10), PIPELINE(3), 'active', 'flat', CLIENT(8), 'DUI defense; pretrial conference scheduled.', 440000, -28, null, 210],
      [MATTER(7), 'Whitfield Estate Plan', 'TEST-2026-007', 'CP-TEST07', PA(4), STAGE(14), PIPELINE(4), 'closed', 'flat', CLIENT(1), 'Will, POA, and healthcare directive package.', 150000, -240, -20, null],
      [MATTER(8), 'Raman Family Trust', 'TEST-2026-008', 'CP-TEST08', PA(4), STAGE(14), PIPELINE(4), 'completed', 'flat', CLIENT(2), 'Revocable trust and pour-over will.', 180000, -200, -70, null],
      [MATTER(9), 'Raman Trademark Dispute', 'TEST-2026-009', 'CP-TEST09', PA(5), STAGE(16), PIPELINE(5), 'active', 'hourly', CLIENT(2), 'Opposition filed against confusingly similar mark.', 400000, -60, null, null],
      [MATTER(10), 'Delgado Freight - DOT Compliance Audit', 'TEST-2026-010', 'CP-TEST10', PA(5), STAGE(16), PIPELINE(5), 'active', 'flat', CLIENT(3), 'Federal DOT audit response and corrective action plan.', 250000, -45, null, null],
      [MATTER(11), 'Delgado Freight - Vendor Contract Review', 'TEST-2026-011', 'CP-TEST11', PA(5), STAGE(15), PIPELINE(5), 'blocked', 'hourly', CLIENT(3), 'Redlining the master service agreement with a new carrier.', 80000, -14, null, null],
      [MATTER(12), 'Bello Business Dissolution Buyout', 'TEST-2026-012', 'CP-TEST12', PA(5), STAGE(17), PIPELINE(5), 'archived', 'hourly', CLIENT(4), 'Buyout of the shared business interest, wrapped alongside the divorce.', 120000, -260, -100, null],
    ];
    for (const [mid, name, number, ref, paId, stageId, plid, status, billing, clientId, desc, budget, openOffset, closeOffset, solOffset] of matters) {
      await q(
        `insert into matters (id, law_firm_id, name, matter_number, matter_reference_id, description, status,
                              practice_area_id, stage_id, stage_pipeline_id, billing_method, is_billable, budget_cents,
                              budget_includes_expenses, open_date, close_date, statute_of_limitations_date,
                              lead_user_id, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,true,$13,$14,$15,$16,$16,$17)`,
        [mid, FIRM, name, number, ref, desc, status, paRef(paId), stageId, plid, billing, budget,
          day(openOffset), closeOffset == null ? null : day(closeOffset), solOffset == null ? null : day(solOffset),
          OWNER, ts(-100)]
      );
      await q('insert into matter_clients (matter_id, client_id, law_firm_id) values ($1,$2,$3)', [mid, clientId, FIRM]);
      await q(
        `insert into matter_members (matter_id, user_id, law_firm_id, role, hourly_rate_cents, joined_at)
         values ($1,$2,$3,'lead',35000,$4)`,
        [mid, OWNER, FIRM, ts(-100)]
      );
    }
    // Quick lookup from matter id to its client id, used below for invoices.
    const matterClient = new Map(matters.map((m) => [m[0], m[9]]));

    // ── matter contacts / notes / activity log ──────────────────────────────
    const matterContacts = [
      [CONTACT(1), MATTER(1), 'Gregory Hain', 'opposing_counsel', 'Hain & Stroud LLP', 'ghain@hainstroud.example.test', '+1-614-555-0201'],
      [CONTACT(2), MATTER(1), 'Ridgeline Transport, Inc.', 'opposing_party', 'Ridgeline Transport', null, null],
      [CONTACT(3), MATTER(1), 'Dana Kirby', 'adjuster', 'Meridian Casualty', 'dkirby@meridiancas.example.test', '+1-800-555-0134'],
      [CONTACT(4), MATTER(3), 'Hon. Alicia Duran', 'judge', 'Hamilton County Domestic Relations', null, null],
      [CONTACT(5), MATTER(5), 'Officer R. Pinsky', 'witness', 'Cleveland PD', null, null],
      [CONTACT(6), MATTER(2), 'QuickMart Grocers #14', 'opposing_party', 'QuickMart Grocers', null, null],
      [CONTACT(7), MATTER(6), 'Hon. Priya Sethi', 'judge', 'Cuyahoga County Municipal Court', null, null],
    ];
    // The identity fields land in the firm-wide `contacts` directory; the matter
    // row is only the link plus the role played there.
    for (const [n, [cid, mid, name, role, org, email, phone]] of matterContacts.entries()) {
      const contactId = DIRCONTACT(n + 1);
      await q(
        `insert into contacts (id, law_firm_id, name, category, organization, email, phone, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [contactId, FIRM, name, role, org, email, phone, OWNER]
      );
      await q(
        `insert into matter_contacts (id, law_firm_id, matter_id, contact_id, role, created_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [cid, FIRM, mid, contactId, role, OWNER]
      );
    }

    const matterNotes: any[][] = [
      [MNOTE(1), MATTER(1), 'Demand package sent', 'Sent the policy-limits demand with the full medical chronology. Adjuster acknowledged receipt and asked for 30 days.', true, -14],
      [MNOTE(2), MATTER(1), 'IME scheduled', 'Defense requested an independent medical exam; scheduling for next month.', false, -6],
      [MNOTE(3), MATTER(3), 'Client call - parenting schedule', 'Client wants alternating weeks; opposing counsel proposed 2-2-3. Discussed cost of contesting.', true, -9],
      [MNOTE(4), MATTER(5), 'Suppression theory', 'Dashcam shows the stop began before the alleged lane deviation. Ordering the full CAD log.', false, -5],
      [MNOTE(5), MATTER(9), 'Opposition strategy', 'TTAB opposition response is due in three weeks; drafting the likelihood-of-confusion argument now.', false, -3],
    ];
    // The boolean column in each row above is unused: notes are firm-internal
    // since migration 0032 dropped notes.client_visible.
    for (const [nid, mid, subject, content, , offset] of matterNotes) {
      await q(
        `insert into notes (id, law_firm_id, matter_id, subject, content, note_type, created_by, note_date, created_at)
         values ($1,$2,$3,$4,$5,'general',$6,$7,$8)`,
        [nid, FIRM, mid, subject, content, OWNER, day(offset), ts(offset)]
      );
    }

    const activityLog: any[][] = [
      [ACTLOG(1), MATTER(1), 'stage_changed', 'Stage moved from Investigation to Demand', -14],
      [ACTLOG(2), MATTER(1), 'note_added', 'Note added: Demand package sent', -14],
      [ACTLOG(3), MATTER(10), 'matter_created', 'Matter opened', -45],
      [ACTLOG(4), MATTER(5), 'status_changed', 'Status changed to on_hold', -30],
      [ACTLOG(5), MATTER(6), 'matter_created', 'Matter opened', -28],
    ];
    for (const [alid, mid, type, summary, offset] of activityLog) {
      await q(
        `insert into activity_log (id, law_firm_id, matter_id, activity_type, actor_user_id, actor_name, summary, created_at)
         values ($1,$2,$3,$4,$5,'Test Owner',$6,$7)`,
        [alid, FIRM, mid, type, OWNER, summary, ts(offset)]
      );
    }

    // ── tasks (mixed status/priority, overdue -> future, across every matter) ─
    const tasks: any[][] = [
      [TASK(1), MATTER(1), 'File the complaint before the SOL runs', 'open', 'urgent', -3],
      [TASK(2), MATTER(1), 'Follow up with Meridian adjuster on demand', 'open', 'high', 1],
      [TASK(3), MATTER(1), 'Order updated medical records from OSU', 'in_progress', 'medium', 6],
      [TASK(4), MATTER(9), 'Draft opposition response brief', 'open', 'high', 4],
      [TASK(5), MATTER(9), 'Trademark search refresh', 'completed', 'low', -12],
      [TASK(6), MATTER(10), 'Assemble DOT corrective action plan', 'in_progress', 'urgent', 2],
      [TASK(7), MATTER(10), 'Driver qualification file audit', 'blocked', 'medium', 9],
      [TASK(8), MATTER(3), 'Prepare parenting-time proposal', 'open', 'high', 0],
      [TASK(9), MATTER(3), 'Serve discovery requests', 'completed', 'medium', -25],
      [TASK(10), MATTER(5), 'Draft motion to suppress', 'open', 'urgent', 5],
      [TASK(11), MATTER(5), 'Subpoena CAD log and dashcam', 'open', 'high', -1],
      [TASK(12), MATTER(7), 'Deliver executed estate binder', 'completed', 'low', -22],
      [TASK(13), null, 'Quarterly trust account three-way reconciliation', 'open', 'high', 11],
      [TASK(14), null, 'Renew CLE credits', 'open', 'low', -40],
      [TASK(15), MATTER(2), 'Initial client intake and injury assessment', 'completed', 'medium', -25],
      [TASK(16), MATTER(2), 'Draft demand letter - premises liability', 'open', 'high', 8],
      [TASK(17), MATTER(4), 'Initial custody consultation notes', 'open', 'medium', 3],
      [TASK(18), MATTER(4), 'File motion to modify parenting plan', 'open', 'high', 14],
      [TASK(19), MATTER(6), 'Prepare arraignment paperwork', 'completed', 'medium', -27],
      [TASK(20), MATTER(6), 'Client check-in before pretrial', 'open', 'medium', 6],
      [TASK(21), MATTER(8), 'Finalize revocable trust signature package', 'completed', 'low', -75],
      [TASK(22), MATTER(11), 'Review vendor MSA redlines', 'in_progress', 'medium', -3],
      [TASK(23), MATTER(12), 'Close out dissolution buyout file', 'completed', 'low', -100],
    ];
    for (const [tid, mid, title, status, priority, offset] of tasks) {
      await q(
        `insert into tasks (id, law_firm_id, title, matter_id, status, priority, due_date, due_date_timezone, all_day, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,'America/New_York',true,$8,$9)`,
        [tid, FIRM, title, mid, status, priority, day(offset), OWNER, ts(-20)]
      );
      await q('insert into task_assignees (law_firm_id, task_id, user_id) values ($1,$2,$3)', [FIRM, tid, OWNER]);
    }

    const subtasks = [
      [SUBTASK(1), TASK(1), 'Confirm the SOL date against the crash report', true, 0],
      [SUBTASK(2), TASK(1), 'Finalize the caption and parties', false, 1],
      [SUBTASK(3), TASK(1), 'E-file and pay the filing fee', false, 2],
      [SUBTASK(4), TASK(6), 'Interview the safety manager', true, 0],
      [SUBTASK(5), TASK(6), 'Pull the last 12 months of HOS logs', false, 1],
      [SUBTASK(6), TASK(10), 'Pull the traffic-stop video frame by frame', false, 0],
      [SUBTASK(7), TASK(16), 'Attach the incident report and photos', false, 0],
    ];
    for (const [sid, tid, title, done, sort] of subtasks) {
      await q(
        `insert into task_subtasks (id, law_firm_id, task_id, title, is_completed, sort_order, created_by, completed_at, completed_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sid, FIRM, tid, title, done, sort, OWNER, done ? ts(-5) : null, done ? OWNER : null]
      );
    }

    // ── activities: time entries (kind = 'time') ─────────────────────────────
    // [id, matterId, hours, rateCents, chargeCodeId, name, desc, offsetDays, billed]
    // `name` is the short title an invoice prints in bold and `desc` the line of
    // detail under it. They are two columns the UI draws in two places, so they
    // are seeded as two different strings: seeding one string into both is what
    // made every demo invoice appear to print its line twice.
    // `billed` is bookkeeping for this script only: the table has no billed column,
    // that status is derived entirely from whether an invoice_line_item.source_id
    // points back at the row. Entries marked billed get a matching line item below.
    const timeEntries: any[][] = [
      [TIME(1), MATTER(1), 3.4, 35000, CHARGE(1), 'Demand letter drafting', 'Draft policy-limits demand letter and medical chronology', -40, true],
      [TIME(2), MATTER(1), 1.2, 35000, CHARGE(1), 'Adjuster call', 'Call with adjuster re: demand receipt', -38, true],
      [TIME(3), MATTER(1), 0.8, 15000, CHARGE(2), 'Medical billing summary', 'Assemble medical billing summary', -36, true],
      [TIME(4), MATTER(1), 2.1, 35000, CHARGE(1), 'Legal research', 'Research comparative negligence under Ohio law', -12, false],
      [TIME(5), MATTER(1), 0.5, 35000, CHARGE(1), 'Correspondence review', 'Review IME scheduling correspondence', -6, false],
      [TIME(6), MATTER(9), 4.6, 35000, CHARGE(1), 'Opposition brief', 'Draft opposition response brief - first pass', -20, true],
      [TIME(7), MATTER(9), 1.5, 15000, CHARGE(2), 'Trademark search', 'Trademark database search and screenshot exhibits', -18, true],
      [TIME(8), MATTER(10), 5.2, 35000, CHARGE(1), 'Audit interview prep', 'DOT audit interview prep with safety manager', -22, true],
      [TIME(9), MATTER(10), 3.0, 15000, CHARGE(2), 'Driver file review', 'Driver qualification file review', -21, true],
      [TIME(10), MATTER(3), 2.7, 35000, CHARGE(1), 'Parenting-time proposal', 'Prepare parenting-time proposal and cost analysis', -15, true],
      [TIME(11), MATTER(3), 1.9, 45000, CHARGE(3), 'Pretrial conference', 'Appeared at the pretrial conference on the contested motion', -10, true],
      [TIME(12), MATTER(3), 0.6, 9000, CHARGE(4), 'Decree filing', 'File-stamp and calendar the decree deadlines', -9, true],
      [TIME(13), MATTER(5), 3.3, 35000, CHARGE(1), 'Motion to suppress', 'Motion to suppress - dashcam timeline analysis', -7, false],
      [TIME(14), MATTER(6), 2.0, 45000, CHARGE(3), 'Arraignment', 'Appeared with the client at arraignment and entered a plea', -25, true],
      [TIME(15), MATTER(7), 4.0, 35000, CHARGE(1), 'Estate document drafting', 'Draft will, POA, and healthcare directive', -60, true],
      [TIME(16), MATTER(1), 1.1, 35000, CHARGE(1), 'Client update call', 'Client update call re: demand status', -2, false],
      [TIME(17), MATTER(9), 0.9, 35000, CHARGE(1), 'Extension request review', 'Review opposing counsel extension request', -1, false],
      [TIME(18), MATTER(10), 8.6, 35000, CHARGE(1), 'Corrective action plan', 'Corrective action plan drafting', -20, true],
      [TIME(19), MATTER(2), 2.5, 35000, CHARGE(1), 'Client intake', 'Initial client intake and injury assessment', -25, false],
      [TIME(20), MATTER(2), 1.8, 35000, CHARGE(1), 'Demand letter drafting', 'Demand letter draft - premises liability', -10, false],
      [TIME(21), MATTER(4), 1.2, 35000, CHARGE(1), 'Initial consultation', 'Initial consultation notes', -5, false],
      [TIME(22), MATTER(8), 3.0, 35000, CHARGE(1), 'Trust drafting', 'Draft revocable trust and pour-over will', -80, false],
      [TIME(23), MATTER(11), 1.0, 35000, CHARGE(1), 'Contract review', 'Review vendor MSA redlines', -3, false],
    ];
    const timeById = new Map(timeEntries.map((t) => [t[0], t]));
    for (const [tid, mid, hours, rate, chargeId, name, desc, offset] of timeEntries) {
      await q(
        `insert into activities (id, law_firm_id, kind, matter_id, user_id, activity_date, name, description,
                                 billable, hours, rate_cents, billing_code_id, source, created_by, created_at)
         values ($1,$2,'time',$3,$4,$5,$6,$7,true,$8,$9,$10,'manual',$4,$11)`,
        [tid, FIRM, mid, OWNER, day(offset), name, desc, hours, rate, chargeId, ts(offset)]
      );
    }

    // ── activities: expenses (kind = 'expense') ──────────────────────────────
    // [id, matterId, amountCents, expenseCodeId, desc, vendor, offsetDays, billed]
    const expenses: any[][] = [
      [EXPENSE(1), MATTER(1), 35500, EXPCAT(1), 'Complaint filing fee', 'Franklin County Clerk', -40, true],
      [EXPENSE(2), MATTER(1), 12400, EXPCAT(4), 'Certified medical records', 'OSU Medical Records', -37, true],
      [EXPENSE(3), MATTER(1), 250000, EXPCAT(3), 'Accident reconstruction retainer', 'Vance Forensics', -14, false],
      [EXPENSE(4), MATTER(9), 40000, EXPCAT(1), 'TTAB filing fee', 'USPTO', -19, true],
      [EXPENSE(5), MATTER(10), 8900, EXPCAT(2), 'Mileage - Dayton site visit', null, -22, true],
      [EXPENSE(6), MATTER(3), 30000, EXPCAT(1), 'Dissolution filing fee', 'Hamilton County Clerk', -50, true],
      [EXPENSE(7), MATTER(5), 7500, EXPCAT(4), 'Records subpoena service', 'Buckeye Process', -6, false],
      [EXPENSE(8), MATTER(7), 4200, EXPCAT(4), 'Notary and binder printing', null, -55, true],
      [EXPENSE(9), MATTER(2), 15000, EXPCAT(4), 'Medical records request', 'Riverside Medical Center', -20, false],
    ];
    const expenseById = new Map(expenses.map((e) => [e[0], e]));
    for (const [eid, mid, amount, catId, desc, vendor, offset] of expenses) {
      await q(
        `insert into activities (id, law_firm_id, kind, matter_id, user_id, activity_date, description,
                                 billable, charge_cents, billing_code_id, vendor, created_by, created_at)
         values ($1,$2,'expense',$3,$4,$5,$6,true,$7,$8,$9,$4,$10)`,
        [eid, FIRM, mid, OWNER, day(offset), desc, amount, catId, vendor, ts(offset)]
      );
    }

    // ── activities: flat fees (kind = 'flat_fee') ────────────────────────────
    // [id, matterId, amountCents, desc, offsetDays, billed]
    const flatFees: any[][] = [
      [FLATFEE(1), MATTER(10), 250000, 'DOT compliance audit response - flat engagement', -22, true],
      [FLATFEE(2), MATTER(5), 350000, 'OVI defense through pretrial - flat fee', -30, false],
      [FLATFEE(3), MATTER(6), 350000, 'DUI defense flat engagement', -28, true],
    ];
    const flatFeeById = new Map(flatFees.map((f) => [f[0], f]));
    for (const [fid, mid, amount, desc, offset] of flatFees) {
      await q(
        `insert into activities (id, law_firm_id, kind, matter_id, activity_date, description, billable, charge_cents, created_by, created_at)
         values ($1,$2,'flat_fee',$3,$4,$5,true,$6,$7,$8)`,
        [fid, FIRM, mid, day(offset), desc, amount, OWNER, ts(offset)]
      );
    }

    // ── invoices: paid, partially paid, draft, outstanding, overdue ──────────
    // [id, matterId, invoiceNumber, status, invoiceOffset, dueOffset, lineIds]
    // lineIds reference the activities above; the loop derives kind/qty/rate/
    // amount/date from the matching activity so the numbers always agree.
    const invoiceDefs: any[][] = [
      [INVOICE(1), MATTER(1), 'TEST-1001', 'paid', -35, -5, [TIME(1), TIME(2), TIME(3), EXPENSE(1), EXPENSE(2)]],
      [INVOICE(2), MATTER(10), 'TEST-1002', 'partially_paid', -20, 10, [TIME(8), TIME(9), TIME(18), FLATFEE(1), EXPENSE(5)]],
      [INVOICE(3), MATTER(7), 'TEST-1003', 'draft', -3, 27, [TIME(15), EXPENSE(8)]],
      [INVOICE(4), MATTER(9), 'TEST-1004', 'outstanding', -10, 25, [TIME(6), TIME(7), EXPENSE(4)]],
      [INVOICE(5), MATTER(3), 'TEST-1005', 'overdue', -40, -10, [TIME(10), TIME(11), TIME(12), EXPENSE(6)]],
      [INVOICE(6), MATTER(6), 'TEST-1006', 'paid', -25, -20, [FLATFEE(3), TIME(14)]],
    ];

    let sortByInvoice = new Map<string, number>();
    const invoiceTotals = new Map<string, { totalCents: number; hours: number; flatCents: number }>();
    for (const [invId, mid, number, status, invOffset, dueOffset, lineIds] of invoiceDefs) {
      let totalCents = 0;
      let hours = 0;
      let flatCents = 0;
      for (const lineId of lineIds) {
        if (timeById.has(lineId)) {
          const [, , h, rate] = timeById.get(lineId)!;
          totalCents += Math.round(h * rate);
          hours += h;
        } else if (expenseById.has(lineId)) {
          const [, , amount] = expenseById.get(lineId)!;
          totalCents += amount;
        } else if (flatFeeById.has(lineId)) {
          const [, , amount] = flatFeeById.get(lineId)!;
          totalCents += amount;
          flatCents += amount;
        }
      }
      invoiceTotals.set(invId, { totalCents, hours, flatCents });
    }

    const invoicePayments: any[][] = [
      // [id, invoiceId, amountCents, offsetDays, source, note, trustTxnId]
      [PAYMENT(1), INVOICE(1), 130000, -18, 'check', 'Check #4471', null],
      [PAYMENT(2), INVOICE(1), 90900, -5, 'check', 'Trust disbursement - balance', TRUST_TXN(2)],
      [PAYMENT(3), INVOICE(2), 300000, -8, 'ach', 'Trust disbursement - partial payment', TRUST_TXN(4)],
      [PAYMENT(4), INVOICE(6), 440000, -15, 'credit_card', 'Trust disbursement - paid in full', TRUST_TXN(6)],
    ];
    const paidByInvoice = new Map<string, number>();
    for (const [, invId, amount] of invoicePayments) {
      paidByInvoice.set(invId, (paidByInvoice.get(invId) || 0) + amount);
    }

    for (const [invId, mid, number, status, invOffset, dueOffset, lineIds] of invoiceDefs) {
      const { totalCents, hours, flatCents } = invoiceTotals.get(invId)!;
      const paidCents = paidByInvoice.get(invId) || 0;
      const isPaid = status === 'paid';
      const clientId = matterClient.get(mid);
      await q(
        `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, status,
                               invoice_date, due_date, total_cents, flat_fees_amount_cents, total_hours,
                               amount_paid_cents, is_paid, paid_date, notes, created_by, created_at)
         values ($1,$2,$3,$4,'matter',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [invId, FIRM, mid, clientId, number, status, day(invOffset), day(dueOffset), totalCents, flatCents,
          hours || null, paidCents, isPaid, isPaid ? ts(-5) : null,
          'Seeded demo invoice - local test data.', OWNER, ts(invOffset)]
      );

      let sort = 0;
      for (const lineId of lineIds) {
        // `name` is a title only a time-entry line has anywhere it is drawn. The
        // read view, the PDF and the LEDES export all print a flat fee's and an
        // expense's description as the title, so those two lines leave it null
        // rather than storing a second string with nowhere to appear.
        let kind: string, name: string | null, desc: string, qty: number, rate: number | null,
          amount: number, lineDate: string, userId: string | null, chargeCodeId: string | null;
        if (timeById.has(lineId)) {
          const [, , h, r, chargeId, title, description, offset] = timeById.get(lineId)!;
          kind = 'time_entry'; name = title; desc = description; qty = h; rate = r; amount = Math.round(h * r);
          lineDate = day(offset); userId = OWNER; chargeCodeId = chargeId;
        } else if (expenseById.has(lineId)) {
          const [, , amt, catId, description, , offset] = expenseById.get(lineId)!;
          kind = 'expense'; name = null; desc = description; qty = 1; rate = amt; amount = amt;
          lineDate = day(offset); userId = OWNER; chargeCodeId = catId;
        } else {
          const [, , amt, description, offset] = flatFeeById.get(lineId)!;
          kind = 'flat_fee'; name = null; desc = description; qty = 1; rate = amt; amount = amt;
          lineDate = day(offset); userId = null; chargeCodeId = null;
        }
        await q(
          `insert into invoice_line_items (id, invoice_id, law_firm_id, kind, sort_order, source_id, name, description,
                                           line_date, quantity, rate_cents, amount_cents, user_id, user_name, charge_code_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [LINE(sortByInvoice.size * 10 + sort + 1), invId, FIRM, kind, sort, String(lineId), name, desc,
            lineDate, qty, rate, amount, userId, userId ? 'Test Owner' : null, chargeCodeId]
        );
        sort += 1;
      }
      sortByInvoice.set(invId, (sortByInvoice.get(invId) || 0) + 1);
    }

    for (const [pid, invId, amount, offset, source, note, trustTxnId] of invoicePayments) {
      await q(
        `insert into invoice_payments (id, invoice_id, law_firm_id, amount_cents, payment_date, payment_source,
                                       note, recorded_by, trust_transaction_id, trust_account_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [pid, invId, FIRM, amount, day(offset), source, note, OWNER, trustTxnId, trustTxnId ? TRUST_ACCT(1) : null]
      );
    }

    // ── trust accounting ────────────────────────────────────────────────────
    await q(
      `insert into trust_accounts (id, law_firm_id, name, bank_name, account_number_last4, routing_number_last4,
                                   account_type, iolta_tin, interest_beneficiary, status, book_balance_cents, created_by)
       values ($1,$2,'IOLTA - Operating Trust','Huntington National Bank','4471','0221','iolta','31-0000000','bar_foundation','active',$3,$4)`,
      [TRUST_ACCT(1), FIRM, 0, OWNER]
    );

    // Running balances are stored on each row, so build them in order. Two of
    // these (2 and 4 and 6) also fund an invoice payment above, via invoice_id
    // and invoice_payments.trust_transaction_id.
    const trustTxns: any[][] = [
      [TRUST_TXN(1), 'deposit', 500000, CLIENT(1), MATTER(1), -90, 'Initial retainer', 'check', 'Check #1180', null],
      [TRUST_TXN(2), 'withdrawal', 90900, CLIENT(1), MATTER(1), -5, 'Applied to invoice TEST-1001 balance', 'check', 'Check #2001', INVOICE(1)],
      [TRUST_TXN(3), 'deposit', 1000000, CLIENT(3), MATTER(10), -50, 'Compliance engagement retainer', 'wire', 'WIRE-88213', null],
      [TRUST_TXN(4), 'withdrawal', 300000, CLIENT(3), MATTER(10), -8, 'Applied to invoice TEST-1002 partial payment', 'ach', 'ACH-5510', INVOICE(2)],
      [TRUST_TXN(5), 'deposit', 440000, CLIENT(8), MATTER(6), -25, 'DUI defense flat-fee retainer', 'credit_card', 'CC-7742', null],
      [TRUST_TXN(6), 'withdrawal', 440000, CLIENT(8), MATTER(6), -15, 'Applied to invoice TEST-1006 in full', 'credit_card', 'CC-7743', INVOICE(6)],
      [TRUST_TXN(7), 'deposit', 250000, CLIENT(4), MATTER(3), -25, 'Dissolution cost advance', 'check', 'Check #3310', null],
      [TRUST_TXN(8), 'withdrawal', 30000, CLIENT(4), MATTER(3), -20, 'Filing fee disbursement', 'check', 'Check #2002', null],
      [TRUST_TXN(9), 'deposit', 150000, CLIENT(2), MATTER(9), -12, 'Trademark filing cost advance', 'wire', 'WIRE-90042', null],
      [TRUST_TXN(10), 'withdrawal', 40000, CLIENT(2), MATTER(9), -11, 'TTAB filing fee paid from trust', 'wire', 'WIRE-90043', null],
      [TRUST_TXN(11), 'deposit', 50000, CLIENT(6), MATTER(2), -20, 'Litigation cost advance', 'check', 'Check #5501', null],
    ];
    let acctBalance = 0;
    const clientBalances = new Map();
    for (const [txid, type, amount, clientId, matterId, offset, desc, source, ref, invId] of trustTxns) {
      const delta = type === 'deposit' ? amount : -amount;
      acctBalance += delta;
      const prior = clientBalances.get(clientId) || 0;
      const clientBalance = prior + delta;
      clientBalances.set(clientId, clientBalance);
      await q(
        `insert into trust_transactions (id, law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id,
                                         txn_date, description, reference_number, source, status, invoice_id,
                                         client_balance_after_cents, account_balance_after_cents, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12,$13,$14,$15,$16)`,
        [txid, FIRM, TRUST_ACCT(1), type, amount, clientId, matterId, day(offset), desc, ref, source, invId,
          clientBalance, acctBalance, OWNER, ts(offset)]
      );
    }
    await q('update trust_accounts set book_balance_cents = $1 where id = $2', [acctBalance, TRUST_ACCT(1)]);

    // ── messaging ───────────────────────────────────────────────────────────
    const conversations: any[][] = [
      [CONV(1), MATTER(1), 'Whitfield - case updates', -30],
      [CONV(2), MATTER(9), 'Raman Trademark - opposition update', -18],
    ];
    for (const [convId, mid, title, offset] of conversations) {
      // `client_id` is a Firebase uid and is what makes a conversation the ONE
      // direct thread for that client, enforced by a unique (law_firm_id,
      // client_id). These are group threads, so it stays null and the portal
      // reaches them through conversation_participants instead.
      await q(
        `insert into conversations (id, law_firm_id, client_id, client_record_id, conversation_type, title,
                                    matter_id, created_by, last_message_at, last_sender_user_id, created_at)
         values ($1,$2,null,$3,'group',$4,$5,$6,$7,$6,$8)`,
        [convId, FIRM, PORTAL_USER && convId === CONV(1) ? CLIENT(1) : null, title, mid, OWNER, ts(-1, 15), ts(offset)]
      );
      await q(
        `insert into conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, added_at)
         values ($1,$2,$3,'firm_member',$3,$4)`,
        [convId, FIRM, OWNER, ts(offset)]
      );
      // The portal reaches a group thread through its own participant row, not
      // through the matter, so the Whitfield thread needs one for the portal
      // client or the portal inbox stays empty.
      if (PORTAL_USER && convId === CONV(1)) {
        await q(
          `insert into conversation_participants (conversation_id, law_firm_id, participant_user_id, client_id,
                                                  participant_type, added_by, added_at)
           values ($1,$2,$3,$4,'client',$5,$6)`,
          [convId, FIRM, PORTAL_USER, CLIENT(1), OWNER, ts(offset)]
        );
      }
      await q(
        `insert into conversation_matters (conversation_id, law_firm_id, matter_id, position, created_at)
         values ($1,$2,$3,0,$4)`,
        [convId, FIRM, mid, ts(offset)]
      );
    }
    // The last column marks a message the CLIENT sent, so the Whitfield thread
    // reads as a two-sided conversation from both the firm side and the portal
    // side. Without a portal user those messages still land, sent by the owner.
    const messages: any[][] = [
      [MSG(1), CONV(1), MATTER(1), 'The policy-limits demand went out this morning. Meridian has 30 days to respond.', -20, 15, false],
      [MSG(2), CONV(1), MATTER(1), 'Adjuster acknowledged receipt and asked for the updated wage-loss documentation.', -12, 10, false],
      [MSG(3), CONV(1), MATTER(1), 'I asked my employer for the wage letter. They said it takes a few days.', -11, 18, true],
      [MSG(4), CONV(1), MATTER(1), 'Uploaded the employer letter to the matter files.', -6, 9, false],
      [MSG(5), CONV(1), MATTER(1), 'Thanks - I will watch for the adjuster response.', -1, 15, true],
      [MSG(6), CONV(2), MATTER(9), 'The opposition response draft is attached for your review.', -10, 11, false],
      [MSG(7), CONV(2), MATTER(9), 'Looks good. Let us file by the deadline on the 20th.', -9, 13, false],
      [MSG(8), CONV(2), MATTER(9), 'Filed and confirmed with the TTAB e-filing system.', -3, 16, false],
    ];
    for (const [mid, convId, matterId, content, offset, hour, fromClient] of messages) {
      const asClient = fromClient && PORTAL_USER;
      await q(
        `insert into messages (id, law_firm_id, conversation_id, sender_user_id, content, sender_type, sender_name,
                               read_by_firm, matter_id, status, kind, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent','user',$10)`,
        [mid, FIRM, convId, asClient ? PORTAL_USER : OWNER, content,
          asClient ? 'client' : 'firm_member', asClient ? 'Marcus Whitfield' : 'Test Owner',
          !asClient, matterId, ts(offset, hour)]
      );
    }

    // ── calendar (the firm's own events, spread widely across past/future) ──
    const events: any[][] = [
      [EVENT(1), MATTER(1), null, 'deposition', 'Deposition - Ridgeline corporate rep', 3, 14, 3, 17, 'Hain & Stroud LLP, Columbus'],
      [EVENT(2), MATTER(3), null, 'hearing', 'Pretrial conference - Bello', 8, 13, 8, 14, 'Hamilton County Domestic Relations, Courtroom 4B'],
      [EVENT(3), MATTER(5), null, 'hearing', 'Suppression hearing - State v. Okafor', 16, 9, 16, 11, 'Cleveland Municipal Court'],
      [EVENT(4), null, CLIENT(6), 'meeting', 'Client intake - new PI referral', 1, 10, 1, 11, 'Office'],
      [EVENT(5), MATTER(10), null, 'filing_deadline', 'DOT audit response due', -4, 9, -4, 10, null],
      [EVENT(6), MATTER(6), null, 'hearing', 'Pretrial conference - State v. Vasquez', 6, 9, 6, 10, 'Cuyahoga County Municipal Court'],
      [EVENT(7), MATTER(9), null, 'filing_deadline', 'TTAB opposition response due', -20, 17, -20, 18, null],
      [EVENT(8), MATTER(2), null, 'meeting', 'Client update call - Nguyen', 5, 14, 5, 15, null],
      [EVENT(9), MATTER(4), null, 'meeting', 'Custody consultation follow-up', 2, 11, 2, 12, 'Office'],
      [EVENT(10), MATTER(11), null, 'meeting', 'Vendor contract negotiation call', -2, 13, -2, 14, null],
      [EVENT(11), MATTER(1), null, 'mediation', 'Mediation session - Whitfield v. Ridgeline', 22, 9, 22, 16, 'Franklin County Mediation Center'],
      [EVENT(12), MATTER(6), null, 'trial', 'Trial - State v. Vasquez', 45, 9, 45, 17, 'Cuyahoga County Municipal Court'],
      [EVENT(13), null, CLIENT(4), 'meeting', 'Client check-in - Bello', -7, 10, -7, 11, 'Office'],
      [EVENT(14), MATTER(3), null, 'discovery_cutoff', 'Discovery cutoff - Bello Dissolution', 30, 17, 30, 18, null],
      [EVENT(15), MATTER(5), null, 'court_date', 'Pretrial status conference - Okafor', -18, 9, -18, 10, 'Cleveland Municipal Court'],
      [EVENT(16), MATTER(9), null, 'meeting', 'Trademark counsel strategy call', -25, 14, -25, 15, null],
      [EVENT(17), MATTER(10), null, 'meeting', 'DOT auditor closeout meeting', 12, 10, 12, 11, 'Dayton regional office'],
      [EVENT(18), null, CLIENT(7), 'meeting', 'Initial custody consultation', -9, 15, -9, 16, 'Office'],
      [EVENT(19), MATTER(1), null, 'statute_of_limitations', 'Statute of limitations deadline - Whitfield', 660, 9, 660, 10, null],
      [EVENT(20), MATTER(2), null, 'filing_deadline', 'Complaint filing deadline - Nguyen', 40, 9, 40, 10, null],
    ];
    for (const [eid, mid, cid, type, title, startOffset, startHour, endOffset, endHour, location] of events) {
      // The portal calendar reads only events flagged client_visible, and the
      // flag defaults to false. Everything on the portal client's own matters
      // is opened up so that surface is not empty.
      const clientVisible = Boolean(
        PORTAL_USER && ((mid && matterClient.get(mid) === CLIENT(1)) || cid === CLIENT(1))
      );
      await q(
        `insert into events (id, law_firm_id, matter_id, client_id, type, title, date, ends_at, all_day,
                             location_name, status, client_visible, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,'upcoming',$10,$11,now())`,
        [eid, FIRM, mid, cid, type, title, ts(startOffset, startHour), ts(endOffset, endHour), location,
          clientVisible, OWNER]
      );
    }

    // ── document requests ───────────────────────────────────────────────────
    await q(
      `insert into document_requests (id, law_firm_id, matter_id, client_id, title, note, status, due_date, created_by)
       values ($1,$2,$3,$4,'Wage loss documentation','Needed to support the lost-earnings claim.','open',$5,$6)`,
      [DOCREQ(1), FIRM, MATTER(1), CLIENT(1), day(7), OWNER]
    );
    await q(
      `insert into document_requests (id, law_firm_id, matter_id, client_id, title, note, status, due_date, created_by)
       values ($1,$2,$3,$4,'Financial disclosures','Required before the pretrial conference.','completed',$5,$6)`,
      [DOCREQ(2), FIRM, MATTER(3), CLIENT(4), day(-10), OWNER]
    );
    await q(
      `insert into document_requests (id, law_firm_id, matter_id, client_id, title, note, status, due_date, created_by)
       values ($1,$2,$3,$4,'Incident photos','Photos of the produce aisle taken right after the fall, if any.','open',$5,$6)`,
      [DOCREQ(3), FIRM, MATTER(2), CLIENT(6), day(5), OWNER]
    );
    const docItems = [
      [DOCITEM(1), DOCREQ(1), 'Employer wage verification letter', 0],
      [DOCITEM(2), DOCREQ(1), 'Last 3 pay stubs before the collision', 1],
      [DOCITEM(3), DOCREQ(1), '2025 W-2', 2],
      [DOCITEM(4), DOCREQ(2), 'Affidavit of income and expenses', 0],
      [DOCITEM(5), DOCREQ(2), 'Last 2 years of tax returns', 1],
      [DOCITEM(6), DOCREQ(3), 'Photos taken at the scene', 0],
      [DOCITEM(7), DOCREQ(3), 'Names of any witnesses', 1],
    ];
    for (const [iid, reqId, label, sort] of docItems) {
      await q(
        `insert into document_request_items (id, law_firm_id, request_id, label, sort_order)
         values ($1,$2,$3,$4,$5)`,
        [iid, FIRM, reqId, label, sort]
      );
    }

    // ── notifications ───────────────────────────────────────────────────────
    // Every row carries the link a real producer would build, so a click in the
    // bell opens the page it is about.
    const APP_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    const FIRM_URL = `${APP_URL}/lawfirm/${FIRM}`;
    const PORTAL_URL = `${APP_URL}/client/lawfirm/${FIRM}`;
    const notifications: any[][] = [
      [NOTIF(1), 'task_due', 'Task due today', 'Prepare parenting-time proposal is due today.', 'task', TASK(8), MATTER(3), false, `${FIRM_URL}/tasks/${TASK(8)}`],
      [NOTIF(2), 'task_overdue', 'Overdue task', 'File the complaint before the SOL runs is 3 days overdue.', 'task', TASK(1), MATTER(1), false, `${FIRM_URL}/tasks/${TASK(1)}`],
      [NOTIF(3), 'invoice_paid', 'Invoice paid', 'Invoice TEST-1001 was paid in full.', 'invoice', INVOICE(1), MATTER(1), true, `${FIRM_URL}/billing`],
      [NOTIF(4), 'message_received', 'New message', 'New message in Whitfield - case updates.', 'message', MSG(4), MATTER(1), false, `${FIRM_URL}/messages/${CONV(1)}?type=group`],
      [NOTIF(5), 'invoice_overdue', 'Invoice overdue', 'Invoice TEST-1005 is past its due date.', 'invoice', INVOICE(5), MATTER(3), false, `${FIRM_URL}/billing`],
      [NOTIF(6), 'task_overdue', 'Overdue task', 'Subpoena CAD log and dashcam is 1 day overdue.', 'task', TASK(11), MATTER(5), false, `${FIRM_URL}/tasks/${TASK(11)}`],
    ];
    for (const [nid, type, title, body, entityType, entityId, matterId, read, actionUrl] of notifications) {
      await q(
        `insert into notifications (id, law_firm_id, user_id, type, title, body, read, entity_type, entity_id, matter_id, action_url, created_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [nid, FIRM, OWNER, type, title, body, read, entityType, entityId, matterId, actionUrl, OWNER, ts(-1)]
      );
    }

    // Notification feeds are keyed by user id, not by client record, so the
    // portal user needs its own rows rather than a share of the owner's.
    if (PORTAL_USER) {
      const portalNotifications: any[][] = [
        [NOTIF(7), 'message_received', 'New message', 'Your attorney replied in Whitfield - case updates.', 'message', MSG(4), MATTER(1), false, `${PORTAL_URL}/messages`],
        [NOTIF(8), 'invoice_paid', 'Invoice paid', 'Invoice TEST-1001 is paid in full. Thank you.', 'invoice', INVOICE(1), MATTER(1), true, `${PORTAL_URL}/billing`],
        // entity_type is constrained to task/matter/invoice/message/note/file,
        // so a document request points at its matter instead.
        [NOTIF(9), 'document_request', 'Documents requested', 'Wage loss documentation is due in one week.', 'matter', MATTER(1), MATTER(1), false, `${PORTAL_URL}/documents`],
      ];
      for (const [nid, type, title, body, entityType, entityId, matterId, read, actionUrl] of portalNotifications) {
        await q(
          `insert into notifications (id, law_firm_id, user_id, type, title, body, read, entity_type, entity_id, matter_id, action_url, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [nid, FIRM, PORTAL_USER, type, title, body, read, entityType, entityId, matterId, actionUrl, OWNER, ts(-1)]
        );
      }
    }

    await q('commit');

    // ── summary ─────────────────────────────────────────────────────────────
    // Scoped by law_firm_id too, not just the id prefix: several firms can share
    // this same NS-prefixed namespace (see the cleanup comment above), so without
    // it this report would count every seeded firm's rows, not just this one's.
    const { rows: summary } = await q(
      `select 'practice_areas' t, count(*) n from practice_areas where id::text like $1 and law_firm_id = $2
       union all select 'matter_stage_pipelines', count(*) from matter_stage_pipelines where id::text like $1 and law_firm_id = $2
       union all select 'matter_stages', count(*) from matter_stages where id::text like $1 and law_firm_id = $2
       union all select 'clients', count(*) from clients where id::text like $1 and law_firm_id = $2
       union all select 'matters', count(*) from matters where id::text like $1 and law_firm_id = $2
       union all select 'tasks', count(*) from tasks where id::text like $1 and law_firm_id = $2
       union all select 'task_subtasks', count(*) from task_subtasks where id::text like $1 and law_firm_id = $2
       union all select 'activities', count(*) from activities where id::text like $1 and law_firm_id = $2
       union all select 'billing_codes', count(*) from billing_codes where id::text like $1 and law_firm_id = $2
       union all select 'invoices', count(*) from invoices where id::text like $1 and law_firm_id = $2
       union all select 'invoice_line_items', count(*) from invoice_line_items where id::text like $1 and law_firm_id = $2
       union all select 'invoice_payments', count(*) from invoice_payments where id::text like $1 and law_firm_id = $2
       union all select 'trust_accounts', count(*) from trust_accounts where id::text like $1 and law_firm_id = $2
       union all select 'trust_transactions', count(*) from trust_transactions where id::text like $1 and law_firm_id = $2
       union all select 'conversations', count(*) from conversations where id::text like $1 and law_firm_id = $2
       union all select 'messages', count(*) from messages where id::text like $1 and law_firm_id = $2
       union all select 'events', count(*) from events where id::text like $1 and law_firm_id = $2
       union all select 'document_requests', count(*) from document_requests where id::text like $1 and law_firm_id = $2
       union all select 'document_request_items', count(*) from document_request_items where id::text like $1 and law_firm_id = $2
       union all select 'matter_contacts', count(*) from matter_contacts where id::text like $1 and law_firm_id = $2
       union all select 'contacts', count(*) from contacts where id::text like $1 and law_firm_id = $2
       union all select 'notes', count(*) from notes where id::text like $1 and law_firm_id = $2
       union all select 'activity_log', count(*) from activity_log where id::text like $1 and law_firm_id = $2
       union all select 'contact_clients', count(*) from contact_clients where id::text like $1 and law_firm_id = $2
       union all select 'notifications', count(*) from notifications where id::text like $1 and law_firm_id = $2
       order by 1`,
      [`${NS}-%`, FIRM]
    );
    console.log('Seeded rows:');
    for (const r of summary) console.log(`  ${r.t.padEnd(24)} ${r.n}`);

    const { rows: invoiceSummary } = await q(
      `select invoice_number, status, total_cents, amount_paid_cents
         from invoices where id::text like $1 and law_firm_id = $2 order by invoice_number`,
      [`${NS}-%`, FIRM]
    );
    console.log('\nInvoices:');
    for (const r of invoiceSummary) {
      console.log(`  ${r.invoice_number}  ${r.status.padEnd(16)} total $${(r.total_cents / 100).toFixed(2).padStart(10)}  paid $${(r.amount_paid_cents / 100).toFixed(2)}`);
    }

    if (PORTAL_USER) {
      const { rows: portal } = await q(
        `select 'portal matters' t, count(*) n from matter_clients where law_firm_id = $1 and client_id = $2
         union all select 'portal invoices', count(*) from invoices where law_firm_id = $1 and client_id = $2
         union all select 'portal trust txns', count(*) from trust_transactions where law_firm_id = $1 and client_id = $2
         union all select 'portal doc requests', count(*) from document_requests where law_firm_id = $1 and client_id = $2
         union all select 'portal conversations', count(*) from conversation_participants where law_firm_id = $1 and participant_user_id = $3
         union all select 'portal visible events', count(*) from events where law_firm_id = $1 and client_visible
         union all select 'portal notifications', count(*) from notifications where law_firm_id = $1 and user_id = $3
         order by 1`,
        [FIRM, CLIENT(1), PORTAL_USER]
      );
      console.log(`\nClient portal (${PORTAL_EMAIL || PORTAL_USER}) can see:`);
      for (const r of portal) console.log(`  ${r.t.padEnd(24)} ${r.n}`);
    }

    console.log(`\nTrust book balance: $${(acctBalance / 100).toFixed(2)}`);
    console.log('Firm plan set to enterprise + unlimitedOverride.');
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
