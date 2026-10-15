/**
 * Cross-cutting sweep: how every money-and-documents route in this slice answers
 * an entity id it must refuse.
 *
 * Slice swept: src/modules/billing/** , src/modules/trust/, src/modules/files/,
 * src/modules/templates/, src/modules/signatures/, src/modules/documentRequests/.
 *
 * Two invariants, run against one table of routes so adding a route later is one
 * line in ROUTES:
 *
 *   (1) A MALFORMED id is refused, never answered with a 500. These id columns
 *       are `uuid`, so a value that is not a uuid reaches Postgres as a 22P02
 *       cast error unless the code guards it. The right answer is 404 (or 400
 *       where a schema rejects the param first). A 500 tells the caller the
 *       server is broken when the request was.
 *
 *   (2) ANOTHER FIRM'S id is never served. The entity is seeded in firm B and
 *       then addressed through firm A's URL as firm A's owner. The answer must
 *       be 404 or 403, and for a mutating route firm B's row must be UNCHANGED
 *       afterwards. The status alone is not enough: a route that writes and then
 *       answers 404 has already leaked. On this slice a leak is money and client
 *       documents, so the row snapshot is the real assertion and the status is
 *       the secondary one.
 *
 * Plan gates: trust, templates, signing templates, flat fees, analytics and file
 * share links sit behind `requireFeature`. The firm factory uses the enterprise
 * plan, so every one of them is reachable here and a 403 from these cases is an
 * id refusal, not a plan refusal. `assertGatesOpen` below proves that per gated
 * router by calling its list route with a well-formed request first: if the plan
 * gate were firing, that list call would 403 too and the sweep would be
 * meaningless.
 *
 * The same trap exists for gates that are not plan gates, and three of them were
 * caught firing ahead of the id lookup while this spec was being written. Each is
 * disarmed in the fixtures rather than asserted around, because a case that stops
 * at a gate proves nothing about the id it claims to test:
 *
 *   - `law_firms.settings.billing.lateFee.enabled` defaults to false, and
 *     applyLateFee throws "Late fees are not enabled for this firm" first. The
 *     seed turns it on.
 *   - `DISABLE_ALL_REMINDER_EMAILS` is set in backend/.env, and
 *     sendReminderForInvoice returns `{ sent: false }` on it first. The spec
 *     clears it for the file and restores it afterwards.
 *   - link-file refuses a request with no matter before it looks at the item, so
 *     the seeded document request is tied to a matter.
 *
 * Two answer shapes, not one. Most of these routes address ONE record, so an
 * unreachable one is a 404. Six of them take the id as a FILTER on a
 * firm-scoped aggregate (the by-client billing breakdown, the trust client and
 * matter ledgers and balances, the per-client document request list); those
 * refuse by reporting nothing, and demanding a 403 from them would be asserting
 * a status where the behaviour is content. They are marked `contract: 'empty'`
 * and assert on the payload instead. To keep that non-vacuous the fixtures give
 * firm B's client and matter real trust money, a real matter link and a real
 * document request, so "nothing came back" cannot be true by accident.
 *
 * SKIPPED, with reasons (no case is written for these):
 *
 *   - src/modules/files/ browse, download, mutate, upload and storage routers.
 *     They address files by `objectPath`/`fileId` QUERY parameters, not by a
 *     path id, so neither invariant has a path id to exercise. The upload routes
 *     additionally need multipart bodies and a live GCS bucket, which the
 *     harness deliberately stubs to throw.
 *   - Template direct-upload init/finalize routes. They require a working GCS
 *     upload session; the top-level create routes carry no entity id at all.
 *   - POST /api/signatures/* and the public /api/signing/:token/* routes. Their
 *     ids are `text` columns (signature_sessions.token,
 *     signature_participants.id), so there is no uuid cast to provoke, and the
 *     signing routes are unauthenticated portal endpoints scoped by the token
 *     itself rather than by a firm in the URL. The one firm-scoped member route
 *     over those text ids, POST /signature-links/:sessionToken/resend-participant
 *     /:participantId, IS covered for invariant (2).
 *   - DELETE /file-share-links/:token for invariant (1): file_share_links.token
 *     is `text`, so a malformed value is a miss, not a cast error. Covered for
 *     invariant (2).
 *   - POST /billing/invoices/matter/:matterId/split and POST /billing/invoices
 *     /bulk: no entity id in the path (the ids are in the body).
 *   - The `:periodId` of POST billing/plans/:planId/periods/:periodId
 *     /create-draft. It is the period's START DATE, not a row id, and is only
 *     meaningful inside its plan: two firms' plans can each have a period
 *     starting the same day. The plan id is the tenant boundary, and it is swept.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
} from '../support/setupInProcess';
import { sessionIdSql, sessionKeysSql } from '../support/factories';
import {
  MALFORMED_ID, absentId, refusalVerdict,
} from '../support/idSweep';



interface World {
  firmId: string;
  clientId: string;
  matterId: string;
  api: Actor['api'];
  ownerUid: string;
  ids: Record<string, string>;
}

async function seedWorld(label: string): Promise<World> {
  const firm = await createFirm({ name: `Firm ${label}` });
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: `Client ${label}` });

  const ids: Record<string, string> = {
    chargeCode: randomUUID(),
    expenseCategory: randomUUID(),
    expense: randomUUID(),
    flatFee: randomUUID(),
    timeEntry: randomUUID(),
    invoice: randomUUID(),
    plan: randomUUID(),
    planPeriod: randomUUID(),
    trustAccount: randomUUID(),
    trustTransaction: randomUUID(),
    minimumBalance: randomUUID(),
    remittance: randomUUID(),
    reconciliation: randomUUID(),
    templateFolder: randomUUID(),
    template: randomUUID(),
    signingTemplate: randomUUID(),
    documentRequest: randomUUID(),
    documentRequestItem: randomUUID(),
    documentRequestFulfillment: randomUUID(),
    documentRequestTemplate: randomUUID(),
    matter: randomUUID(),
    // Assigned by the seed: a file row picks its own id.
    file: '',
    shareLinkToken: `share-${label}-${randomUUID().slice(0, 8)}`,
    sessionToken: `sess-${label}-${randomUUID().slice(0, 8)}`,
    participant: `part-${label}-${randomUUID().slice(0, 8)}`,
  };

  const q = (text: string, params: unknown[]) => testPool.query(text, params);

  // Late fees are off by default, and applyLateFee throws "Late fees are not
  // enabled for this firm" BEFORE it resolves the invoice. Without this the
  // late-fee cases would pass on the settings gate and say nothing about the id.
  await q(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('billing', jsonb_build_object(
               'lateFee', jsonb_build_object(
                 'enabled', true, 'flatAmount', 25, 'percent', 0,
                 'graceDays', 0, 'autoApply', false)))
      where id = $1`,
    [firm.id],
  );

  await q(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [ids.matter, firm.id, `Matter ${label}`, `M-${label}-1`],
  );
  await q(
    `insert into matter_members (matter_id, user_id, law_firm_id, role)
     values ($1, $2, $3, 'lead')`,
    [ids.matter, owner.uid, firm.id],
  );
  // The client is on the matter so the by-client billing breakdown has a row to
  // leak. A world where the client owns no matters would answer that report with
  // an empty list whether it was correctly scoped or not.
  await q(
    `insert into matter_clients (matter_id, client_id, law_firm_id, billing_portion_bp)
     values ($1, $2, $3, 10000)`,
    [ids.matter, client.id, firm.id],
  );

  await q(
    `insert into billing_codes (id, law_firm_id, kind, code, name, default_rate)
     values ($1, $2, 'charge', $3, 'Sweep code', 300)`,
    [ids.chargeCode, firm.id, `CC${label}1`],
  );
  await q(
    `insert into billing_codes (id, law_firm_id, kind, code, name)
     values ($1, $2, 'expense', $3, 'Sweep category')`,
    [ids.expenseCategory, firm.id, `EC_${label}_1`],
  );
  await q(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date)
     values ('expense', $1, $2, $3, 'Sweep expense', 12345, current_date)`,
    [ids.expense, firm.id, client.id],
  );
  await q(
    `insert into activities (kind, id, law_firm_id, client_id, description, charge_cents, activity_date)
     values ('flat_fee', $1, $2, $3, 'Sweep flat fee', 50000, current_date)`,
    [ids.flatFee, firm.id, client.id],
  );
  await q(
    `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours, rate_cents, description)
     values ('time', $1, $2, $3, $4, current_date, 1.5, 40000, 'Sweep time')`,
    [ids.timeEntry, firm.id, client.id, owner.uid],
  );
  await q(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, invoice_date, due_date)
     values ($1, $2, $3, $3, 'client', $4, 'outstanding', 250000, current_date, current_date + 30)`,
    [ids.invoice, firm.id, client.id, `INV-${label}-1`],
  );
  await q(
    `insert into billing_plans (id, law_firm_id, client_id, plan_type, name, status,
                                interval_unit, interval_count, start_date, amount_cents)
     values ($1, $2, $3, 'retainer', 'Sweep plan', 'active', 'month', 1, current_date, 100000)`,
    [ids.plan, firm.id, client.id],
  );
  await q(
    `insert into billing_plan_periods (id, billing_plan_id, law_firm_id, period_start_date,
                                       period_end_date, due_date, status, amount_cents)
     values ($1, $2, $3, current_date, current_date + 30, current_date + 30, 'ready_to_bill', 100000)`,
    [ids.planPeriod, ids.plan, firm.id],
  );
  // The API addresses a plan period by its START DATE, not its row id (see
  // `periodEntity` in plans.service), so the route needs that key.
  ids.planPeriodKey = (await q(
    'select period_start_date::text as d from billing_plan_periods where id = $1', [ids.planPeriod],
  )).rows[0].d;

  await q(
    `insert into trust_accounts (id, law_firm_id, name, bank_name, account_number_last4,
                                 account_type, status, book_balance_cents)
     values ($1, $2, 'Sweep IOLTA', 'Sweep Bank', '4321', 'iolta', 'active', 400000)`,
    [ids.trustAccount, firm.id],
  );
  // Carries BOTH client_id and matter_id: the client ledger and the matter
  // ledger each need real money in this firm, or their cross-firm cases would
  // read zero whether the figure was correctly withheld or never existed.
  await q(
    `insert into trust_transactions
       (id, law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id, txn_date,
        description, status, client_balance_after_cents, account_balance_after_cents)
     values ($1, $2, $3, 'deposit', 400000, $4, $5, current_date, 'Sweep retainer',
             'completed', 400000, 400000)`,
    [ids.trustTransaction, firm.id, ids.trustAccount, client.id, ids.matter],
  );
  await q(
    `insert into trust_minimum_balances (id, law_firm_id, client_id, trust_account_id, minimum_cents)
     values ($1, $2, $3, $4, 50000)`,
    [ids.minimumBalance, firm.id, client.id, ids.trustAccount],
  );
  await q(
    `insert into trust_interest_remittances
       (id, law_firm_id, trust_account_id, period_start, period_end,
        interest_earned_cents, amount_remitted_cents, status)
     values ($1, $2, $3, current_date - 30, current_date, 1200, 0, 'pending')`,
    [ids.remittance, firm.id, ids.trustAccount],
  );
  await q(
    `insert into trust_reconciliations
       (id, law_firm_id, trust_account_id, reconciliation_date, bank_statement_balance_cents,
        book_balance_cents, client_ledger_total_cents, is_reconciled, discrepancy_cents)
     values ($1, $2, $3, current_date, 400000, 400000, 400000, true, 0)`,
    [ids.reconciliation, firm.id, ids.trustAccount],
  );

  await q(
    `insert into template_folders (id, law_firm_id, name, sort_order)
     values ($1, $2, 'Sweep folder', 1)`,
    [ids.templateFolder, firm.id],
  );
  await q(
    `insert into templates (id, law_firm_id, name, type, fields, folder_id)
     values ($1, $2, 'Sweep template', 'html', '{}', $3)`,
    [ids.template, firm.id, ids.templateFolder],
  );
  await q(
    `insert into signature_templates (id, law_firm_id, name, description, fields, signer_roles, routing_mode)
     values ($1, $2, 'Sweep signing template', '', $3::jsonb, $4::jsonb, 'sequential')`,
    [
      ids.signingTemplate,
      firm.id,
      JSON.stringify([{
        id: 'f1', page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
        fieldType: 'signature', signerId: 'role:1',
      }]),
      JSON.stringify([{ roleLabel: 'Signer', order: 1 }]),
    ],
  );

  // Tied to a matter on purpose: POST .../items/:itemId/link-file refuses a
  // matterless request BEFORE it looks at the item, so a general request would
  // make that case a 400 about the request shape rather than about the item id.
  await q(
    `insert into document_requests (id, law_firm_id, matter_id, client_id, title, status)
     values ($1, $2, $3, $4, 'Sweep request', 'open')`,
    [ids.documentRequest, firm.id, ids.matter, client.id],
  );
  await q(
    `insert into document_request_items (id, law_firm_id, request_id, label, status, sort_order)
     values ($1, $2, $3, 'Sweep item', 'pending', 0)`,
    [ids.documentRequestItem, firm.id, ids.documentRequest],
  );
  // A real document in the firm's general area. A row with no parent IS a scope
  // root, so one hand-built here would be a second root for the firm.
  const filesRepo = require('../../src/modules/files/files.repository');
  const generalRoot = await filesRepo.ensureScopeRoot(firm.id, { scope: 'firm' });
  const sweepFile = await filesRepo.createFile(firm.id, {
    parentId: generalRoot, name: 'sweep.pdf', mimeType: 'application/pdf',
  });
  const sweepFileId = sweepFile.id;
  ids.file = sweepFileId;
  await q(
    `insert into attachments (id, law_firm_id, document_request_item_id, file_id)
     values ($1, $2, $3, $4)`,
    [
      ids.documentRequestFulfillment,
      firm.id,
      ids.documentRequestItem,
      sweepFileId,
    ],
  );
  await q(
    `insert into document_request_templates (id, law_firm_id, name, default_title, items)
     values ($1, $2, 'Sweep preset', 'Sweep preset title', '[]'::jsonb)`,
    [ids.documentRequestTemplate, firm.id],
  );

  await q(
    `insert into file_share_links (token, law_firm_id, file_id, display_name, permission, expires_at)
     values ($1, $2, $3, 'sweep.pdf', 'download', now() + interval '7 days')`,
    [ids.shareLinkToken, firm.id, sweepFileId],
  );

  await q(
    `insert into signature_sessions (token, law_firm_id, source_id, created_by, status, file_name, object_path)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'in_progress', 'sweep.pdf', $4)`,
    [ids.sessionToken, firm.id, owner.uid, `lawfirmids/${firm.id}/general/sweep.pdf`],
  );
  await q(
    `insert into signature_participants
       (id, session_id, law_firm_id, role_label, signing_order, delivery_method, name, email,
        status)
     values ($1, ${sessionKeysSql('$2')}, 'Signer', 1, 'email', 'Sweep Signer', $3, 'active')`,
    [ids.participant, ids.sessionToken, `sweep-${label}@example.test`],
  );

  return {
    firmId: firm.id,
    clientId: client.id,
    matterId: ids.matter,
    api: owner.api,
    ownerUid: owner.uid,
    ids,
  };
}

// ── snapshots ────────────────────────────────────────────────────────
//
// What "the firm B row is unchanged" means per entity. For money entities the
// snapshot deliberately spans the child tables too: a credit note, a payment or
// a line-item rewrite lands in a child table and can leave the parent row
// untouched, so a snapshot of the parent alone would go green on a real write.

async function rows(sql: string, params: unknown[]) {
  const result = await testPool.query(sql, params);
  return result.rows;
}

type Snapshot = (id: string) => Promise<unknown>;

const SNAPSHOT: Record<string, Snapshot> = {
  chargeCode: (id) => rows(`select * from billing_codes where id = $1`, [id]),
  expenseCategory: (id) => rows(`select * from billing_codes where id = $1`, [id]),
  expense: (id) => rows(`select * from activities where kind = 'expense' and id = $1`, [id]),
  flatFee: (id) => rows(`select * from activities where kind = 'flat_fee' and id = $1`, [id]),
  timeEntry: (id) => rows(`select * from activities where kind = 'time' and id = $1`, [id]),
  invoice: async (id) => ({
    invoice: await rows(`select * from invoices where id = $1`, [id]),
    lineItems: await rows(`select * from invoice_line_items where invoice_id = $1 order by id`, [id]),
    payments: await rows(`select * from invoice_payments where invoice_id = $1 order by id`, [id]),
    expected: await rows(`select * from invoice_expected_payments where invoice_id = $1 order by id`, [id]),
    creditNotes: await rows(`select * from invoice_adjustments where invoice_id = $1 and direction = 'credit' order by id`, [id]),
    adjustments: await rows(`select * from invoice_adjustments where invoice_id = $1 and direction = 'charge' order by id`, [id]),
  }),
  plan: async (id) => ({
    plan: await rows(`select * from billing_plans where id = $1`, [id]),
    periods: await rows(`select * from billing_plan_periods where billing_plan_id = $1 order by id`, [id]),
  }),
  planPeriod: (id) => rows(`select * from billing_plan_periods where id = $1`, [id]),
  trustAccount: async (id) => ({
    account: await rows(`select * from trust_accounts where id = $1`, [id]),
    transactions: await rows(`select * from trust_transactions where trust_account_id = $1 order by id`, [id]),
  }),
  trustTransaction: (id) => rows(`select * from trust_transactions where id = $1`, [id]),
  minimumBalance: (id) => rows(`select * from trust_minimum_balances where id = $1`, [id]),
  remittance: (id) => rows(`select * from trust_interest_remittances where id = $1`, [id]),
  reconciliation: async (id) => ({
    reconciliation: await rows(`select * from trust_reconciliations where id = $1`, [id]),
    cleared: await rows(
      `select id, cleared_at, cleared_in_reconciliation_id from trust_transactions
        where cleared_in_reconciliation_id = $1 order by id`,
      [id],
    ),
  }),
  templateFolder: async (id) => ({
    folder: await rows(`select * from template_folders where id = $1`, [id]),
    templates: await rows(`select id, folder_id from templates where folder_id = $1 order by id`, [id]),
  }),
  template: async (id) => ({
    template: await rows(`select * from templates where id = $1`, [id]),
    placements: await rows(`select * from template_field_placements where template_id = $1 order by id`, [id]),
  }),
  signingTemplate: (id) => rows(`select * from signature_templates where id = $1`, [id]),
  documentRequest: async (id) => ({
    request: await rows(`select * from document_requests where id = $1`, [id]),
    items: await rows(`select * from document_request_items where request_id = $1 order by id`, [id]),
  }),
  documentRequestItem: async (id) => ({
    item: await rows(`select * from document_request_items where id = $1`, [id]),
    fulfillments: await rows(`select * from attachments where document_request_item_id = $1 order by id`, [id]),
  }),
  documentRequestFulfillment: (id) =>
    rows(`select * from attachments where id = $1`, [id]),
  documentRequestTemplate: (id) => rows(`select * from document_request_templates where id = $1`, [id]),
  shareLinkToken: (token) => rows(`select * from file_share_links where token = $1`, [token]),
  sessionToken: async (token) => ({
    session: await rows(`select * from signature_sessions where token = $1`, [token]),
    participants: await rows(
      `select * from signature_participants where session_id = ${sessionIdSql('$1')} order by id`,
      [token],
    ),
  }),
  client: async (id) => ({
    client: await rows(`select * from clients where id = $1`, [id]),
  }),
  matter: async (id) => rows(`select * from matters where id = $1`, [id]),
};

/**
 * The row the probed id names, and the column it is keyed by. Used only to prove
 * the firm B fixture is really there before a cross-firm case asserts a refusal:
 * a 404 for a row that never existed proves nothing about tenancy.
 */
const PRIMARY: Record<string, { table: string; column: string }> = {
  chargeCode: { table: 'billing_codes', column: 'id' },
  expenseCategory: { table: 'billing_codes', column: 'id' },
  expense: { table: 'activities', column: 'id' },
  flatFee: { table: 'activities', column: 'id' },
  timeEntry: { table: 'activities', column: 'id' },
  invoice: { table: 'invoices', column: 'id' },
  plan: { table: 'billing_plans', column: 'id' },
  planPeriod: { table: 'billing_plan_periods', column: 'id' },
  trustAccount: { table: 'trust_accounts', column: 'id' },
  trustTransaction: { table: 'trust_transactions', column: 'id' },
  minimumBalance: { table: 'trust_minimum_balances', column: 'id' },
  remittance: { table: 'trust_interest_remittances', column: 'id' },
  reconciliation: { table: 'trust_reconciliations', column: 'id' },
  templateFolder: { table: 'template_folders', column: 'id' },
  template: { table: 'templates', column: 'id' },
  signingTemplate: { table: 'signature_templates', column: 'id' },
  documentRequest: { table: 'document_requests', column: 'id' },
  documentRequestItem: { table: 'document_request_items', column: 'id' },
  documentRequestFulfillment: { table: 'attachments', column: 'id' },
  documentRequestTemplate: { table: 'document_request_templates', column: 'id' },
  shareLinkToken: { table: 'file_share_links', column: 'token' },
  sessionToken: { table: 'signature_sessions', column: 'token' },
  client: { table: 'clients', column: 'id' },
  matter: { table: 'matters', column: 'id' },
};

async function expectFixtureExists(entity: string, id: string) {
  const { table, column } = PRIMARY[entity];
  const found = await rows(`select 1 from ${table} where ${column} = $1`, [id]);
  expect({ entity, seeded: found.length }).toEqual({ entity, seeded: 1 });
}

// ── the route table ──────────────────────────────────────────────────

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteCase {
  /** Human label, also the test name. */
  label: string;
  method: Method;
  /**
   * Build the URL. `w` is always the firm being ADDRESSED (firm A in the
   * cross-firm case, so every segment other than the id under test is firm A's
   * own), and `id` is the value being probed.
   */
  path: (w: World, id: string) => string;
  /** Which seeded entity the probed id names. Selects the firm B fixture and the snapshot. */
  entity: keyof typeof SNAPSHOT;
  /** Smallest body that passes validation, so the id is actually reached. */
  body?: unknown;
  /** Query string appended verbatim (leading `?`). */
  query?: string;
  /**
   * True when a successful call would write. Only these get the row-unchanged
   * assertion; a read cannot corrupt firm B's data, so asserting it there would
   * be a case that cannot fail.
   */
  mutating: boolean;
  /**
   * Set when the id is a `text` column, so there is no uuid cast to provoke and
   * invariant (1) does not apply to it.
   */
  textId?: boolean;
  /**
   * How the route refuses.
   *
   * 'error'  (default): the id names one record, so an unreachable one is 404/403.
   * 'empty':  the id is a FILTER on a firm-scoped aggregate, so the route
   *            refuses by reporting nothing rather than by erroring. Asserting
   *            403 on one of these would be asserting a status where the
   *            behaviour is content; `isEmpty` is the real assertion, and the
   *            fixtures put real money and real requests behind firm B's client
   *            and matter so "nothing" cannot be true by accident.
   */
  contract?: 'error' | 'empty';
  /** Required for contract 'empty': throws (or returns false) if the body carries data. */
  isEmpty?: (body: any) => boolean;
  /**
   * The answer the control (firm A's OWN id) gets, where the fixture cannot
   * make it succeed without a state the harness does not build (a payment
   * plan, a past-due date, a stored file). Each is an error the route can only
   * raise AFTER it loaded the record, so it still proves the id was reached;
   * the case also asserts it differs from the cross-firm refusal.
   */
  control?: { status: number; error: string };
}

/** A firm-scoped aggregate answered for an id belonging to nobody in this firm. */
const EMPTY_LEDGER = (body: any) =>
  Array.isArray(body?.transactions) && body.transactions.length === 0 && body.totalItems === 0;

const EMPTY_BALANCE = (body: any) =>
  Number(body?.totalBalanceCents) === 0
  && (body?.accountBalances || []).every((entry: any) => Number(entry.balanceCents) === 0);

const invoicePath = (suffix: string) => (w: World, id: string) =>
  `/api/lawfirms/${w.firmId}/billing/invoices/client/${w.clientId}/${id}${suffix}`;

const trustPath = (build: (id: string) => string) => (w: World, id: string) =>
  `/api/lawfirms/${w.firmId}/trust/${build(id)}`;

const ROUTES: RouteCase[] = [
  // ── billing / charge codes ─────────────────────────────────────────
  {
    label: 'GET billing/charge-codes/:chargeCodeId',
    method: 'get', entity: 'chargeCode', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/charge-codes/${id}`,
  },
  {
    label: 'PUT billing/charge-codes/:chargeCodeId',
    method: 'put', entity: 'chargeCode', mutating: true, body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/charge-codes/${id}`,
  },
  {
    label: 'DELETE billing/charge-codes/:chargeCodeId',
    method: 'delete', entity: 'chargeCode', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/charge-codes/${id}`,
  },

  // ── billing / expense categories ───────────────────────────────────
  {
    label: 'GET billing/expense-categories/:expenseCategoryId',
    method: 'get', entity: 'expenseCategory', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/expense-categories/${id}`,
  },
  {
    label: 'PUT billing/expense-categories/:expenseCategoryId',
    method: 'put', entity: 'expenseCategory', mutating: true, body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/expense-categories/${id}`,
  },
  {
    label: 'DELETE billing/expense-categories/:expenseCategoryId',
    method: 'delete', entity: 'expenseCategory', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/expense-categories/${id}`,
  },

  // ── billing / expenses ─────────────────────────────────────────────
  {
    label: 'PUT billing/expenses/client/:clientId/:expenseId',
    method: 'put', entity: 'expense', mutating: true, body: { description: 'Edited by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/expenses/client/${w.clientId}/${id}`,
  },
  {
    label: 'DELETE billing/expenses/client/:clientId/:expenseId',
    method: 'delete', entity: 'expense', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/expenses/client/${w.clientId}/${id}`,
  },

  // ── billing / flat fees (requireFeature: flatFees) ─────────────────
  {
    label: 'PUT billing/flat-fees/client/:clientId/:flatFeeId',
    method: 'put', entity: 'flatFee', mutating: true, body: { description: 'Edited by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/flat-fees/client/${w.clientId}/${id}`,
  },
  {
    label: 'DELETE billing/flat-fees/client/:clientId/:flatFeeId',
    method: 'delete', entity: 'flatFee', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/flat-fees/client/${w.clientId}/${id}`,
  },

  // ── billing / time entries ─────────────────────────────────────────
  {
    label: 'PUT billing/time-entries/client/:clientId/:timeEntryId',
    method: 'put', entity: 'timeEntry', mutating: true, body: { description: 'Edited by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/time-entries/client/${w.clientId}/${id}`,
  },
  {
    label: 'DELETE billing/time-entries/client/:clientId/:timeEntryId',
    method: 'delete', entity: 'timeEntry', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/time-entries/client/${w.clientId}/${id}`,
  },

  // ── billing / invoices ─────────────────────────────────────────────
  {
    label: 'DELETE billing/invoices/client/:clientId/:invoiceId',
    method: 'delete', entity: 'invoice', mutating: true, path: invoicePath(''),
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/details',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { invoiceName: 'Renamed by firm A' }, path: invoicePath('/details'),
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/line-items',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { timeEntries: [], flatFees: [], expenses: [] }, path: invoicePath('/line-items'),
  },
  {
    label: 'PUT billing/invoices/client/:clientId/:invoiceId/payment',
    method: 'put', entity: 'invoice', mutating: true,
    body: { paymentAmount: 1000, paymentSource: 'external' }, path: invoicePath('/payment'),
  },
  {
    label: 'DELETE billing/invoices/client/:clientId/:invoiceId/payment',
    method: 'delete', entity: 'invoice', mutating: true,
    query: '?paymentIndex=0', path: invoicePath('/payment'),
    control: { status: 400, error: 'That payment no longer exists on this invoice. Refresh and try again.' },
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/payment',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { paymentIndex: 0, amount: 500 }, path: invoicePath('/payment'),
    control: { status: 400, error: 'That payment no longer exists on this invoice. Refresh and try again.' },
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/add-amount',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { amount: 1000, note: 'firm A' }, path: invoicePath('/add-amount'),
  },
  {
    label: 'POST billing/invoices/client/:clientId/:invoiceId/late-fee',
    method: 'post', entity: 'invoice', mutating: true, path: invoicePath('/late-fee'),
    control: { status: 400, error: 'Invoice is not yet past due beyond the grace period' },
  },
  {
    label: 'POST billing/invoices/client/:clientId/:invoiceId/credit-note',
    method: 'post', entity: 'invoice', mutating: true,
    body: { amount: 100, type: 'discount', description: 'firm A' },
    path: invoicePath('/credit-note'),
  },
  {
    label: 'DELETE billing/invoices/client/:clientId/:invoiceId/credit-note',
    method: 'delete', entity: 'invoice', mutating: true,
    query: `?creditNoteId=${randomUUID()}`, path: invoicePath('/credit-note'),
    control: { status: 404, error: 'Credit note not found' },
  },
  {
    label: 'POST billing/invoices/client/:clientId/:invoiceId/payment-plan',
    method: 'post', entity: 'invoice', mutating: true,
    body: { installmentAmount: 1000, frequencyDays: 30, planStartDate: '2026-01-05' },
    path: invoicePath('/payment-plan'),
  },
  {
    label: 'DELETE billing/invoices/client/:clientId/:invoiceId/payment-plan',
    method: 'delete', entity: 'invoice', mutating: true, path: invoicePath('/payment-plan'),
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/payment-plan/installment/:i',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { amount: 500 }, path: invoicePath('/payment-plan/installment/0'),
    control: { status: 400, error: 'No active payment plan' },
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/payment-plan/schedule',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { installments: [{ dueDate: '2026-02-01', amount: 1000 }] },
    path: invoicePath('/payment-plan/schedule'),
    control: { status: 400, error: 'No active payment plan' },
  },
  {
    label: 'DELETE billing/invoices/client/:clientId/:invoiceId/payment-plan/installment/:i/payment',
    method: 'delete', entity: 'invoice', mutating: true,
    path: invoicePath('/payment-plan/installment/0/payment'),
    control: { status: 400, error: 'No active payment plan' },
  },
  {
    label: 'GET billing/invoices/client/:clientId/:invoiceId/export/ledes',
    method: 'get', entity: 'invoice', mutating: false, path: invoicePath('/export/ledes'),
  },
  {
    label: 'POST billing/invoices/client/:clientId/:invoiceId/send-reminder',
    method: 'post', entity: 'invoice', mutating: true, path: invoicePath('/send-reminder'),
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/reminder-optout',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { optOut: true }, path: invoicePath('/reminder-optout'),
  },
  {
    label: 'PATCH billing/invoices/client/:clientId/:invoiceId/pre-due-reminder',
    method: 'patch', entity: 'invoice', mutating: true,
    body: { invoiceDays: 3 }, path: invoicePath('/pre-due-reminder'),
  },
  {
    label: 'GET billing/invoices/client/:clientId/:invoiceId/billing-recipients',
    method: 'get', entity: 'invoice', mutating: false, path: invoicePath('/billing-recipients'),
  },
  {
    label: 'POST billing/invoices/client/:clientId/:invoiceId/billing-recipients/refresh',
    method: 'post', entity: 'invoice', mutating: true,
    path: invoicePath('/billing-recipients/refresh'),
    control: { status: 400, error: 'Client A has no billing email on file, so there is no address to refresh the billing recipient to. Add an email address to a related client and enable “Receives emails,” or enter a billing email on the invoice.' },
  },
  {
    label: 'POST billing/invoices/client/:clientId/:invoiceId/send-email',
    method: 'post', entity: 'invoice', mutating: true,
    body: { recipientEmail: 'firm-a@example.test', recipientName: 'Firm A' },
    path: invoicePath('/send-email'),
  },
  {
    label: 'GET billing/invoices/:invoiceId/sent-copies',
    method: 'get', entity: 'invoice', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/invoices/${id}/sent-copies`,
  },

  // ── billing / plans ────────────────────────────────────────────────
  {
    label: 'PUT billing/plans/:planId',
    method: 'put', entity: 'plan', mutating: true, body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/plans/${id}`,
  },
  {
    label: 'POST billing/plans/:planId/periods/:periodId/create-draft (planId)',
    method: 'post', entity: 'plan', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/plans/${id}/periods/${w.ids.planPeriodKey}/create-draft`,
  },


  // ── billing / reports ──────────────────────────────────────────────
  {
    label: 'GET billing/reports/by-client/:clientId/matters',
    method: 'get', entity: 'client', mutating: false,
    contract: 'empty', isEmpty: (body) => body?.matters?.length === 0 && body.totalItems === 0,
    path: (w, id) => `/api/lawfirms/${w.firmId}/billing/reports/by-client/${id}/matters`,
  },

  // ── trust (requireFeature: trustAccounting) ────────────────────────
  {
    label: 'GET trust/accounts/:accountId/summary',
    method: 'get', entity: 'trustAccount', mutating: false,
    path: trustPath((id) => `accounts/${id}/summary`),
  },
  {
    label: 'GET trust/accounts/:accountId',
    method: 'get', entity: 'trustAccount', mutating: false,
    path: trustPath((id) => `accounts/${id}`),
  },
  {
    label: 'PUT trust/accounts/:accountId',
    method: 'put', entity: 'trustAccount', mutating: true, body: { name: 'Renamed by firm A' },
    path: trustPath((id) => `accounts/${id}`),
  },
  {
    label: 'PATCH trust/accounts/:accountId/status',
    method: 'patch', entity: 'trustAccount', mutating: true, body: { status: 'inactive' },
    path: trustPath((id) => `accounts/${id}/status`),
    control: { status: 400, error: 'Cannot deactivate a trust account with a non-zero balance.' },
  },
  {
    label: 'PATCH trust/accounts/:accountId/book-close',
    method: 'patch', entity: 'trustAccount', mutating: true, body: { bookCloseDate: '2026-01-31' },
    path: trustPath((id) => `accounts/${id}/book-close`),
  },
  {
    label: 'GET trust/transactions/:transactionId',
    method: 'get', entity: 'trustTransaction', mutating: false,
    path: trustPath((id) => `transactions/${id}`),
  },
  {
    label: 'PATCH trust/transactions/:transactionId/void',
    method: 'patch', entity: 'trustTransaction', mutating: true,
    body: { voidReason: 'voided by firm A' },
    path: trustPath((id) => `transactions/${id}/void`),
  },
  {
    label: 'DELETE trust/minimum-balances/:id',
    method: 'delete', entity: 'minimumBalance', mutating: true,
    path: trustPath((id) => `minimum-balances/${id}`),
  },
  {
    label: 'PUT trust/interest-remittances/:remittanceId',
    method: 'put', entity: 'remittance', mutating: true, body: { notes: 'edited by firm A' },
    path: trustPath((id) => `interest-remittances/${id}`),
  },
  {
    label: 'DELETE trust/interest-remittances/:remittanceId',
    method: 'delete', entity: 'remittance', mutating: true,
    path: trustPath((id) => `interest-remittances/${id}`),
  },
  {
    label: 'GET trust/reconciliations/:reconciliationId',
    method: 'get', entity: 'reconciliation', mutating: false,
    path: trustPath((id) => `reconciliations/${id}`),
  },
  {
    label: 'DELETE trust/reconciliations/:reconciliationId',
    method: 'delete', entity: 'reconciliation', mutating: true,
    path: trustPath((id) => `reconciliations/${id}`),
  },
  {
    label: 'GET trust/clients/:clientId/ledger',
    method: 'get', entity: 'client', mutating: false,
    contract: 'empty', isEmpty: EMPTY_LEDGER,
    path: trustPath((id) => `clients/${id}/ledger`),
  },
  {
    label: 'GET trust/clients/:clientId/balance',
    method: 'get', entity: 'client', mutating: false,
    contract: 'empty', isEmpty: EMPTY_BALANCE,
    path: trustPath((id) => `clients/${id}/balance`),
  },
  {
    label: 'GET trust/matters/:matterId/ledger',
    method: 'get', entity: 'matter', mutating: false,
    contract: 'empty', isEmpty: EMPTY_LEDGER,
    path: trustPath((id) => `matters/${id}/ledger`),
  },
  {
    label: 'GET trust/matters/:matterId/balance',
    method: 'get', entity: 'matter', mutating: false,
    contract: 'empty', isEmpty: EMPTY_BALANCE,
    path: trustPath((id) => `matters/${id}/balance`),
  },

  // ── templates (requireFeature: templates) ──────────────────────────
  {
    label: 'PUT templates/folders/:folderId',
    method: 'put', entity: 'templateFolder', mutating: true, body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/folders/${id}`,
  },
  {
    label: 'DELETE templates/folders/:folderId',
    method: 'delete', entity: 'templateFolder', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/folders/${id}`,
  },
  {
    label: 'GET templates/:templateId',
    method: 'get', entity: 'template', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}`,
  },
  {
    label: 'PUT templates/:templateId',
    method: 'put', entity: 'template', mutating: true, body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}`,
  },
  {
    label: 'DELETE templates/:templateId',
    method: 'delete', entity: 'template', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}`,
  },
  {
    label: 'GET templates/:templateId/placements',
    method: 'get', entity: 'template', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}/placements`,
  },
  {
    label: 'PUT templates/:templateId/placements',
    method: 'put', entity: 'template', mutating: true, body: { placements: [], repeaters: [] },
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}/placements`,
    control: { status: 400, error: 'Only Document Overlay templates support field placements' },
  },
  {
    label: 'POST templates/:templateId/fill',
    method: 'post', entity: 'template', mutating: false, body: { values: {}, format: 'pdf' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}/fill`,
    control: { status: 400, error: 'Only DOCX and Document Overlay templates can be filled server-side' },
  },
  {
    label: 'GET templates/:templateId/preview',
    method: 'get', entity: 'template', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/templates/${id}/preview`,
    control: { status: 400, error: 'Only DOCX and Document Overlay templates have a document preview' },
  },
  // ── signing templates (requireFeature: documentSigning) ────────────
  {
    label: 'GET signing-templates/:templateId',
    method: 'get', entity: 'signingTemplate', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/signing-templates/${id}`,
  },
  {
    label: 'PUT signing-templates/:templateId',
    method: 'put', entity: 'signingTemplate', mutating: true, body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/signing-templates/${id}`,
  },
  {
    label: 'DELETE signing-templates/:templateId',
    method: 'delete', entity: 'signingTemplate', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/signing-templates/${id}`,
  },

  // ── document requests ──────────────────────────────────────────────
  {
    label: 'GET document-requests/:id',
    method: 'get', entity: 'documentRequest', mutating: false,
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-requests/${id}`,
  },
  {
    label: 'PATCH document-requests/:id',
    method: 'patch', entity: 'documentRequest', mutating: true, body: { title: 'Retitled by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-requests/${id}`,
  },
  {
    label: 'DELETE document-requests/:id',
    method: 'delete', entity: 'documentRequest', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-requests/${id}`,
  },
  {
    label: 'PATCH document-requests/:id/items/:itemId (requestId)',
    method: 'patch', entity: 'documentRequest', mutating: true, body: { status: 'received' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-requests/${id}/items/${w.ids.documentRequestItem}`,
  },
  {
    label: 'PATCH document-requests/:id/items/:itemId (itemId)',
    method: 'patch', entity: 'documentRequestItem', mutating: true, body: { status: 'received' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-requests/${w.ids.documentRequest}/items/${id}`,
  },
  {
    label: 'POST document-requests/:id/items/:itemId/link-file (itemId)',
    method: 'post', entity: 'documentRequestItem', mutating: true,
    body: { fileId: '00000000-0000-4000-8000-000000000000' },
    path: (w, id) =>
      `/api/lawfirms/${w.firmId}/document-requests/${w.ids.documentRequest}/items/${id}/link-file`,
    control: { status: 404, error: 'File not found' },
  },
  {
    label: 'DELETE document-requests/:id/items/:itemId/files/:fulfillmentId',
    method: 'delete', entity: 'documentRequestFulfillment', mutating: true,
    path: (w, id) =>
      `/api/lawfirms/${w.firmId}/document-requests/${w.ids.documentRequest}`
      + `/items/${w.ids.documentRequestItem}/files/${id}`,
  },
  {
    label: 'GET document-requests/clients/:clientId',
    method: 'get', entity: 'client', mutating: false,
    contract: 'empty', isEmpty: (body) => body?.requests?.length === 0,
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-requests/clients/${id}`,
  },

  // ── document request templates ─────────────────────────────────────
  {
    label: 'PUT document-request-templates/:templateId',
    method: 'put', entity: 'documentRequestTemplate', mutating: true,
    body: { name: 'Renamed by firm A' },
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-request-templates/${id}`,
  },
  {
    label: 'DELETE document-request-templates/:templateId',
    method: 'delete', entity: 'documentRequestTemplate', mutating: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/document-request-templates/${id}`,
  },

  // ── file share links (requireFeature: fileSharing) ─────────────────
  {
    label: 'DELETE file-share-links/:token',
    method: 'delete', entity: 'shareLinkToken', mutating: true, textId: true,
    path: (w, id) => `/api/lawfirms/${w.firmId}/file-share-links/${id}`,
  },

  // ── signature links (requireFeature: documentSigning) ──────────────
  {
    label: 'POST signature-links/:sessionToken/resend-participant/:participantId',
    method: 'post', entity: 'sessionToken', mutating: true, textId: true,
    path: (w, id) =>
      `/api/lawfirms/${w.firmId}/signature-links/${id}/resend-participant/${w.ids.participant}`,
  },
];

// ── driver ───────────────────────────────────────────────────────────

function send(world: World, route: RouteCase, id: string) {
  const url = `${route.path(world, id)}${route.query || ''}`;
  const request = world.api[route.method](url);
  return route.body === undefined ? request : request.send(route.body as never);
}

/** `refusalVerdict`, with this slice's aggregate routes refusing by reporting nothing. */
function verdict(
  response: { status: number; body?: any; text?: string },
  route: RouteCase,
  accepted: number[] = [400, 403, 404],
) {
  // A firm-scoped aggregate refuses by reporting nothing, not by erroring: a 403
  // would be the wrong contract for it. `isEmpty` is what carries the assertion
  // there, and the fixtures put real money and real requests behind firm B's
  // client and matter so an empty answer cannot be true by accident.
  return refusalVerdict(response, accepted, route.contract === 'empty' ? route.isEmpty : undefined);
}

/**
 * Every gated router in this slice, answered with a well-formed request first.
 *
 * Without this the whole cross-firm half could pass on a plan refusal: if
 * `requireFeature` were firing, every case would get its 403 without the id ever
 * being looked at, and the sweep would prove nothing. A 200 here says the gate is
 * open, so a 403 later is about the id.
 */
async function assertGatesOpen(world: World) {
  const gated: Array<[string, string]> = [
    ['flatFees', `/api/lawfirms/${world.firmId}/billing/flat-fees/client/${world.clientId}`],
    ['analytics', `/api/lawfirms/${world.firmId}/billing/analytics/billing-summary`],
    ['trustAccounting', `/api/lawfirms/${world.firmId}/trust/accounts`],
    ['templates', `/api/lawfirms/${world.firmId}/templates`],
    ['documentSigning', `/api/lawfirms/${world.firmId}/signing-templates`],
    ['fileSharing', `/api/lawfirms/${world.firmId}/file-share-links`
      + `?fileId=${world.ids.file}`],
  ];
  for (const [feature, url] of gated) {
    const response = await world.api.get(url);
    expect({ feature, status: response.status }).toEqual({ feature, status: 200 });
  }
}

describe('entity id handling across billing, trust, files, templates, signatures and document requests', () => {
  let firmA: World;
  let firmB: World;
  let reminderFlag: string | undefined;

  beforeAll(() => {
    // backend/.env sets DISABLE_ALL_REMINDER_EMAILS, and sendReminderForInvoice
    // returns { sent: false } on that flag BEFORE it resolves the invoice. Left
    // set, the two send-reminder cases would pass on the kill switch and say
    // nothing about the id.
    reminderFlag = process.env.DISABLE_ALL_REMINDER_EMAILS;
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  });

  afterAll(() => {
    process.env.DISABLE_ALL_REMINDER_EMAILS = reminderFlag ?? '';
  });

  beforeEach(async () => {
    firmA = await seedWorld('A');
    firmB = await seedWorld('B');
  });

  it('the enterprise plan leaves every gated router in this slice open, so a 403 below is about the id', async () => {
    await assertGatesOpen(firmA);
  });

  it('sweeps every route in the slice that carries an entity id', () => {
    // Guards the table itself: a route deleted from ROUTES by accident would
    // otherwise silently shrink the sweep with every case still green.
    expect(ROUTES.length).toBe(78);
    expect(new Set(ROUTES.map((route) => route.label)).size).toBe(ROUTES.length);
  });

  describe('(1) a malformed entity id is refused, never a 500', () => {
    const uuidRoutes = ROUTES.filter((route) => !route.textId);

    it.each(uuidRoutes)('$label', async (route) => {
      const response = await send(firmA, route, MALFORMED_ID);

      // Breaks when the repository stops guarding the id and the raw value
      // reaches Postgres as a 22P02 invalid_text_representation, which the error
      // middleware turns into a 500 INTERNAL_ERROR.
      expect(verdict(response, route)).toBe('refused');
    });

    // The control. A well-formed id that names nothing must be answered the same
    // way, so the case above is pinning "refused", not "happens to be rejected
    // by some unrelated shape check on the string".
    it.each(uuidRoutes)('$label (absent but well-formed id)', async (route) => {
      const response = await send(firmA, route, absentId());
      expect(verdict(response, route)).toBe('refused');
    });
  });

  describe("(2) another firm's entity is never served, and never written", () => {
    it.each(ROUTES)('$label', async (route) => {
      const foreignId = firmB.ids[route.entity] ?? (route.entity === 'client' ? firmB.clientId : null);
      if (!foreignId) throw new Error(`no firm B fixture for entity ${route.entity}`);

      // The fixture has to exist, or "unchanged" is vacuously true and the case
      // proves nothing: a 404 for a row that was never there says nothing about
      // tenancy.
      await expectFixtureExists(route.entity, foreignId);
      const before = await SNAPSHOT[route.entity](foreignId);

      const response = await send(firmA, route, foreignId);

      // Breaks when the route resolves the id without the firm predicate: it
      // answers 200 with firm B's data.
      expect(verdict(response, route, [403, 404])).toBe('refused');

      if (route.mutating) {
        const after = await SNAPSHOT[route.entity](foreignId);
        // Breaks when the route writes first and refuses second. The status
        // above would still be 404 in that case; only this catches it.
        expect(after).toEqual(before);
      }

      // Control. Without it a refusal proves nothing: the same 404 would appear
      // if the URL were wrong or the body were rejected before the id was read.
      const ownId = firmA.ids[route.entity] ?? (route.entity === 'client' ? firmA.clientId : null);
      const control = await send(firmA, route, ownId!);
      if (route.control) {
        expect({ status: control.status, error: control.body?.error }).toEqual(route.control);
        expect(control.body?.error).not.toBe(response.body?.error);
      } else {
        const outcome = control.status < 400 ? 'ok' : `${control.status} ${JSON.stringify(control.body)}`;
        expect({ route: route.label, outcome }).toEqual({ route: route.label, outcome: 'ok' });
      }
    });
  });
});
