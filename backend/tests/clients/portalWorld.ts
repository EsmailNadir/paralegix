/**
 * Fixture builders for the client-portal spec files in this directory.
 *
 * Every insert is plain SQL through the test pool. Nothing here goes through a
 * portal route, a portal service or a repository: the portal IS the code under
 * test in these files, so a fixture built with it could not fail when it is
 * wrong. `tests/support/factories.ts` already covers firms, portal users,
 * clients, invoices and trust; this module adds the rows those specs need that
 * the shared factories do not build (matters, matter notes, matter events,
 * notifications, direct conversations and messages, document requests).
 *
 * MARKERS. Almost every assertion in these files is "this string must / must
 * not appear in that response body". So each builder takes or returns a
 * distinctive marker: a matter name, a note subject, an invoice number, a
 * message body, a cents figure that appears nowhere else. Searching a response
 * for a value that two fixtures share is a test that cannot fail, which is why
 * the builders below never default a marker to a shared constant.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createPersonClient,
  createPortalUser,
  as,
  tokenFor,
  type Actor,
} from '../support/setupInProcess';

const filesRepo = require('../../src/modules/files/files.repository');

export interface PortalPerson extends Actor {
  /** The `clients` row this portal user owns in the firm under test. */
  clientId: string;
  email: string;
  name: string;
}

/** The path prefix every route in these specs hangs off. */
export const portalPath = (lawFirmId: string, suffix: string): string =>
  `/api/client-portal/lawfirm/${lawFirmId}/${suffix}`;

/**
 * A response body flattened to one searchable string.
 *
 * Used for the "does this response state firm B's data" assertions. JSON rather
 * than a field-by-field walk because the shapes differ per route and a leak can
 * surface in a nested field a hand-written path would miss.
 */
export const bodyText = (res: { body: unknown; text?: string }): string =>
  `${JSON.stringify(res.body ?? null)}${res.text ?? ''}`;

/**
 * A portal user plus their own person `clients` row in one firm.
 *
 * The email is unique per person and set on BOTH the `users` row (by the
 * factory) and the `clients` row: two ownership rules in the portal match on
 * email (`findMatterClientDocIds` matches a placeholder matter-client by email,
 * `invoiceBelongsToClient` matches `billing_email`), so two people sharing an
 * address would make every isolation case here pass for the wrong reason.
 */
export async function portalPerson(lawFirmId: string, name: string): Promise<PortalPerson> {
  const { uid } = await createPortalUser({ name });
  const email = `${uid}@example.test`;
  const client = await createPersonClient(lawFirmId, { name, userId: uid, email });
  return { uid, clientId: client.id, email, name, api: as(tokenFor({ uid })) };
}

/**
 * A matter, plus one `matter_clients` row per client on it.
 *
 * That junction IS the portal's definition of matter access
 * (`clientsRepo.listMatterIds`), so a silently missing row would turn every
 * positive case into a 403 and every negative one into a vacuous pass. Both
 * inserts are therefore checked.
 */
export async function seedMatter(
  lawFirmId: string,
  name: string,
  clientIds: string[],
): Promise<string> {
  const id = randomUUID();
  const inserted = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(inserted.rowCount).toBe(1);

  for (const clientId of clientIds) {
    const link = await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
      [id, clientId, lawFirmId],
    );
    expect(link.rowCount).toBe(1);
  }
  return id;
}

/**
 * A client-context invoice, billed directly to a client with no matter.
 *
 * `stripePaymentRequested` is exposed because the pay-link route reads it: an
 * invoice the firm has not requested payment on reaches Stripe and is refused
 * there with a 400, which is what makes a 404 from the same route provably an
 * OWNERSHIP refusal rather than an unconfigured payment provider.
 */
export async function seedClientInvoice(
  lawFirmId: string,
  clientId: string,
  options: { totalCents: number; invoiceNumber: string; stripePaymentRequested?: boolean },
): Promise<{ id: string; totalCents: number; invoiceNumber: string }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, stripe_payment_requested,
                           invoice_date, due_date)
     values ($1, $2, $3, $3, 'client', $4, 'outstanding', $5, $6, current_date, current_date + 30)`,
    [id, lawFirmId, clientId, options.invoiceNumber, options.totalCents,
      options.stripePaymentRequested ?? false],
  );
  expect(res.rowCount).toBe(1);
  return { id, totalCents: options.totalCents, invoiceNumber: options.invoiceNumber };
}

/**
 * A trust account with no transactions in it yet.
 *
 * Separate from the deposit builder because the point of these specs is several
 * clients sharing ONE account; `createTrustDeposit` in the shared factories opens
 * an account per call, which cannot express that.
 */
export async function seedTrustAccount(
  lawFirmId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents)
     values ($1, $2, $3, 'iolta', 'active', 0)`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return { id, name };
}

/**
 * One completed trust deposit against a client, in an account that already
 * exists.
 *
 * `createTrustDeposit` in the shared factories opens a NEW account per call,
 * which makes "each client sees only their own rows" trivially true through
 * account separation rather than through the client predicate. Seeding a second
 * client into the SAME account is what forces the predicate to be the thing
 * doing the work.
 *
 * `trust_transactions` is append-only by database trigger; inserting is fine.
 */
export async function seedTrustDeposit(
  lawFirmId: string,
  trustAccountId: string,
  clientId: string,
  options: { amountCents: number; description: string },
): Promise<{ id: string; amountCents: number; description: string }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into trust_transactions
       (id, law_firm_id, trust_account_id, type, amount_cents, client_id,
        txn_date, description, status, client_balance_after_cents, account_balance_after_cents)
     values ($1, $2, $3, 'deposit', $4, $5, current_date, $6, 'completed', $4, $4)`,
    [id, lawFirmId, trustAccountId, options.amountCents, clientId, options.description],
  );
  expect(res.rowCount).toBe(1);
  return { id, amountCents: options.amountCents, description: options.description };
}

/**
 * A matter-context invoice addressed to ONE of the matter's clients.
 *
 * `matter_client_id`, `client_id` and `billing_email` are the three fields the
 * portal's ownership rule consults, so they are set together and all point at
 * the same person. An invoice naming the matter but nobody on it would be
 * unowned and would not exercise that rule at all.
 */
export async function seedMatterInvoice(
  lawFirmId: string,
  matterId: string,
  billedTo: PortalPerson,
  options: { totalCents: number; invoiceNumber: string; stripePaymentRequested?: boolean },
): Promise<{ id: string; totalCents: number }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, matter_client_id,
                           context_type, billing_email, invoice_number, status,
                           total_cents, stripe_payment_requested, invoice_date, due_date)
     values ($1, $2, $3, $4, $4, 'matter', $5, $6, 'outstanding', $7, $8,
             current_date, current_date + 30)`,
    [id, lawFirmId, matterId, billedTo.clientId, billedTo.email, options.invoiceNumber,
      options.totalCents, options.stripePaymentRequested ?? false],
  );
  expect(res.rowCount).toBe(1);
  return { id, totalCents: options.totalCents };
}

/** A matter note. `clientVisible` is the flag the portal reads through. */
export async function seedMatterNote(
  lawFirmId: string,
  matterId: string,
  options: { subject: string; content?: string },
): Promise<{ id: string }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into notes (id, law_firm_id, matter_id, subject, content, content_html,
                               note_type, mentions)
     values ($1, $2, $3, $4, $5, $5, 'general', '[]'::jsonb)`,
    [id, lawFirmId, matterId, options.subject, options.content ?? options.subject],
  );
  expect(res.rowCount).toBe(1);
  return { id };
}

/** A matter event. Only client-visible, non-cancelled, future events reach the portal. */
export async function seedEvent(
  lawFirmId: string,
  matterId: string,
  options: { title: string; clientVisible?: boolean; daysAhead?: number },
): Promise<{ id: string }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, title, type, status,
                                date, client_visible)
     values ($1, $2, $3, $4, 'hearing', 'upcoming', now() + ($5::int * interval '1 day'), $6)`,
    [id, lawFirmId, matterId, options.title, options.daysAhead ?? 7, options.clientVisible ?? true],
  );
  expect(res.rowCount).toBe(1);
  return { id };
}

/** One row in a portal user's notification bell for one firm. */
export async function seedNotification(
  lawFirmId: string,
  userId: string,
  title: string,
  // Written as a raw string rather than a Date so a spec can express MICROseconds.
  // A JS Date cannot: it holds milliseconds, which is the precision the paging
  // cursor used to be truncated to.
  createdAt: string | null = null,
): Promise<{ id: string }> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into notifications (id, law_firm_id, user_id, type, title, body, read, created_at)
     values ($1, $2, $3, 'message', $4, $5, false, coalesce($6::timestamptz, now()))`,
    [id, lawFirmId, userId, title, `Body of ${title}`, createdAt],
  );
  expect(res.rowCount).toBe(1);
  return { id };
}

/** Whether one notification row has been marked read. */
export async function notificationRead(id: string): Promise<boolean | undefined> {
  const { rows } = await testPool.query('select read from notifications where id = $1', [id]);
  return rows[0]?.read;
}

/**
 * The direct thread between one firm and one portal user, plus one message the
 * FIRM sent into it.
 *
 * Direct threads are keyed by `(law_firm_id, client_id)` where `client_id` is
 * the portal user's Firebase uid, and they do NOT use
 * `conversation_participants` (that table is for group threads only). The
 * message is seeded firm-to-client and unread, so a spec can assert both that
 * its content never reaches another client and that its read flag never moves.
 */
export async function seedDirectConversation(
  lawFirmId: string,
  person: PortalPerson,
  options: { firmName: string; messageContent: string; senderUserId: string },
): Promise<{ conversationId: string; messageId: string; content: string }> {
  const conversationId = randomUUID();
  const messageId = randomUUID();

  const conv = await testPool.query(
    `insert into conversations (id, law_firm_id, client_id, conversation_type,
                                last_message_at, last_sender_user_id)
     values ($1, $2, $3, 'direct', now(), $4)`,
    [conversationId, lawFirmId, person.uid, options.senderUserId],
  );
  expect(conv.rowCount).toBe(1);

  const msg = await testPool.query(
    `insert into messages (id, conversation_id, law_firm_id, sender_user_id, content,
                           sender_type, sender_name, read,
                           read_by_firm, read_by_client, status)
     values ($1, $2, $3, $4, $5, 'firm_member', 'Paralegal Pat', false,
             true, false, 'sent')`,
    [messageId, conversationId, lawFirmId, options.senderUserId,
      options.messageContent],
  );
  expect(msg.rowCount).toBe(1);

  return { conversationId, messageId, content: options.messageContent };
}

/** How many messages a conversation holds, and how many the client has read. */
export async function messageStats(conversationId: string): Promise<{
  total: number;
  readByClient: number;
}> {
  const { rows } = await testPool.query(
    `select count(*)::int as total,
            count(*) filter (where read_by_client)::int as read_by_client
       from messages where conversation_id = $1`,
    [conversationId],
  );
  return { total: rows[0].total, readByClient: rows[0].read_by_client };
}

/**
 * A document request addressed to one client, with a single checklist item and
 * one file already filed against it.
 *
 * The fulfillment row is seeded because two portal routes take a fulfillment id
 * in the path (the signed-URL read and the delete), and both are cross-tenant
 * surfaces that need a real id to be asked for.
 */
export async function seedDocumentRequest(
  lawFirmId: string,
  clientId: string,
  matterId: string | null,
  options: { title: string; itemLabel: string; fileName: string; uploadedBy?: string },
): Promise<{
  requestId: string;
  itemId: string;
  fulfillmentId: string;
  fileId: string;
  objectPath: string;
}> {
  const requestId = randomUUID();
  const itemId = randomUUID();
  const fulfillmentId = randomUUID();

  const req = await testPool.query(
    `insert into document_requests (id, law_firm_id, matter_id, client_id, title, status)
     values ($1, $2, $3, $4, $5, 'open')`,
    [requestId, lawFirmId, matterId, clientId, options.title],
  );
  expect(req.rowCount).toBe(1);

  const item = await testPool.query(
    `insert into document_request_items (id, law_firm_id, request_id, label, status)
     values ($1, $2, $3, $4, 'received')`,
    [itemId, lawFirmId, requestId, options.itemLabel],
  );
  expect(item.rowCount).toBe(1);

  // A real document in the tree the request belongs to. It has to hang off a
  // scope root: a row with no parent IS a root, and a second root for one matter
  // is refused by the unique index.
  const root = matterId
    ? await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId })
    : await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'client', clientId });
  const file = await filesRepo.createFile(lawFirmId, {
    parentId: root,
    name: options.fileName,
    mimeType: 'application/pdf',
    uploadedBy: options.uploadedBy ?? null,
  });
  await filesRepo.finalize(lawFirmId, file.id, { sizeBytes: 1024, mimeType: 'application/pdf' });
  const fileId = file.id;
  const objectPath = file.objectPath;
  const fulfillment = await testPool.query(
    `insert into attachments
       (id, law_firm_id, file_id, document_request_item_id)
     values ($1, $2, $3, $4)`,
    [fulfillmentId, lawFirmId, fileId, itemId],
  );
  expect(fulfillment.rowCount).toBe(1);

  return { requestId, itemId, fulfillmentId, fileId, objectPath };
}

/** How many fulfillment rows survive against one checklist item. */
export async function fulfillmentCount(itemId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as total from attachments where document_request_item_id = $1',
    [itemId],
  );
  return rows[0].total;
}

/**
 * Every `files` row mirrored into one firm, newest first.
 *
 * Portal uploads land in GCS and are mirrored into `files`, so this is how a
 * spec proves that a refused upload wrote NOTHING rather than merely answering
 * an error after the fact.
 */
export async function firmFileRows(lawFirmId: string): Promise<Array<{
  objectPath: string;
  name: string;
  matterId: string | null;
}>> {
  const { rows } = await testPool.query(
    `select object_path, name, matter_id from files where law_firm_id = $1 order by created_at`,
    [lawFirmId],
  );
  return rows.map((r: any) => ({ objectPath: r.object_path, name: r.name, matterId: r.matter_id }));
}
