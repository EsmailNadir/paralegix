/**
 * Regression tests for the six organization bugs fixed in be459ec0.
 *
 * These are the only tests in this phase written strictly test-first, and the
 * proof they work is not that they pass. It is that they FAIL on the commit
 * before the fix:
 *
 *   git stash
 *   git checkout be459ec0~1 -- backend/src
 *   npx jest tests/organizations/regressions.test.ts     # expect failures
 *   git checkout HEAD -- backend/src
 *   npx jest tests/organizations/regressions.test.ts     # expect green
 *
 * A test that passes on the parent commit does not cover the bug and has to be
 * rewritten. Each case below records which mutation reproduces its bug, so the
 * claim is checkable without the git dance.
 *
 * ---------------------------------------------------------------------------
 * TWO BUGS WERE FOUND BY THIS FILE AND ARE NOW FIXED. Kept here because the
 * reproduction is the regression test, and because the reasoning behind the
 * remedy is not obvious from the diff.
 *
 * BUG-1: mergePlaceholder could not merge a client that had trust money.
 *   `mergePlaceholder` repoints trust history with
 *     scopedUpdate(trustTransactions, ..., { clientId: targetId })
 *   (clientIdentityLinking.service.ts:354). The `trust_txn_immutable` trigger
 *   freezes every field of a COMPLETED entry except the bank-clearing stamps,
 *   precisely so attribution stays tamper-evident, and raises
 *     "trust_transactions are append-only: post a reversing entry instead of editing"
 *   The exception aborts the whole enclosing transaction, so the merge fails and
 *   its caller fails with it. `linkClientIdentityToFirm` is reached from client
 *   invitation acceptance (auth.service.ts:277) and from three portal paths.
 *
 *   be459ec0 set out to stop a FOREIGN-KEY violation on this table aborting the
 *   caller. It replaced it with a TRIGGER violation that aborted the caller in
 *   the same way.
 *
 *   FIXED by migration 0183: the trigger now honours a client-id remap that the
 *   caller DECLARES for one specific pair, transaction-locally. A merge is not a
 *   reattribution: the two rows are the same person by construction, so the money
 *   did not move between people, only the record it hangs off did. Amount, date,
 *   account, type and every other column stay frozen, so the control the trigger
 *   exists to enforce is intact.
 *
 * BUG-2: merging the primary contact of an organization failed on statement order.
 *   `moveCompanyLinks` sets `isPrimary: existing.isPrimary || link.isPrimary` on
 *   the SURVIVING link (line 82) and only deletes the placeholder's links
 *   afterwards (line 89). Between those two statements both rows carry
 *   `is_primary = true`, and the partial unique index
 *     client_company_links_one_primary_idx
 *       ON (law_firm_id, company_client_id) WHERE is_primary
 *   rejects the update with a duplicate-key error.
 *
 *   So a merge succeeded only when the placeholder was NOT the organization's
 *   primary contact.
 *
 *   FIXED in `moveCompanyLinks`: the placeholder's `is_primary` is cleared before
 *   the survivor's is set. The comment on `moveRelatedContacts` shows the author
 *   had the same index in mind for contacts, so this was an oversight rather than
 *   a deliberate difference.
 * ---------------------------------------------------------------------------
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  createInvoice,
  createTrustDeposit,
  linkPersonToOrg,
  ownerOf,
  recipientsOf,
} from '../support/setupInProcess';

const identityLinking = () => require('../../src/modules/clients/clientIdentityLinking.service');

describe('R4: mergePlaceholder repoints every reference instead of cascading', () => {
  /**
   * The bug: the merge repointed only `matter_clients` and
   * `invoices.client_context_id` before hard-deleting the placeholder row.
   * Everything else cascaded away with it: organization memberships, time
   * entries, flat fees, expenses, billing plans, trust minimums, notes, events,
   * task links and document requests, with `invoices.client_id` nulled and a
   * foreign-key violation on `trust_transactions` aborting the caller's whole
   * transaction.
   *
   * The merge fires on ordinary portal sign-in through
   * `selfHealPersonAssociation`, so this ran against real client data, not only
   * on invite acceptance.
   */
  async function buildMergeCase() {
    const firm = await createFirm();
    const email = `merge-${randomUUID().slice(0, 8)}@example.test`;

    // The target: already claimed by a portal identity.
    const portal = await createPortalUser();
    const target = await createPersonClient(firm.id, { userId: portal.uid, email });

    // The placeholder: same email, never claimed, and carrying real work. This
    // is what a roster-add creates, and it collects history for as long as it
    // takes anyone to invite that person.
    const placeholder = await createPersonClient(firm.id, { email, name: 'Placeholder Person' });

    const org = await createOrgClient(firm.id, { name: 'Merge Corp' });
    await linkPersonToOrg(firm.id, placeholder.id, org.id, {
      canViewBilling: true,
      isPrimary: true,
    });

    const invoice = await createInvoice(firm.id, placeholder.id, { totalCents: 555_500 });
    const trust = await createTrustDeposit(firm.id, placeholder.id, { amountCents: 333_300 });

    const timeEntryId = randomUUID();
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, activity_date, description)
       values ('time', $1, $2, $3, current_date, 'Merge fixture')`,
      [timeEntryId, firm.id, placeholder.id],
    );

    const noteId = randomUUID();
    await testPool.query(
      `insert into notes (id, law_firm_id, client_id, content)
       values ($1, $2, $3, 'Merge fixture note')`,
      [noteId, firm.id, placeholder.id],
    );

    const eventId = randomUUID();
    await testPool.query(
      `insert into events (id, law_firm_id, client_id, title)
       values ($1, $2, $3, 'Merge fixture event')`,
      [eventId, firm.id, placeholder.id],
    );

    const minimumId = randomUUID();
    await testPool.query(
      `insert into trust_minimum_balances (id, law_firm_id, client_id, trust_account_id, minimum_cents)
       values ($1, $2, $3, $4, 100000)`,
      [minimumId, firm.id, placeholder.id, trust.accountId],
    );

    return {
      firm, email, portal, target, placeholder, org,
      invoice, trust, timeEntryId, noteId, eventId, minimumId,
    };
  }

  it('completes without a foreign-key violation and removes the placeholder', async () => {
    const c = await buildMergeCase();

    // On the parent commit this threw, because trust_transactions still pointed
    // at a row the merge was hard-deleting, and the violation aborted the whole
    // caller transaction rather than just the merge.
    await identityLinking().linkClientIdentityToFirm({
      lawFirmId: c.firm.id,
      userId: c.portal.uid,
      email: c.email,
    });
    await drainEvents();

    const { rows } = await testPool.query('select id from clients where id = $1', [c.placeholder.id]);
    expect(rows).toHaveLength(0);
  });

  it('repoints every reference at the surviving record, deleting none of them', async () => {
    const c = await buildMergeCase();

    await identityLinking().linkClientIdentityToFirm({
      lawFirmId: c.firm.id,
      userId: c.portal.uid,
      email: c.email,
    });
    await drainEvents();

    // Each row must still EXIST and must now point at the target. Asserting only
    // "points at the target" would pass against code that deleted it, since a
    // deleted row trivially satisfies "no row points at the placeholder".
    const survives = async (table: string, id: string, column = 'client_id') => {
      const { rows } = await testPool.query(
        `select ${column} as owner from ${table} where id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      return rows[0].owner;
    };

    expect(await survives('activities', c.timeEntryId)).toBe(c.target.id);
    expect(await survives('notes', c.noteId)).toBe(c.target.id);
    expect(await survives('events', c.eventId)).toBe(c.target.id);
    expect(await survives('trust_transactions', c.trust.transactionId)).toBe(c.target.id);
    expect(await survives('invoices', c.invoice.id)).toBe(c.target.id);

    // `trust_minimum_balances` is asserted by VALUE rather than by id. Its
    // uniqueness key includes client_id, so the merge copies the row to the
    // target and drops the original instead of repointing it in place. Asserting
    // the original id survived would fail against a correct implementation.
    const { rows: minimums } = await testPool.query(
      `select client_id, trust_account_id, minimum_cents
         from trust_minimum_balances where law_firm_id = $1`,
      [c.firm.id],
    );
    expect(minimums).toHaveLength(1);
    expect(minimums[0]).toMatchObject({
      client_id: c.target.id,
      trust_account_id: c.trust.accountId,
      minimum_cents: '100000',
    });
  });

  it('moves the organization membership rather than dropping it', async () => {
    const c = await buildMergeCase();

    await identityLinking().linkClientIdentityToFirm({
      lawFirmId: c.firm.id,
      userId: c.portal.uid,
      email: c.email,
    });
    await drainEvents();

    const { rows } = await testPool.query(
      `select person_client_id, can_view_billing, is_primary
         from client_company_links where company_client_id = $1`,
      [c.org.id],
    );
    // The person keeps their seat on the organization, with the flags intact.
    // Losing this silently removes someone from a company roster on sign-in.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_client_id: c.target.id,
      can_view_billing: true,
      is_primary: true,
    });
  });

  // Builds its OWN world with NO trust money, deliberately. Sharing
  // buildMergeCase() made this unfalsifiable while BUG-1 was open: that bug
  // aborted the merge before moveCompanyLinks was reached, so the case stayed
  // red regardless of the primary-contact ordering and a correct fix showed no
  // change. Two bugs need two independent reproductions.
  it('merges link flags rather than aborting when both records are on the same roster', async () => {
    const firm = await createFirm();
    const email = `primary-${randomUUID().slice(0, 8)}@example.test`;
    const portal = await createPortalUser();
    const target = await createPersonClient(firm.id, { userId: portal.uid, email });
    const placeholder = await createPersonClient(firm.id, { email });
    const org = await createOrgClient(firm.id, { name: 'Primary Corp' });

    // The placeholder is the organization's PRIMARY contact and the survivor is
    // also on the roster, which is what puts two `is_primary` rows in flight.
    await linkPersonToOrg(firm.id, placeholder.id, org.id, {
      canViewBilling: true,
      isPrimary: true,
    });
    await linkPersonToOrg(firm.id, target.id, org.id, { canViewBilling: false });

    await identityLinking().linkClientIdentityToFirm({
      lawFirmId: firm.id,
      userId: portal.uid,
      email,
    });
    await drainEvents();

    const { rows } = await testPool.query(
      `select person_client_id, can_view_billing, is_primary
         from client_company_links where company_client_id = $1`,
      [org.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].person_client_id).toBe(target.id);
    // The more permissive flags survive: the person genuinely held billing
    // access and the primary seat through one of the two records.
    expect(rows[0].can_view_billing).toBe(true);
    expect(rows[0].is_primary).toBe(true);
  });

  it('refuses to merge an organization into a person', async () => {
    const firm = await createFirm();
    const email = `shared-${randomUUID().slice(0, 8)}@example.test`;
    const portal = await createPortalUser();
    await createPersonClient(firm.id, { userId: portal.uid, email });
    // A company using the same address as its contact email. Without the
    // client_type guard, signing in with that address folds the company's
    // matters and invoices into the person and hard-deletes the company.
    const org = await createOrgClient(firm.id, { name: 'Not A Placeholder', email });

    await identityLinking().linkClientIdentityToFirm({
      lawFirmId: firm.id,
      userId: portal.uid,
      email,
    });
    await drainEvents();

    const { rows } = await testPool.query(
      'select client_type from clients where id = $1',
      [org.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_type).toBe('company');
  });
});

describe('R2: the invoice-issued notification reaches an organization\'s people', () => {
  /**
   * The bug: the handler read `clientRecord.userId` to find who to tell. A
   * company can NEVER carry that column (`clients_company_no_user_id_check`), so
   * it resolved to null for every organization invoice and the notification was
   * silently skipped. The people who could actually see the invoice were the one
   * client-facing audience never told it existed.
   *
   * Reproduce the bug by making the handler read `clientRecord?.userId`
   * unconditionally in invoiceReminders.service.ts around line 511.
   */
  async function issueInvoiceToOrg() {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id, { name: 'Notified Corp', email: 'ap@notified.test' });

    const withBilling = await createPortalUser();
    const withBillingClient = await createPersonClient(firm.id, {
      userId: withBilling.uid, email: 'sees@notified.test',
    });
    await linkPersonToOrg(firm.id, withBillingClient.id, org.id, { canViewBilling: true });

    const withoutBilling = await createPortalUser();
    const withoutBillingClient = await createPersonClient(firm.id, {
      userId: withoutBilling.uid, email: 'blind@notified.test',
    });
    await linkPersonToOrg(firm.id, withoutBillingClient.id, org.id, { canViewBilling: false });

    const invoice = await createInvoice(firm.id, org.id, { totalCents: 918_400 });

    await require('../../src/modules/billing/invoices/invoiceReminders.service')
      .sendInvoiceToEmail({
        lawFirmId: firm.id,
        invoiceId: invoice.id,
        clientId: org.id,
        actingUserId: (await ownerOf(firm.id)).uid,
        recipientEmail: 'ap@notified.test',
        recipientName: 'Accounts Payable',
      });
    await drainEvents();

    const { rows } = await testPool.query(
      `select user_id, type, action_url from notifications
        where law_firm_id = $1 and type = 'invoice_issued'`,
      [firm.id],
    );
    return { firm, org, invoice, withBilling, withoutBilling, notifications: rows };
  }

  it('notifies the roster members who may see the money', async () => {
    const c = await issueInvoiceToOrg();

    const notified = c.notifications.map((row: any) => row.user_id);
    expect(notified).toContain(c.withBilling.uid);
  });

  it('does not notify a roster member without can_view_billing', async () => {
    const c = await issueInvoiceToOrg();

    // The notification links to a billing route that refuses anyone without the
    // flag, so telling them would be an announcement they cannot act on and a
    // disclosure that an invoice of some amount exists.
    const notified = c.notifications.map((row: any) => row.user_id);
    expect(notified).not.toContain(c.withoutBilling.uid);
  });

  it('carries clientRecordId so the link lands on the right record', async () => {
    const c = await issueInvoiceToOrg();

    // A reader holding several associations would otherwise land on the portal's
    // CLIENT_SELECTION_REQUIRED state instead of the invoice.
    const forBilling = c.notifications.find((row: any) => row.user_id === c.withBilling.uid);
    expect(forBilling?.action_url).toContain(`clientRecordId=${c.org.id}`);
  });
});

describe('R5: the conflict check matches an organization', () => {
  /**
   * The bug: the check built its organization search set from
   * `clients.organization`, a column that describes a PERSON's employer. An
   * organization client keeps its legal name in `name` and leaves `organization`
   * null, so the set was empty for a matter opened FOR an organization, and the
   * two clauses in `findConflicts` that answer "who else is this organization"
   * (match a company by name, match the people linked to it) could never fire.
   *
   * Reproduce by changing the mapping in matters.service.ts back to
   * `.map((c) => c.organization)`.
   */
  async function conflictWorld() {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id, { name: 'Wayne Enterprises' });

    // Someone the firm already acts for, employed by that organization. This is
    // the person a conflict check for the organization must surface.
    const employee = await createPersonClient(firm.id, {
      name: 'Lucius Fox', email: 'lucius@wayne.test',
    });
    await testPool.query('update clients set organization = $2 where id = $1',
      [employee.id, 'Wayne Enterprises']);

    // And someone on the organization's roster.
    const rosterPerson = await createPersonClient(firm.id, { name: 'Alfred Pennyworth' });
    await linkPersonToOrg(firm.id, rosterPerson.id, org.id, { canViewBilling: false });

    return { firm, org, employee, rosterPerson };
  }

  it('finds the people at an organization when checking that organization by name', async () => {
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);

    // Exactly what recordConflictCheckForMatter now feeds in for a company
    // client: its own `name`, as an organization.
    const res = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters/conflict-check`)
      .send({ organizations: ['Wayne Enterprises'] });

    expect(res.status).toBe(200);
    const found = JSON.stringify(res.body);
    expect(found).toContain(c.employee.id);
  });

  it('surfaces the organization record itself, not only its people', async () => {
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);

    const res = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters/conflict-check`)
      .send({ organizations: ['Wayne Enterprises'] });

    expect(JSON.stringify(res.body)).toContain(c.org.id);
  });

  it('surfaces a person linked to the organization when the organization is new to the matter', async () => {
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);

    const res = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters/conflict-check`)
      .send({ organizations: ['Wayne Enterprises'] });

    expect(res.status).toBe(200);
    const roster = res.body.conflicts.filter((x: any) => x.clientId === c.rosterPerson.id);
    expect(roster.map((x: any) => x.matchValue)).toEqual(['Wayne Enterprises']);
  });

  it('does not report the selected organization\'s own linked people as conflicts', async () => {
    /**
     * Selecting an existing organization client excludes that client, but the
     * people linked to it through `client_company_links` were still reported,
     * one line per person per matter: the organization's own General Counsel
     * and CFO flagged as possible conflicts with the organization they work
     * for. Reproduce by removing the excluded-company filter from the
     * linked-company clauses in `findConflicts`.
     */
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);

    const res = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters/conflict-check`)
      .send({ names: ['Wayne Enterprises'], organizations: ['Wayne Enterprises'], excludeClientIds: [c.org.id] });

    expect(res.status).toBe(200);
    // The check still ran: the unlinked employee whose stated employer is the
    // organization is someone the firm cannot tell is affiliated, so it stays.
    expect(res.body.conflicts.some((x: any) => x.clientId === c.employee.id)).toBe(true);
    expect(res.body.conflicts.some((x: any) => x.clientId === c.rosterPerson.id)).toBe(false);
    expect(res.body.conflicts.some((x: any) => x.clientId === c.org.id)).toBe(false);
  });

  it('reports an organization matched by both name and organization once, not twice', async () => {
    /**
     * The create-matter check sends an organization's name as a NAME and as an
     * ORGANIZATION, so a company record of that name matched both clauses and
     * produced two lines saying the same thing for every matter it is on.
     * Reproduce by dropping the `repeatsName` guard in `findConflicts`.
     */
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);

    const res = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters/conflict-check`)
      .send({ names: ['Wayne Enterprises'], organizations: ['Wayne Enterprises'] });

    expect(res.status).toBe(200);
    const forOrg = res.body.conflicts.filter((x: any) => x.clientId === c.org.id);
    expect(forOrg.map((x: any) => x.matchType)).toEqual(['name']);
  });

  it('matches an organization search against a company in the contact directory', async () => {
    /**
     * A company contact (an opposing party, an insurer) keeps its name in
     * `name` and leaves `organization` null, the same shape that once hid
     * organization clients from this search. Checking a person who works for
     * that company must still say the firm already knows it. Reproduce by
     * removing the company-name clause from the contacts arm.
     */
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);
    const { rows: [contact] } = await testPool.query(
      `insert into contacts (law_firm_id, name, category, contact_type)
       values ($1, 'Falcone Holdings', 'opposing_party', 'company') returning id`,
      [c.firm.id],
    );

    const res = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters/conflict-check`)
      .send({ names: ['Sal Maroni'], organizations: ['Falcone Holdings'] });

    expect(res.status).toBe(200);
    const hits = res.body.conflicts.filter((x: any) => x.contactId === contact.id);
    expect(hits.map((x: any) => [x.matchType, x.matchValue])).toEqual([['organization', 'Falcone Holdings']]);
  });

  it('feeds a company client name into the organization set when a matter is opened for it', async () => {
    const c = await conflictWorld();
    const owner = await ownerOf(c.firm.id);

    // The end-to-end path: open a matter FOR the organization and read back the
    // recorded check. On the parent commit the organization set was empty here,
    // so the check ran and recorded nothing about the organization at all.
    // `clients`, an array of objects, not `clientIds`. A bare `clientIds` is
    // accepted and silently ignored, so the matter is created with no clients
    // attached and the conflict check has nothing to run against.
    const matter = await owner.api
      .post(`/api/lawfirms/${c.firm.id}/matters`)
      .send({
        name: 'Wayne v. Falcone',
        clients: [{ clientId: c.org.id, name: 'Wayne Enterprises' }],
      });
    expect([200, 201]).toContain(matter.status);
    await drainEvents();

    // The recorded columns are singular text (`query_organization`), not the
    // plural arrays the service passes in; the service joins them for the record.
    const { rows } = await testPool.query(
      'select query_organization, query_name, result_count from conflict_check_records where law_firm_id = $1',
      [c.firm.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    // On the parent commit the organization set was empty for a matter opened
    // FOR an organization, so this column held nothing.
    expect(rows[0].query_organization).toContain('Wayne Enterprises');
  });
});

describe('R3: reminder recipients treat the draft-time address as a last resort', () => {
  /**
   * Two bugs in one function, both fixed in be459ec0.
   *
   * `invoice.clientEmail` is the address frozen onto the invoice when it was
   * drafted. It was APPENDED to the resolved recipients unconditionally, so
   * reminders reached addresses the send and payment-request paths deliberately
   * exclude. For an organization that matters more than it sounds: an explicit
   * `billingEmail` override exists precisely so a firm can aim one bill at one
   * person, and adding the organization's general address back on undoes it.
   *
   * The second bug was the cache key. The resolve is determined by
   * (firm, client, override), but the finished list also carried `clientEmail`,
   * which varies per invoice, so the second invoice for a client was handed the
   * first one's address.
   *
   * Reproduce by appending `invoice.clientEmail` to the returned list instead of
   * using it only when the resolve came back empty.
   */
  const remindersModule = () => require('../../src/modules/billing/invoices/invoiceReminders.service');

  // `DISABLE_ALL_REMINDER_EMAILS` is set in backend/.env, which the harness loads
  // so that RBAC_ENFORCED and friends are read correctly. It makes
  // sendReminderForInvoice return `{ sent: false, reason: 'Reminders are
  // disabled' }` before it resolves a single recipient, so without this the two
  // cases below assert against an empty outbox and pass for the wrong reason.
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.DISABLE_ALL_REMINDER_EMAILS;
    process.env.DISABLE_ALL_REMINDER_EMAILS = '';
  });
  afterEach(() => {
    process.env.DISABLE_ALL_REMINDER_EMAILS = previous;
  });

  async function orgWithBillingContact() {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id, {
      name: 'Reminder Corp', email: 'general@reminder.test',
    });
    const contact = await createPortalUser();
    const contactClient = await createPersonClient(firm.id, {
      userId: contact.uid, email: 'ap.lead@reminder.test',
    });
    await linkPersonToOrg(firm.id, contactClient.id, org.id, {
      canViewBilling: true, isEmailRecipient: true, isPrimary: true,
    });
    return { firm, org, contactClient };
  }

  it('does not append the draft-time address when the roster resolves', async () => {
    const w = await orgWithBillingContact();
    const invoice = await createInvoice(w.firm.id, w.org.id, { totalCents: 120_000 });
    // The address frozen onto the invoice at draft time, deliberately different
    // from the roster's, so its presence in the outbox is unambiguous.
    await testPool.query('update invoices set client_email = $2 where id = $1',
      [invoice.id, 'stale-draft@reminder.test']);

    await remindersModule().sendReminderForInvoice({
      lawFirmId: w.firm.id, invoiceId: invoice.id, clientId: w.org.id,
      actingUserId: (await ownerOf(w.firm.id)).uid,
    });
    await drainEvents();

    const to = recipientsOf(/./);
    expect(to.length).toBeGreaterThan(0);
    expect(to).not.toContain('stale-draft@reminder.test');
  });

  it('falls back to the draft-time address when the roster resolves to nobody', async () => {
    const firm = await createFirm();
    // An organization with an empty roster and no billing override. Nothing to
    // resolve, which is the one case the frozen address still has a job to do.
    const org = await createOrgClient(firm.id, { name: 'Empty Roster Corp' });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 90_000 });
    await testPool.query('update invoices set client_email = $2 where id = $1',
      [invoice.id, 'last-resort@empty.test']);

    await remindersModule().sendReminderForInvoice({
      lawFirmId: firm.id, invoiceId: invoice.id, clientId: org.id,
      actingUserId: (await ownerOf(firm.id)).uid,
    });
    await drainEvents();

    const to = recipientsOf(/./);
    expect(to).toContain('last-resort@empty.test');
  });
});
