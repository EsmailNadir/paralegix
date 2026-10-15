/**
 * Who an invoice is billed to, and the frozen record of who it was billed to.
 *
 * This is the ONE place that answers both questions. Everything that emails an
 * invoice, requests payment for one, reminds about one, receipts one, refunds
 * one, or renders one goes through here, so a company's accounts-payable list
 * and a person's own address are resolved by a single rule rather than by each
 * caller's own idea of what "the client's email" means.
 *
 * Two distinct answers, deliberately not the same function:
 *
 *   CURRENT recipients   who WOULD be billed if the invoice went out right now.
 *                        Re-resolved on every call from live client/roster data.
 *                        Used for drafts, previews, and any invoice that has
 *                        never left the firm.
 *
 *   SNAPSHOT             who WAS billed. Written exactly once, on the invoice's
 *                        first external issue, and never re-derived afterwards.
 *                        A roster change months later does not rewrite the
 *                        record of who received a bill in March.
 *
 * The snapshot lives in the `invoices.billing_*` columns (migrations 0171 and
 * 0173): `billing_emails`, `billing_contact_name`, `billing_contact_title`,
 * `billing_contact_email`, `billing_client_address`, `billing_client_name`,
 * `billing_snapshot_at`. `billing_snapshot_at` is both the marker and the
 * concurrency guard.
 *
 * ## Resolution rules
 *
 * PERSON client: the invoice's `billingEmail` override PLUS the person's own
 * `clients.email`, deduplicated. The override is ADDITIVE here, not a
 * replacement, preserving the behaviour the reminder and send-email paths
 * already shipped: a firm that fills in a bookkeeper's address must not
 * silently stop mailing the actual client. In practice the two are usually the
 * same address (draft creation seeds `billingEmail` from the client's email),
 * so the dedupe collapses them to one.
 *
 * COMPANY client: an explicit `billingEmail` override REPLACES the linked-
 * contact list when present, so a firm can direct one invoice at one person at
 * the company; otherwise every `client_company_links` row flagged
 * `is_email_recipient`, ordered by primary status, then link creation time,
 * then link id. The first of those is the "attention" contact whose name and
 * address go on the bill. A linked Person `clients` row has no job-title
 * field, so `contactTitle` is always null for a company bill now (see the
 * note on `fetchCompanyBillingContacts` below).
 *
 * A company with no billing recipient and no override has nobody to bill.
 * Issue/send/payment-request paths raise `NoBillingRecipientError` rather than
 * quietly mailing nobody.
 *
 * ## Legacy columns
 *
 * `invoices.client_name` / `client_email` / `billing_email` remain as they are.
 * They are still written at draft creation and still read by older display
 * code, but they are compatibility data: only the `billing_*` snapshot columns
 * carry the freeze-on-issue guarantee, and once a snapshot exists it is what
 * every delivery path uses.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import { clientCompanyLinks, clients } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';

const { financialRootSql } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');
const { NoBillingRecipientError, NotFoundError } = require('../../../shared/errors/AppError');
const { recordAudit } = require('../../audit/audit.service');

/**
 * The resolved bill-to identity for one invoice.
 *
 * `source` says which of the two questions above was answered: 'snapshot' means
 * these values are the frozen historical record, 'current' means they were
 * derived from live data just now and may change before the invoice issues.
 */
export type BillingRecipients = {
  /** The legal client the invoice belongs to (`clients.id`), or null if unresolvable. */
  clientRecordId: string | null;
  clientType: 'person' | 'company' | null;
  /** Display/legal name of the client being billed. */
  clientName: string | null;
  /** `clients.address` (plain text) as of resolution. */
  clientAddress: string | null;
  /** Attention contact on a company bill. Always null for a person client. */
  contactName: string | null;
  contactTitle: string | null;
  /** First address in `emails`, i.e. the primary billing address. */
  primaryEmail: string | null;
  /** Every address this invoice should reach, normalized and deduplicated. */
  emails: string[];
  source: 'snapshot' | 'current';
  snapshotAt: string | null;
};

function emptyRecipients(source: 'snapshot' | 'current'): BillingRecipients {
  return {
    clientRecordId: null,
    clientType: null,
    clientName: null,
    clientAddress: null,
    contactName: null,
    contactTitle: null,
    primaryEmail: null,
    emails: [],
    source,
    snapshotAt: null,
  };
}

/**
 * Normalize and deduplicate a list of addresses, preserving the order they were
 * offered in. Comparison is case-insensitive (matching the `citext` columns
 * these addresses come from) but the original casing is what gets stored and
 * mailed.
 */
export function normalizeEmailList(values: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values || []) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * The `clients.id` an invoice bills to.
 *
 * `client_id` is the explicit "bill to" client and wins. `matter_client_id`
 * (also a `clients.id`) covers matter invoices addressed to one of the matter's
 * clients without an explicit bill-to. `client_context_id` is the owning client
 * record of a client-context invoice, which creation already mirrors into
 * `client_id` but which is the correct last resort for older rows.
 */
export function invoiceClientRecordId(invoice: any): string | null {
  const candidate = invoice?.clientId || invoice?.matterClientId || invoice?.clientContextId || null;
  return isUuid(candidate) ? candidate : null;
}

/**
 * The frozen snapshot on an invoice, or null when it has never issued.
 *
 * Pure: takes the already-loaded invoice object, touches no database. Callers
 * that only need to know whether a snapshot exists should use this rather than
 * paying for a resolve.
 */
export function readInvoiceSnapshot(invoice: any): BillingRecipients | null {
  if (!invoice?.billingSnapshotAt) return null;
  const emails = normalizeEmailList(invoice.billingEmails || []);
  return {
    clientRecordId: invoiceClientRecordId(invoice),
    clientType: null,
    // billingClientName is the frozen value the snapshot was taken with.
    clientName: invoice.billingClientName || null,
    clientAddress: invoice.billingClientAddress || null,
    contactName: invoice.billingContactName || null,
    contactTitle: invoice.billingContactTitle || null,
    primaryEmail: invoice.billingContactEmail || emails[0] || null,
    emails,
    source: 'snapshot',
    snapshotAt: invoice.billingSnapshotAt,
  };
}

/**
 * The company's billing-recipient links, in the plan's deterministic order.
 *
 * `title` is always null: the old `contacts` directory row carried a job
 * title, but a linked Person `clients` row has no such column. Nothing in the
 * product has asked for a client-facing job-title field yet, so this is left
 * null rather than guessing at a substitute (e.g. `relationship`, which means
 * something different - the person's relationship to the company, not their
 * title) - if the invoice "Attn:" line needs a title again, that's a
 * deliberate follow-up, not a mechanical carry-over.
 */
type RosterBillingContact = { contactClientId: string; name: string | null; title: string | null; email: string | null };

async function fetchCompanyBillingContacts(lawFirmId: string, clientId: string): Promise<RosterBillingContact[]> {
  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({
      contactClientId: clientCompanyLinks.id,
      name: clients.name,
      email: clients.email,
      relationship: clientCompanyLinks.relationship,
    })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(
      scope,
      eq(clientCompanyLinks.companyClientId, clientId),
      eq(clientCompanyLinks.isEmailRecipient, true),
    ))
    // Primary first, then oldest link, then id: a stable order so the
    // "attention" contact and the address ordering are reproducible.
    .orderBy(
      desc(clientCompanyLinks.isPrimary),
      asc(clientCompanyLinks.createdAt),
      asc(clientCompanyLinks.id),
    )) as { contactClientId: string; name: string | null; email: string | null; relationship: string | null }[];
  return rows.map((row) => ({ ...row, title: row.relationship || null }));
}

/**
 * Resolve who WOULD be billed right now for `clientId`, honouring
 * `overrideEmail` (the invoice's `billingEmail`) per the person/company rules
 * in this module's header.
 *
 * Never throws for a missing recipient: an empty `emails` list is a legitimate
 * answer for a draft. The paths that actually send call
 * `assertHasRecipients` on the result.
 *
 * Pass `client` when the caller already holds the `clients` row (it needs
 * `id`, `name`, `email`, `address` and `clientType`) to skip the client read.
 * A person client then costs no queries at all.
 */
export async function resolveCurrentBillingRecipients({ lawFirmId, clientId, overrideEmail, client: preloaded }: any): Promise<BillingRecipients> {
  const override = typeof overrideEmail === 'string' ? overrideEmail.trim() : '';

  if (!lawFirmId || !isUuid(clientId)) {
    // No resolvable client record: the override is all we have to go on.
    return { ...emptyRecipients('current'), emails: normalizeEmailList([override]), primaryEmail: override || null };
  }

  let client = preloaded && preloaded.id === clientId ? preloaded : null;
  if (!client) {
    const clientRows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
      .select({
        id: clients.id,
        name: clients.name,
        email: clients.email,
        address: clients.address,
        clientType: clients.clientType,
      })
      .from(clients)
      .where(and(scope, eq(clients.id, clientId)))
      .limit(1));
    client = (clientRows as any[])[0] || null;
  }

  if (!client) {
    return { ...emptyRecipients('current'), emails: normalizeEmailList([override]), primaryEmail: override || null };
  }

  const base: BillingRecipients = {
    ...emptyRecipients('current'),
    clientRecordId: client.id,
    clientType: client.clientType === 'company' ? 'company' : 'person',
    clientName: client.name || null,
    clientAddress: client.address || null,
  };

  if (base.clientType === 'person') {
    // Additive: the override supplements the person's own address, it does not
    // replace it (see the header note on why).
    const emails = normalizeEmailList([override, client.email]);
    return { ...base, emails, primaryEmail: emails[0] || null };
  }

  // Company: an explicit override replaces the roster list entirely.
  if (override) {
    const emails = normalizeEmailList([override]);
    return { ...base, emails, primaryEmail: emails[0] || null };
  }

  const rosterContacts = await fetchCompanyBillingContacts(lawFirmId, client.id);
  let emails = normalizeEmailList(rosterContacts.map((row) => row.email));

  // Fallback: if no linked roster person has an email recipient flag or address,
  // fall back to the primary email set directly on the company's client record.
  if (emails.length === 0 && typeof client.email === 'string' && client.email.trim()) {
    emails = normalizeEmailList([client.email]);
  }

  // The "attention" line names the first recipient that can actually be
  // written to; a roster link flagged as a billing recipient but carrying no
  // email is not a usable Attn.
  const attention = rosterContacts.find((row) => typeof row.email === 'string' && row.email.trim())
    || rosterContacts[0]
    || null;

  return {
    ...base,
    contactName: attention?.name || null,
    contactTitle: attention?.title || null,
    emails,
    primaryEmail: emails[0] || null,
  };
}

/**
 * The recipients an already-persisted invoice should be delivered to: the
 * snapshot once one exists, otherwise a live resolve.
 *
 * This is the read every delivery path wants. Reminders, receipts and refund
 * notices for an issued invoice get the frozen list; the same call on a draft
 * (a reminder can fire on an unissued invoice that has a due date) falls back
 * to current recipients rather than returning nothing.
 */
export async function resolveInvoiceRecipients({ lawFirmId, invoice }: any): Promise<BillingRecipients> {
  const snapshot = readInvoiceSnapshot(invoice);
  if (snapshot) return snapshot;
  return resolveCurrentBillingRecipients({
    lawFirmId,
    clientId: invoiceClientRecordId(invoice),
    overrideEmail: invoice?.billingEmail || null,
  });
}

/**
 * Raise the plan's "fail clearly rather than mail nobody" error when a delivery
 * path has no address to send to. `action` is folded into the message so the
 * firm is told which operation it blocked.
 */
export function assertHasRecipients(recipients: BillingRecipients, action = 'send this invoice') {
  if (recipients.emails.length > 0) return recipients;
  const who = recipients.clientType === 'company'
    ? `${recipients.clientName || 'This company'} has no email recipient with an email address on its related-clients list`
    : `${recipients.clientName || 'This client'} has no billing email on file`;
  throw new NoBillingRecipientError(
    `${who}, so there is no address to ${action}. Add an email address to a related client and enable “Receives emails,” or enter a billing email on the invoice.`,
  );
}

/** Persist a resolution into the invoice's snapshot columns. Returns true if this call wrote it. */
async function writeSnapshotColumns(
  lawFirmId: string,
  invoiceId: string,
  recipients: BillingRecipients,
  { onlyIfUnset }: { onlyIfUnset: boolean },
): Promise<{ written: boolean; snapshotAt: string | null }> {
  const guard = onlyIfUnset ? ' and billing_snapshot_at is null' : '';
  const { rows } = await financialRootSql(
    `update invoices
        set billing_emails = $3::text[],
            billing_contact_name = $4,
            billing_contact_title = $5,
            billing_contact_email = $6,
            billing_client_address = $7,
            billing_client_name = $8,
            billing_snapshot_at = now(),
            updated_at = now()
      where law_firm_id = $1 and id = $2${guard}
      returning billing_snapshot_at`,
    [
      lawFirmId,
      invoiceId,
      recipients.emails,
      recipients.contactName,
      recipients.contactTitle,
      recipients.primaryEmail,
      recipients.clientAddress,
      recipients.clientName,
    ],
  );
  const snapshotAt = rows[0]?.billing_snapshot_at
    ? new Date(rows[0].billing_snapshot_at).toISOString()
    : null;
  return { written: rows.length > 0, snapshotAt };
}

/** Re-read the snapshot columns of one invoice (used after losing a snapshot race). */
async function readSnapshotColumns(lawFirmId: string, invoiceId: string): Promise<BillingRecipients | null> {
  const { rows } = await financialRootSql(
    `select client_id, matter_client_id, client_context_id, client_name,
            billing_emails, billing_contact_name, billing_contact_title,
            billing_contact_email, billing_client_address, billing_client_name,
            billing_snapshot_at
       from invoices where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, invoiceId],
  );
  const row = rows[0];
  if (!row || !row.billing_snapshot_at) return null;
  return readInvoiceSnapshot({
    clientId: row.client_id,
    matterClientId: row.matter_client_id,
    clientContextId: row.client_context_id,
    billingClientName: row.billing_client_name,
    billingEmails: row.billing_emails || [],
    billingContactName: row.billing_contact_name,
    billingContactTitle: row.billing_contact_title,
    billingContactEmail: row.billing_contact_email,
    billingClientAddress: row.billing_client_address,
    billingSnapshotAt: new Date(row.billing_snapshot_at).toISOString(),
  });
}

/**
 * Freeze the bill-to record on an invoice's FIRST external issue, and return
 * the recipients that issue should use.
 *
 * Call this at the moment an invoice leaves the firm: emailing it to the
 * client, creating a hosted Stripe payment link, or minting a portal checkout
 * URL. Not on draft creation, and not on a later resend.
 *
 * Idempotent and safe under concurrent sends. The write is a single
 * `UPDATE ... WHERE billing_snapshot_at IS NULL`, so two simultaneous sends
 * serialize on the invoice row: the first writes, the second's predicate is
 * re-evaluated against the committed row, matches nothing, and it reads back
 * the snapshot the winner wrote. Neither the resolve nor the write can produce
 * two different frozen records, and an already-snapshotted invoice never
 * re-resolves at all (the fast path below returns before touching the roster).
 *
 * `extraEmails` are one-off addresses supplied by whoever is issuing (the
 * address typed into the send dialog). They join the resolved list and are
 * frozen with it, because they are genuinely part of who this invoice went to.
 *
 * `requireRecipients` (default true) makes an empty recipient list a hard
 * failure, so a send never silently reaches nobody. Passing false relaxes that
 * for a path where delivery is not the point (a portal checkout URL the client
 * is already looking at); such a call writes NO snapshot when there is nothing
 * to freeze, rather than permanently recording "nobody" as the bill-to.
 */
export async function snapshotInvoiceRecipients({
  lawFirmId, invoice, invoiceId, action = 'send this invoice', requireRecipients = true, extraEmails = [],
}: any): Promise<BillingRecipients> {
  const id = invoiceId || invoice?.id;
  if (!lawFirmId || !isUuid(id)) throw new NotFoundError('Invoice');

  // Already issued: the frozen record stands, no re-resolution.
  const existing = readInvoiceSnapshot(invoice) || await readSnapshotColumns(lawFirmId, id);
  if (existing) {
    if (requireRecipients) assertHasRecipients(existing, action);
    return existing;
  }

  const base = await resolveCurrentBillingRecipients({
    lawFirmId,
    clientId: invoiceClientRecordId(invoice),
    overrideEmail: invoice?.billingEmail || null,
  });
  // Extras go AFTER the resolved list so the primary billing address stays the
  // client's own attention contact, keeping `billing_contact_email` coherent
  // with the `billing_contact_name`/`_title` beside it. A one-off address typed
  // into a send dialog only becomes the primary when there was no other.
  const emails = normalizeEmailList([...base.emails, ...(extraEmails || [])]);
  const resolved: BillingRecipients = {
    ...base,
    emails,
    primaryEmail: base.primaryEmail || emails[0] || null,
  };

  if (requireRecipients) assertHasRecipients(resolved, action);
  // Nothing to freeze and the caller tolerates that: leave the invoice
  // unsnapshotted so a later, properly-addressed issue can still take the
  // real record.
  if (resolved.emails.length === 0) return resolved;

  const { written, snapshotAt } = await writeSnapshotColumns(lawFirmId, id, resolved, { onlyIfUnset: true });
  if (!written) {
    // Lost the race: another send snapshotted between our read and our write.
    // Its record is the authoritative one.
    const winner = await readSnapshotColumns(lawFirmId, id);
    if (winner) {
      if (requireRecipients) assertHasRecipients(winner, action);
      return winner;
    }
    // The row disappeared (invoice deleted mid-send). Report the resolution we
    // computed rather than inventing a snapshot that no longer has a home.
    return resolved;
  }

  // Mirror the persisted values onto the in-hand invoice so a caller that keeps
  // using its already-loaded copy sees the snapshot it just took.
  if (invoice && typeof invoice === 'object') {
    invoice.billingEmails = resolved.emails;
    invoice.billingContactName = resolved.contactName;
    invoice.billingContactTitle = resolved.contactTitle;
    invoice.billingContactEmail = resolved.primaryEmail;
    invoice.billingClientAddress = resolved.clientAddress;
    invoice.billingClientName = resolved.clientName;
    invoice.billingSnapshotAt = snapshotAt;
  }

  return { ...resolved, source: 'snapshot', snapshotAt };
}

/**
 * Set an invoice's billing emails to exactly `emails`, for the firm correcting
 * an address it learned was wrong. Like `refreshInvoiceRecipients` this
 * rewrites the frozen bill-to record and audits it; unlike it, the addresses
 * come from the firm, not the client record. The client's name and address on
 * the record are kept. An attention contact is kept only while their address
 * is still on the list.
 */
export async function replaceInvoiceRecipientEmails({ lawFirmId, invoice, invoiceId, emails, actingUserId }: any): Promise<BillingRecipients> {
  const id = invoiceId || invoice?.id;
  if (!lawFirmId || !isUuid(id)) throw new NotFoundError('Invoice');

  const nextEmails = normalizeEmailList(Array.isArray(emails) ? emails : []);
  const previous = readInvoiceSnapshot(invoice) || await readSnapshotColumns(lawFirmId, id);
  const base = previous || await resolveCurrentBillingRecipients({
    lawFirmId,
    clientId: invoiceClientRecordId(invoice),
    overrideEmail: null,
  });
  const keepsContact = !!base.primaryEmail
    && nextEmails.some((email) => email.toLowerCase() === base.primaryEmail!.toLowerCase());
  const recipients: BillingRecipients = {
    ...base,
    emails: nextEmails,
    primaryEmail: nextEmails[0] || null,
    contactName: keepsContact ? base.contactName : null,
    contactTitle: keepsContact ? base.contactTitle : null,
  };
  assertHasRecipients(recipients, 'set the billing email to');

  const { written, snapshotAt } = await writeSnapshotColumns(lawFirmId, id, recipients, { onlyIfUnset: false });
  if (!written) throw new NotFoundError('Invoice');

  await recordAudit({
    lawFirmId,
    actorUid: actingUserId || null,
    action: 'invoice.billing_recipients.edited',
    resourceType: 'invoice',
    resourceId: id,
    metadata: {
      previousEmails: previous?.emails || [],
      newEmails: nextEmails,
      previousSnapshotAt: previous?.snapshotAt || null,
    },
  });

  return { ...recipients, source: 'snapshot', snapshotAt };
}

/**
 * Deliberately REPLACE an existing bill-to snapshot with the client's current
 * billing details.
 *
 * This is the one sanctioned way to rewrite history, for the case where an
 * invoice was issued against stale or wrong recipient data and the firm needs
 * the reminders and reprints to go to the corrected address. It is permissioned
 * at the route (`billing.manageInvoices`) and audited here, so a rewritten
 * snapshot always leaves a record of who rewrote it and what it said before.
 *
 * Distinct from `snapshotInvoiceRecipients`, which can never overwrite.
 */
export async function refreshInvoiceRecipients({ lawFirmId, invoice, invoiceId, actingUserId }: any): Promise<BillingRecipients> {
  const id = invoiceId || invoice?.id;
  if (!lawFirmId || !isUuid(id)) throw new NotFoundError('Invoice');

  const previous = readInvoiceSnapshot(invoice) || await readSnapshotColumns(lawFirmId, id);

  const resolved = await resolveCurrentBillingRecipients({
    lawFirmId,
    clientId: invoiceClientRecordId(invoice),
    overrideEmail: invoice?.billingEmail || null,
  });
  assertHasRecipients(resolved, 'refresh the billing recipient to');

  const { written, snapshotAt } = await writeSnapshotColumns(lawFirmId, id, resolved, { onlyIfUnset: false });
  if (!written) throw new NotFoundError('Invoice');

  await recordAudit({
    lawFirmId,
    actorUid: actingUserId || null,
    action: 'invoice.billing_recipients.refreshed',
    resourceType: 'invoice',
    resourceId: id,
    metadata: {
      previousEmails: previous?.emails || [],
      newEmails: resolved.emails,
      previousContactEmail: previous?.primaryEmail || null,
      newContactEmail: resolved.primaryEmail,
      previousSnapshotAt: previous?.snapshotAt || null,
      hadSnapshot: Boolean(previous),
    },
  });

  if (invoice && typeof invoice === 'object') {
    invoice.billingEmails = resolved.emails;
    invoice.billingContactName = resolved.contactName;
    invoice.billingContactTitle = resolved.contactTitle;
    invoice.billingContactEmail = resolved.primaryEmail;
    invoice.billingClientAddress = resolved.clientAddress;
    invoice.billingClientName = resolved.clientName;
    invoice.billingSnapshotAt = snapshotAt;
  }

  return { ...resolved, source: 'snapshot', snapshotAt };
}
