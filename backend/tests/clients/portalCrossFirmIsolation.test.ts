/**
 * Every `/lawfirm/:lawFirmId/...` portal route, asked for a firm the caller has
 * no association with.
 *
 * A portal client names the firm they want in the URL. Nothing else in the
 * request identifies the tenant: no subdomain, no session-bound firm, no header.
 * So the ONLY thing standing between a signed-in client of one firm and another
 * firm's invoices, trust ledger, matter notes, court dates, messages and client
 * uploads is the association check each handler performs on that path parameter.
 * There are twenty-five such routes and, before this file, one of them (the
 * organization battery's `tenancy` cell in `tests/organizations/surfaces.ts`)
 * covered twelve of the reads and none of the writes.
 *
 * WHY THE ASSERTIONS LOOK THE WAY THEY DO. A refusal is easy to fake and easy to
 * mis-test. Two rules apply to every case below:
 *
 *   1. The away firm is seeded with the exact data the route returns, and the
 *      away firm's OWN client fetches it in the same test. An empty result from
 *      the home client therefore means the route withheld something that was
 *      demonstrably there, not that the world was empty.
 *   2. The assertion is on CONTENT, not only status. Each away fixture carries a
 *      marker string that exists nowhere else in the world, and the home
 *      client's response must not contain it. A list endpoint refuses by
 *      returning nothing, and a status-only assertion would call an empty 200
 *      leak-free without ever looking at the body.
 *
 * Writes get a third rule: the away firm's rows are read back out of Postgres
 * afterwards, because "the request was refused" and "nothing was written" are
 * different claims and only the second one matters.
 *
 * THE CAST:
 *
 *   `away`  Vale LLP, fully furnished: a client, a matter, an invoice, a trust
 *           deposit, a shared note, a hearing, a notification, a direct message
 *           thread and a document request with a file against it.
 *   `home`  Hale & Co, whose client is the caller under test. A legitimate
 *           portal login in good standing, which is what makes this the tenancy
 *           boundary rather than an authentication failure.
 */
import {
  createFirm,
  createTrustDeposit,
  ownerOf,
  testPool,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  bodyText,
  fulfillmentCount,
  firmFileRows,
  messageStats,
  notificationRead,
  portalPath,
  portalPerson,
  seedClientInvoice,
  seedDirectConversation,
  seedDocumentRequest,
  seedEvent,
  seedMatter,
  seedMatterNote,
  seedNotification,
  type PortalPerson,
} from './portalWorld';
import { portalUpload } from '../support/portalUpload';

/** Everything Vale LLP holds, and the marker that proves each piece surfaced. */
interface AwayWorld {
  firm: Firm;
  owner: Actor;
  client: PortalPerson;
  matterId: string;
  matterName: string;
  invoice: { id: string; invoiceNumber: string; totalCents: number };
  trust: { accountId: string; amountCents: number; accountName: string };
  noteSubject: string;
  eventTitle: string;
  notificationId: string;
  notificationTitle: string;
  conversationId: string;
  messageId: string;
  messageContent: string;
  request: {
    requestId: string;
    itemId: string;
    fulfillmentId: string;
    fileId: string;
    objectPath: string;
  };
  requestTitle: string;
}

let away: AwayWorld;
let home: { firm: Firm; client: PortalPerson; conversationId: string };

/**
 * Markers. Every one is a string that appears in exactly one fixture across both
 * firms, so `not.toContain` on it is a claim that can actually fail. The trust
 * ledger is the exception: its rows carry no free-text the fixture controls, so
 * its marker is the cents figure, which is likewise unique in this world.
 */
const AWAY_MATTER = 'Vale Discovery Matter';
const AWAY_INVOICE_NUMBER = 'INV-VALE-ONLY-1';
const AWAY_INVOICE_CENTS = 813_400;
const AWAY_TRUST_ACCOUNT = 'Vale IOLTA Account';
const AWAY_TRUST_CENTS = 927_500;
const AWAY_NOTE = 'Vale filing memorandum';
const AWAY_EVENT = 'Vale suppression hearing';
const AWAY_NOTIFICATION = 'Vale invoice is ready to view';
const AWAY_MESSAGE = 'Vale settlement figures attached';
const AWAY_REQUEST = 'Vale intake checklist';
const AWAY_REQUEST_FILE = 'vale-passport-scan.pdf';

beforeEach(async () => {
  const awayFirm = await createFirm({ name: 'Vale LLP' });
  const awayOwner = await ownerOf(awayFirm.id);
  const awayClient = await portalPerson(awayFirm.id, 'Ada Away');
  const matterId = await seedMatter(awayFirm.id, AWAY_MATTER, [awayClient.clientId]);

  const invoice = await seedClientInvoice(awayFirm.id, awayClient.clientId, {
    totalCents: AWAY_INVOICE_CENTS,
    invoiceNumber: AWAY_INVOICE_NUMBER,
  });
  const trust = await createTrustDeposit(awayFirm.id, awayClient.clientId, {
    amountCents: AWAY_TRUST_CENTS,
    accountName: AWAY_TRUST_ACCOUNT,
  });
  await seedMatterNote(awayFirm.id, matterId, { subject: AWAY_NOTE });
  await seedEvent(awayFirm.id, matterId, { title: AWAY_EVENT });
  const notification = await seedNotification(awayFirm.id, awayClient.uid, AWAY_NOTIFICATION);
  const conversation = await seedDirectConversation(awayFirm.id, awayClient, {
    firmName: 'Vale LLP',
    messageContent: AWAY_MESSAGE,
    senderUserId: awayOwner.uid,
  });
  const request = await seedDocumentRequest(awayFirm.id, awayClient.clientId, matterId, {
    title: AWAY_REQUEST,
    itemLabel: 'Vale identity document',
    fileName: AWAY_REQUEST_FILE,
    uploadedBy: awayClient.uid,
  });

  away = {
    firm: awayFirm,
    owner: awayOwner,
    client: awayClient,
    matterId,
    matterName: AWAY_MATTER,
    invoice,
    trust: { ...trust, accountName: AWAY_TRUST_ACCOUNT },
    noteSubject: AWAY_NOTE,
    eventTitle: AWAY_EVENT,
    notificationId: notification.id,
    notificationTitle: AWAY_NOTIFICATION,
    conversationId: conversation.conversationId,
    messageId: conversation.messageId,
    messageContent: conversation.content,
    request,
    requestTitle: AWAY_REQUEST,
  };

  const homeFirm = await createFirm({ name: 'Hale & Co' });
  await ownerOf(homeFirm.id);
  const homeClient = await portalPerson(homeFirm.id, 'Hank Home');
  const homeConversation = await seedDirectConversation(homeFirm.id, homeClient, {
    firmName: 'Hale & Co', messageContent: 'Home-only message', senderUserId: homeClient.uid,
  });
  home = { firm: homeFirm, client: homeClient, conversationId: homeConversation.conversationId };

  await drainEvents();
});

/* ------------------------------------------------------------------ */
/*  The reads, one row per route                                       */
/* ------------------------------------------------------------------ */

interface CrossFirmRead {
  name: string;
  /** The path suffix under /api/client-portal/lawfirm/:lawFirmId/ */
  suffix: () => string;
  /** A string that appears in the away client's own response and nowhere else. */
  marker: () => string;
  /**
   * The status the outsider gets. 403 unless stated: almost every handler
   * resolves an access context against the path's firm and throws when the
   * caller has no association with it. `/associations` is the exception and is
   * marked as such rather than being quietly excused by a loose matcher.
   */
  refusalStatus?: number;
}

const READS: CrossFirmRead[] = [
  {
    name: 'associations',
    suffix: () => 'associations',
    marker: () => away.client.name,
    // A pure listing of the records this uid may act as. An outsider has none,
    // so it answers 200 with an empty list rather than refusing. That is why
    // this whole table asserts on CONTENT: three of these routes would pass a
    // status-only check while handing over the firm's data.
    refusalStatus: 200,
  },
  {
    name: 'the matter list',
    suffix: () => 'matters',
    marker: () => away.matterName,
  },
  {
    name: 'one matter by id',
    suffix: () => `matters/${away.matterId}`,
    marker: () => away.matterName,
  },
  {
    // The portal's invoice serializer does not carry `invoice_number`, so the
    // marker is the invoice's uuid, which is likewise unique to this firm.
    name: 'the billing list',
    suffix: () => 'billing',
    marker: () => away.invoice.id,
  },
  {
    name: 'one invoice by id',
    suffix: () => `invoices/${away.invoice.id}`,
    // The invoice id is in the URL, so it cannot serve as the marker here: a
    // refusal that echoed the requested id would look like a leak. The figure
    // is the disclosure that matters anyway, in the DOLLARS the portal
    // serializes from `total_cents`.
    marker: () => String(away.invoice.totalCents / 100),
  },
  {
    name: 'the document requests',
    suffix: () => 'document-requests',
    marker: () => away.requestTitle,
  },
  {
    name: 'the conversation list',
    suffix: () => 'messages/conversations',
    marker: () => away.messageContent,
  },
  {
    name: 'the message thread',
    suffix: () => 'messages',
    marker: () => away.messageContent,
  },
  {
    name: 'the agenda',
    suffix: () => 'events',
    marker: () => away.eventTitle,
  },
  {
    name: 'one matter agenda',
    suffix: () => `events?matterId=${away.matterId}`,
    marker: () => away.eventTitle,
  },
  {
    name: 'the trust balance',
    suffix: () => 'trust/balance',
    marker: () => AWAY_TRUST_ACCOUNT,
  },
  {
    name: 'the trust ledger',
    // The ledger rows carry no fixture-controlled text, so the marker is the
    // deposit's cents figure, which is unique across both firms in this world.
    suffix: () => 'trust/ledger',
    marker: () => String(away.trust.amountCents),
  },
  {
    name: 'the notification bell',
    suffix: () => 'notifications',
    marker: () => away.notificationTitle,
  },
  {
    name: 'the dashboard',
    suffix: () => 'dashboard',
    marker: () => away.matterName,
  },
];

describe.each(READS)('a client of another firm reading $name', (route) => {
  it('is served to the away firm own client', async () => {
    // The reachability half. Without it the refusal below proves nothing: an
    // endpoint that is broken for everyone, or a fixture that never landed,
    // produces the same empty body as a correct refusal.
    const res = await away.client.api.get(portalPath(away.firm.id, route.suffix()));

    expect(res.status).toBe(200);
    expect(bodyText(res)).toContain(route.marker());
  });

  it('is refused to a client of a different firm, with none of the data in the body', async () => {
    const res = await home.client.api.get(portalPath(away.firm.id, route.suffix()));

    // The content assertion is the one that carries the weight. The status is
    // pinned alongside it so a route that silently starts answering 200 with an
    // empty body, instead of refusing, is noticed rather than absorbed.
    expect(bodyText(res)).not.toContain(route.marker());
    expect(res.status).toBe(route.refusalStatus ?? 403);
  });
});

/**
 * Two reads whose bodies cannot carry a marker in this harness, kept separate so
 * the status-only assertion is a stated exemption rather than a weak case hiding
 * in the table above.
 */
describe('the reads that cannot be asserted on content', () => {
  it('refuses the document feed, which returns an empty list rather than firm data here', async () => {
    // Document listings are GCS scans, and GCS is inert in the in-process suite,
    // so the away client's own 200 is legitimately empty. What this still pins
    // is that the home client never reaches the scan at all: the refusal happens
    // in the access context, before any object path is resolved.
    const mine = await away.client.api.get(portalPath(away.firm.id, 'documents'));
    const theirs = await home.client.api.get(portalPath(away.firm.id, 'documents'));

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(403);
  });

  it('refuses one matter document listing', async () => {
    const suffix = `matters/${away.matterId}/documents`;
    const mine = await away.client.api.get(portalPath(away.firm.id, suffix));
    const theirs = await home.client.api.get(portalPath(away.firm.id, suffix));

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(403);
  });

  it('refuses the portal settings, which describe the caller and not the firm', async () => {
    // Settings are the signed-in person's own preferences, so there is no away
    // data for a marker to be made of. The 403 is still the whole point: the
    // route resolves an access context against the path's firm and writes back
    // through it, so reaching it at all is the precondition for the write case
    // further down.
    const mine = await away.client.api.get(portalPath(away.firm.id, 'settings'));
    const theirs = await home.client.api.get(portalPath(away.firm.id, 'settings'));

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/*  The pay link                                                       */
/* ------------------------------------------------------------------ */

describe('the invoice pay link', () => {
  it('resolves the invoice for the client it is billed to', async () => {
    const res = await away.client.api.get(
      portalPath(away.firm.id, `billing/pay/${away.invoice.id}`),
    );

    // 400, not 200, and that is the assertion. The fixture invoice has no
    // payment requested on it, so a caller who OWNS it gets that far and is
    // turned back by the payment provider's own precondition. Reaching a
    // provider-level refusal is proof the ownership resolution succeeded, which
    // is what makes the 404 below meaningful.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Payment has not been requested');
  });

  it('does not resolve for a client of another firm', async () => {
    const res = await home.client.api.get(
      portalPath(away.firm.id, `billing/pay/${away.invoice.id}`),
    );

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(away.invoice.invoiceNumber);
  });
});

describe('the card form', () => {
  /**
   * The away invoice made payable by card form: payment requested, the client
   * pays the card fee, and Vale LLP may pass it on. Stripe's two reads are
   * spied on so a refusal is proven to stop before Stripe is asked anything.
   */
  async function makeAwayCardPayable() {
    await testPool.query(
      `update law_firms
          set stripe_account_id = 'acct_vale', stripe_charges_enabled = true, direct_charges_enabled = true, state = 'TX',
              settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', $2::jsonb, true)
        where id = $1`,
      [away.firm.id, JSON.stringify({ cardFees: { confirmation: {
        stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-08-01T12:00:00.000Z',
      } } })],
    );
    await testPool.query(
      'update invoices set stripe_payment_requested = true, is_card_fee_passed_on = true where id = $1', [away.invoice.id]);
    const stripe = require('../../src/modules/stripe/stripe.config');
    return {
      retrieveToken: jest.spyOn(stripe.confirmationTokens, 'retrieve').mockResolvedValue({
        id: 'ctoken_vale', payment_method_preview: { type: 'card', card: { brand: 'visa', last4: '4242', funding: 'credit', country: 'US' } },
      } as any),
      retrieveIntent: jest.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValue({
        id: 'pi_vale', status: 'succeeded', amount_received: AWAY_INVOICE_CENTS, created: 1_790_000_000,
        metadata: { payChannel: 'card_form', chargeModel: 'direct', lawFirmId: away.firm.id, invoiceId: away.invoice.id },
      } as any),
    };
  }
  const cardPath = (step: string) => portalPath(away.firm.id, `billing/pay/${away.invoice.id}/card/${step}`);

  afterEach(() => jest.restoreAllMocks());

  it("refuses a card quote for another firm's invoice from the portal", async () => {
    const { retrieveToken } = await makeAwayCardPayable();
    // The owner of the invoice is quoted, so the route works.
    const own = await away.client.api.post(cardPath('quote')).send({ confirmationTokenId: 'ctoken_vale' });
    expect(own.status).toBe(200);
    expect(own.body.invoiceCents).toBe(AWAY_INVOICE_CENTS);
    expect(retrieveToken).toHaveBeenCalledTimes(1);

    const res = await home.client.api.post(cardPath('quote')).send({ confirmationTokenId: 'ctoken_vale' });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(String(AWAY_INVOICE_CENTS));
    expect(retrieveToken).toHaveBeenCalledTimes(1);
  });

  it("refuses a card charge for another firm's invoice, and charges nothing", async () => {
    const { retrieveToken } = await makeAwayCardPayable();

    const res = await home.client.api.post(cardPath('confirm'))
      .send({ confirmationTokenId: 'ctoken_vale', expectedTotalCents: AWAY_INVOICE_CENTS });

    expect(res.status).toBe(403);
    expect(retrieveToken).not.toHaveBeenCalled();
  });

  it("refuses card complete for an invoice the client can't see, and records nothing", async () => {
    const { retrieveIntent } = await makeAwayCardPayable();

    const res = await home.client.api.post(cardPath('complete')).send({ paymentIntentId: 'pi_vale' });

    expect(res.status).toBe(403);
    expect(retrieveIntent).not.toHaveBeenCalled();
    const { rows } = await testPool.query('select count(*)::int as n from invoice_payments where invoice_id = $1', [away.invoice.id]);
    expect(rows[0].n).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  The writes                                                         */
/* ------------------------------------------------------------------ */

describe('a client of another firm writing', () => {
  it('cannot upload a document into that firm matter, and files nothing', async () => {
    const before = await firmFileRows(away.firm.id);

    const res = await portalUpload(home.client, portalPath(away.firm.id, `matters/${away.matterId}/documents`), [{ name: 'intruder.txt', size: Buffer.byteLength(Buffer.from('intruder payload')) }]);

    expect(res.status).toBe(403);
    // The claim that matters. Portal uploads mirror every stored object into
    // `files`, so an upload that got past the access check and only failed later
    // would still leave a row here. The count is unchanged and no row names the
    // uploaded file.
    const after = await firmFileRows(away.firm.id);
    expect(after).toHaveLength(before.length);
    expect(after.map((f) => f.name)).not.toContain('intruder.txt');
  });

  it('cannot send a message into that firm, and adds no message row', async () => {
    const res = await home.client.api
      .post(portalPath(away.firm.id, 'messages'))
      .send({ content: 'Please wire the settlement to this account instead' });

    expect(res.status).toBe(403);
    // `sendMessage` lazily CREATES the (firm, client) conversation, so a leak
    // here would not surface as an extra message on the away thread but as a
    // brand new conversation in the away firm. Both are checked.
    const { rows } = await testPool.query(
      'select count(*)::int as total from conversations where law_firm_id = $1', [away.firm.id],
    );
    expect(rows[0].total).toBe(1);
    expect((await messageStats(away.conversationId)).total).toBe(1);
  });

  it('cannot mark that firm messages read, and the unread flag survives', async () => {
    const res = await home.client.api
      .put(portalPath(away.firm.id, 'messages/mark-read'))
      .send({ conversationId: away.conversationId, messageIds: [away.messageId] });

    // 403, from the association check, and it has to be the FIRST thing this
    // handler does. It used to do no association check at all and answered 200
    // here: nothing was written, because the conversation resolves from the
    // CALLER's own uid, but `resolvePortalConversationTarget` ran first on the
    // caller-supplied id and answered 404 / 403 / 200 according to whether that
    // conversation existed and which firm owned it. That made the handler a
    // conversation-id oracle for a client with no association to the firm. Both
    // halves are asserted: the refusal, and the flag that an attacker would be
    // moving.
    expect(res.status).toBe(403);
    expect((await messageStats(away.conversationId)).readByClient).toBe(0);

    // The owner clearing it proves the id, the route and the write all work, so
    // the refusal above is the association check rejecting this caller rather
    // than a mark-read that fails for everybody.
    const owner = await away.client.api
      .put(portalPath(away.firm.id, 'messages/mark-read'))
      .send({ conversationId: away.conversationId, messageIds: [away.messageId] });
    expect(owner.status).toBe(200);
    expect((await messageStats(away.conversationId)).readByClient).toBe(1);
  });

  it('learns nothing from mark-read about which conversation ids exist', async () => {
    // The oracle, stated as a test. Three ids that the handler once told apart:
    // one that exists in the named firm, one that exists in a DIFFERENT firm,
    // and one that exists nowhere. An unassociated caller has to get the same
    // answer for all three, or the differing answers themselves are the leak.
    //
    // This goes red if `assertPortalFirmAssociation` moves below the
    // `resolvePortalConversationTarget` call, which is the exact shape of the
    // original bug, not just if the check is deleted outright.
    const answers = await Promise.all(
      [away.conversationId, home.conversationId, '00000000-0000-4000-8000-000000000000'].map(
        (conversationId) => home.client.api
          .put(portalPath(away.firm.id, 'messages/mark-read'))
          .send({ conversationId, messageIds: [] })
          .then((r) => r.status),
      ),
    );

    expect(answers).toEqual([403, 403, 403]);
  });

  it('cannot upload a message attachment to that firm', async () => {
    const before = await firmFileRows(away.firm.id);

    // Both halves of the upload, because each is reachable on its own. The
    // multipart route this replaced was one call; a finalize that skipped the
    // firm-association check would be a way in that the init check never sees.
    const opened = await home.client.api
      .post(portalPath(away.firm.id, 'messages/attachments/upload-init'))
      .send({ files: [{ fileName: 'intruder.txt', contentType: 'text/plain', size: 19 }] });
    const settled = await home.client.api
      .post(portalPath(away.firm.id, 'messages/attachments/upload-finalize'))
      .send({ uploads: [{ objectPath: `lawfirmids/${away.firm.id}/messaging/x/intruder.txt` }], reservedBytes: 19 });

    const res = opened;
    expect(settled.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBe(403);
    // The seeded fulfillment now carries a `files` row of its own: a fulfillment
    // became an `attachments` row keyed on a file (migration 0236), so the seed
    // creates one. What must not appear is a SECOND row from the refused call.
    expect(await firmFileRows(away.firm.id)).toEqual(before);
  });

  it('cannot clear that firm notification bell', async () => {
    const res = await home.client.api.post(
      portalPath(away.firm.id, 'notifications/mark-all-read'),
    );

    expect(res.status).toBe(403);
    expect(await notificationRead(away.notificationId)).toBe(false);

    // Same positive control as mark-read: the owner clears it, so the false
    // above is a refusal rather than an inert endpoint.
    await away.client.api.post(portalPath(away.firm.id, 'notifications/mark-all-read'));
    expect(await notificationRead(away.notificationId)).toBe(true);
  });

  it('cannot mark one of that firm notifications read', async () => {
    const res = await home.client.api.post(
      portalPath(away.firm.id, `notifications/${away.notificationId}/read`),
    );

    expect(res.status).toBe(403);
    expect(await notificationRead(away.notificationId)).toBe(false);
  });

  it('cannot write portal settings under that firm', async () => {
    const res = await home.client.api
      .put(portalPath(away.firm.id, 'settings'))
      .send({ notifications: { invoiceIssued: false } });

    expect(res.status).toBe(403);
    // Settings are stored on a `clients` row, and the row the service writes to
    // is derived from the resolved association rather than from anything the
    // caller sends. So the check is that the away firm's only client row is
    // untouched, and that no row was invented for the home caller inside it.
    const { rows } = await testPool.query(
      'select settings from clients where law_firm_id = $1', [away.firm.id],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].settings ?? {})).not.toContain('invoiceIssued');
  });

  it('cannot fulfill a document request in that firm, and records no fulfillment', async () => {
    const suffix = `document-requests/${away.request.requestId}`
      + `/items/${away.request.itemId}/fulfill`;

    const before = await firmFileRows(away.firm.id);

    const res = await portalUpload(home.client, portalPath(away.firm.id, suffix), [{ name: 'intruder.txt', size: Buffer.byteLength(Buffer.from('intruder payload')) }]);

    expect(res.status).toBe(403);
    // One fulfillment, the seeded one. A request that got through would have
    // recorded a second and flipped the item's rollup.
    expect(await fulfillmentCount(away.request.itemId)).toBe(1);
    // The seeded fulfillment now carries a `files` row of its own: a fulfillment
    // became an `attachments` row keyed on a file (migration 0236), so the seed
    // creates one. What must not appear is a SECOND row from the refused call.
    expect(await firmFileRows(away.firm.id)).toEqual(before);
  });

  it('cannot delete a fulfillment in that firm, and the file survives', async () => {
    const suffix = `document-requests/${away.request.requestId}`
      + `/items/${away.request.itemId}/fulfillments/${away.request.fulfillmentId}`;

    const res = await home.client.api.delete(portalPath(away.firm.id, suffix));

    expect(res.status).toBe(403);
    expect(await fulfillmentCount(away.request.itemId)).toBe(1);

    // The away client removing their own upload proves this delete is live: the
    // survival above is the tenancy check, not an endpoint that never deletes.
    const owner = await away.client.api.delete(portalPath(away.firm.id, suffix));
    expect(owner.status).toBe(200);
    expect(await fulfillmentCount(away.request.itemId)).toBe(0);
  });

  it('cannot mint a signed URL for that firm document', async () => {
    const res = await home.client.api
      .post(portalPath(away.firm.id, `matters/${away.matterId}/documents/refresh-url`))
      .send({ fileId: away.request.fileId });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(away.request.objectPath);
  });

  it('cannot mint a signed URL through the unscoped document route either', async () => {
    const res = await home.client.api
      .post(portalPath(away.firm.id, 'documents/refresh-url'))
      .send({ fileId: away.request.fileId });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(away.request.objectPath);
  });

  it('cannot read a fulfillment signed URL in that firm', async () => {
    const suffix = `document-requests/${away.request.requestId}`
      + `/items/${away.request.itemId}/fulfillments/${away.request.fulfillmentId}/url`;

    const mine = await away.client.api.get(portalPath(away.firm.id, suffix));
    const theirs = await home.client.api.get(portalPath(away.firm.id, suffix));

    // The two refusals mean different things and the difference is the test.
    // The away client OWNS the fulfillment, so the ownership lookup succeeds and
    // they are stopped only when the handler reaches object storage, which this
    // harness deliberately makes unavailable. The home client never gets that
    // far: they are refused at the association check, before any object path is
    // read. Swap the order of those two checks and this pair inverts.
    expect(mine.status).toBe(500);
    expect(theirs.status).toBe(403);
    expect(bodyText(theirs)).not.toContain(away.request.objectPath);
  });
});
