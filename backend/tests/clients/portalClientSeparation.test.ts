/**
 * Two clients of the SAME firm, on the surfaces where telling them apart is the
 * whole job: the trust ledger, the message thread, the payment link and the
 * notification bell.
 *
 * These four have something in common that the matter surfaces do not. There is
 * no matter in the middle to scope them: the firm holds one trust account with
 * both clients' money in it, one `messages` table with both clients' threads in
 * it, one `invoices` table and one `notifications` table. Every one of them is
 * separated by a single predicate on the calling client, and every one of them
 * returns a perfectly ordinary 200 when that predicate is wrong. A firm would
 * find out from a client who saw somebody else's retainer balance.
 *
 * `portalScopedReads.test.ts` covers the invoice reads and the notification
 * WRITES against a same-firm neighbour. This file covers what it does not: trust
 * money, messaging in both directions, the Stripe pay link, and the notification
 * LIST.
 *
 * THE CAST, rebuilt per test. `mine` and `theirs` are both ordinary person
 * clients of Hale & Co, each with:
 *
 *   - a deposit in the firm's ONE trust account, for distinct amounts. Sharing
 *     the account is deliberate: separate accounts would let account scoping
 *     stand in for client scoping and the tests would pass either way.
 *   - a direct message thread with the firm, each holding one unread message.
 *   - a matter of their own, plus `sharedMatter` that both are clients of.
 *
 * Every negative below is paired with the other client's own request returning
 * the same value, so an empty result means it was withheld rather than absent.
 */
import {
  createFirm,
  ownerOf,
  testPool,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  bodyText,
  messageStats,
  portalPath,
  portalPerson,
  seedClientInvoice,
  seedDirectConversation,
  seedMatter,
  seedMatterInvoice,
  seedNotification,
  seedTrustAccount,
  seedTrustDeposit,
  type PortalPerson,
} from './portalWorld';

let firm: Firm;
let owner: Actor;
let mine: PortalPerson;
let theirs: PortalPerson;
let myMatter: string;
let sharedMatter: string;
/** The firm's single trust account, holding both clients' money. */
let trustAccountId: string;

const MY_TRUST_CENTS = 412_600;
const THEIR_TRUST_CENTS = 927_500;
const MY_TRUST_MEMO = 'Mia initial retainer';
const THEIR_TRUST_MEMO = 'Otto initial retainer';

const P = (suffix: string) => portalPath(firm.id, suffix);

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  mine = await portalPerson(firm.id, 'Mia Client');
  theirs = await portalPerson(firm.id, 'Otto Other');

  myMatter = await seedMatter(firm.id, 'Mia Only', [mine.clientId]);
  sharedMatter = await seedMatter(firm.id, 'Joint Venture', [mine.clientId, theirs.clientId]);

  // ONE account, holding both clients' money. Deliberate: with an account each,
  // account scoping would produce the right answers for the wrong reason and
  // every case below would pass against a missing client predicate.
  trustAccountId = (await seedTrustAccount(firm.id, 'Hale IOLTA')).id;
  await seedTrustDeposit(firm.id, trustAccountId, mine.clientId, {
    amountCents: MY_TRUST_CENTS,
    description: MY_TRUST_MEMO,
  });
  await seedTrustDeposit(firm.id, trustAccountId, theirs.clientId, {
    amountCents: THEIR_TRUST_CENTS,
    description: THEIR_TRUST_MEMO,
  });

  await drainEvents();
});

/* ------------------------------------------------------------------ */
/*  Trust                                                              */
/* ------------------------------------------------------------------ */

describe('the trust balance', () => {
  it('reports this client own money and not the account total', async () => {
    const res = await mine.api.get(P('trust/balance'));

    expect(res.status).toBe(200);
    // Both deposits sit in the same account, so a balance read that summed the
    // ACCOUNT rather than this client's rows would report 1,340,100 here. The
    // other client's figure and the sum are both excluded explicitly, because
    // those are the two ways this goes wrong.
    expect(res.body.totalBalanceCents).toBe(MY_TRUST_CENTS);
    expect(bodyText(res)).not.toContain(String(THEIR_TRUST_CENTS));
    expect(bodyText(res)).not.toContain(String(MY_TRUST_CENTS + THEIR_TRUST_CENTS));
  });

  it('reports the other client own money to them', async () => {
    const res = await theirs.api.get(P('trust/balance'));

    // The pairing that makes the exclusion above meaningful: the money is real,
    // reachable, and in the same account.
    expect(res.body.totalBalanceCents).toBe(THEIR_TRUST_CENTS);
  });

  it('names the shared account, so the separation is per client and not per account', async () => {
    const forMe = await mine.api.get(P('trust/balance'));
    const forThem = await theirs.api.get(P('trust/balance'));

    // Both clients see the SAME account name with different balances against it.
    // That is what rules out the alternative explanation for the numbers above,
    // in which each client happens to have an account of their own.
    expect(forMe.body.accountBalances.map((a: any) => a.trustAccountId)).toEqual([trustAccountId]);
    expect(forThem.body.accountBalances.map((a: any) => a.trustAccountId)).toEqual([trustAccountId]);
  });
});

describe('the trust ledger', () => {
  it('lists this client transactions only', async () => {
    const res = await mine.api.get(P('trust/ledger'));

    expect(res.status).toBe(200);
    expect(res.body.transactions.map((t: any) => t.description)).toEqual([MY_TRUST_MEMO]);
    expect(res.body.totalItems).toBe(1);
    expect(bodyText(res)).not.toContain(THEIR_TRUST_MEMO);
    expect(bodyText(res)).not.toContain(String(THEIR_TRUST_CENTS));
  });

  it('lists the other client transactions to them', async () => {
    const res = await theirs.api.get(P('trust/ledger'));

    expect(res.body.transactions.map((t: any) => t.description)).toEqual([THEIR_TRUST_MEMO]);
    expect(res.body.totalItems).toBe(1);
  });

  it('reports a count that describes this client ledger, not the firm', async () => {
    // `totalItems` drives the pager. Computed over the account instead of the
    // client it would say two, and the client would page into a second screen
    // built from somebody else's transactions.
    const { rows } = await testPool.query(
      'select count(*)::int as total from trust_transactions where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].total).toBe(2);

    const res = await mine.api.get(P('trust/ledger?limit=200'));

    expect(res.body.totalItems).toBe(1);
    expect(res.body.transactions).toHaveLength(1);
  });

  it('withholds the firm internal ledger columns', async () => {
    const res = await mine.api.get(P('trust/ledger'));
    const txn = res.body.transactions[0];

    // The row carries firm-side accounting columns the portal must not ship:
    // which account the money is in, the running ACCOUNT balance (from which the
    // other client's balance is one subtraction away), and the reconciliation
    // state. The whitelist is asserted as a whole so a new column added to the
    // repository does not silently become client-visible.
    expect(Object.keys(txn).sort()).toEqual([
      'amountCents', 'clientBalanceAfter', 'createdAt', 'date', 'description', 'id', 'status', 'type',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  Messaging                                                          */
/* ------------------------------------------------------------------ */

describe('the message thread', () => {
  const MY_MESSAGE = 'Mia, your settlement figures are attached';
  const THEIR_MESSAGE = 'Otto, your settlement figures are attached';

  let myThread: { conversationId: string; messageId: string };
  let theirThread: { conversationId: string; messageId: string };

  beforeEach(async () => {
    myThread = await seedDirectConversation(firm.id, mine, {
      firmName: firm.name, messageContent: MY_MESSAGE, senderUserId: owner.uid,
    });
    theirThread = await seedDirectConversation(firm.id, theirs, {
      firmName: firm.name, messageContent: THEIR_MESSAGE, senderUserId: owner.uid,
    });
  });

  it('serves this client their own thread and not the neighbour one', async () => {
    const res = await mine.api.get(P('messages'));

    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe(myThread.conversationId);
    expect(res.body.messages.map((m: any) => m.content)).toEqual([MY_MESSAGE]);
    expect(bodyText(res)).not.toContain(THEIR_MESSAGE);
  });

  it('refuses the neighbour thread when its id is named directly', async () => {
    const refused = await mine.api.get(P(`messages?conversationId=${theirThread.conversationId}`));
    const served = await theirs.api.get(P(`messages?conversationId=${theirThread.conversationId}`));

    // Named in the query, so the firm scoping never gets a chance to hide it and
    // only the participant check stands in the way. The neighbour's own 200 on
    // the same id proves the thread is live.
    expect(refused.status).toBe(403);
    expect(bodyText(refused)).not.toContain(THEIR_MESSAGE);
    expect(served.status).toBe(200);
    expect(served.body.messages.map((m: any) => m.content)).toEqual([THEIR_MESSAGE]);
  });

  it('lists only this client conversations', async () => {
    const res = await mine.api.get(P('messages/conversations'));

    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c: any) => c.conversationId))
      .toEqual([myThread.conversationId]);
    expect(res.body.totalItems).toBe(1);
    // The preview is the leak that a conversation LIST makes even when the
    // thread itself is protected: it carries the last message's text.
    expect(bodyText(res)).not.toContain(THEIR_MESSAGE);
  });

  it('does not write into the neighbour thread when its id is sent', async () => {
    const res = await mine.api
      .post(P('messages'))
      .send({ conversationId: theirThread.conversationId, clientId: theirs.uid, content: 'Wire it here instead' });

    // Two pieces of the body name the neighbour: the thread and the client to
    // send as. Both are ignored, because the send path resolves its destination
    // from the CALLER's own uid, so naming somebody else's thread silently posts
    // into your own. Accepted, therefore, and the assertion is on where the
    // message landed rather than on the status. Trust `body.clientId` instead
    // and the messaging service's own "send as yourself" guard turns this 403.
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe(myThread.conversationId);
    expect((await messageStats(theirThread.conversationId)).total).toBe(1);
    expect((await messageStats(myThread.conversationId)).total).toBe(2);
  });

  it('refuses to tag a message with a matter this client is not on', async () => {
    const theirMatter = await seedMatter(firm.id, 'Otto Only', [theirs.clientId]);

    const res = await mine.api
      .post(P('messages'))
      .send({ content: 'About your matter', matterId: theirMatter });

    expect(res.status).toBe(403);
    // Refused before anything is stored. A tag that was accepted and only
    // filtered on read would still have put this client's text on a matter
    // thread the firm reads under another client's name.
    expect((await messageStats(myThread.conversationId)).total).toBe(1);
  });

  it('allows a tag with a matter this client shares with the neighbour', async () => {
    const res = await mine.api
      .post(P('messages'))
      .send({ content: 'About our joint venture', matterId: sharedMatter });

    // The paired positive. Without it the refusal above is also satisfied by a
    // route that rejects every `matterId` it is given.
    expect(res.status).toBe(200);
    expect((await messageStats(myThread.conversationId)).total).toBe(2);
  });

  it('cannot mark the neighbour messages read', async () => {
    const res = await mine.api
      .put(P('messages/mark-read'))
      .send({ conversationId: theirThread.conversationId, messageIds: [theirThread.messageId] });

    expect(res.status).toBe(403);
    expect((await messageStats(theirThread.conversationId)).readByClient).toBe(0);

    // The neighbour clearing their own thread proves the write works, so the
    // zero above is the conversation check refusing this caller.
    const owned = await theirs.api
      .put(P('messages/mark-read'))
      .send({ conversationId: theirThread.conversationId, messageIds: [theirThread.messageId] });
    expect(owned.status).toBe(200);
    expect((await messageStats(theirThread.conversationId)).readByClient).toBe(1);
  });

  it('cannot mark the neighbour messages read by id alone', async () => {
    // No `conversationId`, so the mismatch check never fires and the only thing
    // scoping this write is the conversation resolved from the caller's uid.
    // The ids belong to the neighbour's thread.
    const res = await mine.api
      .put(P('messages/mark-read'))
      .send({ messageIds: [theirThread.messageId] });

    expect(res.status).toBe(200);
    expect((await messageStats(theirThread.conversationId)).readByClient).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  The payment link                                                   */
/* ------------------------------------------------------------------ */

describe('the invoice payment link', () => {
  it('resolves an invoice billed to this client', async () => {
    const invoice = await seedClientInvoice(firm.id, mine.clientId, {
      totalCents: 250_000, invoiceNumber: 'INV-MIA-1',
    });

    const res = await mine.api.get(P(`billing/pay/${invoice.id}`));

    // 400, not 200: the fixture invoice has no payment requested on it, so a
    // caller who OWNS it reaches the payment provider and is turned back by its
    // own precondition. Getting that far is the proof that ownership resolved,
    // which is what makes every 404 below mean something.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Payment has not been requested');
  });

  it('does not resolve an invoice billed to the neighbour', async () => {
    const invoice = await seedClientInvoice(firm.id, theirs.clientId, {
      totalCents: 999_900, invoiceNumber: 'INV-OTTO-1',
    });

    const refused = await mine.api.get(P(`billing/pay/${invoice.id}`));
    const owned = await theirs.api.get(P(`billing/pay/${invoice.id}`));

    // 404 rather than 403, so probing ids cannot tell "not yours" from "does not
    // exist". The neighbour's 400 proves the id is live and payable-in-principle.
    expect(refused.status).toBe(404);
    expect(bodyText(refused)).not.toContain('9999');
    expect(owned.status).toBe(400);
  });

  it('does not resolve a co-client invoice on a matter this client shares', async () => {
    const invoice = await seedMatterInvoice(firm.id, sharedMatter, theirs, {
      totalCents: 777_700, invoiceNumber: 'INV-OTTO-JOINT',
    });

    const refused = await mine.api.get(P(`billing/pay/${invoice.id}`));
    const owned = await theirs.api.get(P(`billing/pay/${invoice.id}`));

    // The sharpest case here. I have full access to the matter this invoice
    // hangs off, so the matter check passes and ONLY the ownership rule stands
    // between me and a checkout session for somebody else's bill. Drop that rule
    // and this route starts handing out payment links on a healthy-looking 200.
    expect(refused.status).toBe(404);
    expect(owned.status).toBe(400);
  });

  it('does not resolve an invoice on a matter this client is not on at all', async () => {
    const theirMatter = await seedMatter(firm.id, 'Otto Only', [theirs.clientId]);
    const invoice = await seedMatterInvoice(firm.id, theirMatter, theirs, {
      totalCents: 555_500, invoiceNumber: 'INV-OTTO-SOLO',
    });

    const refused = await mine.api.get(P(`billing/pay/${invoice.id}`));

    expect(refused.status).toBe(404);
    expect(bodyText(refused)).not.toContain('5555');
  });

  it('answers NOT FOUND for an id that is not a uuid', async () => {
    // The uuid guard, not a database cast error. Without it this reaches
    // Postgres and returns 500, which tells a prober that the shape of their
    // input mattered.
    const res = await mine.api.get(P('billing/pay/not-a-uuid'));

    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*  The notification bell                                              */
/* ------------------------------------------------------------------ */

describe('the notification feed', () => {
  it('lists this client own rows only', async () => {
    await seedNotification(firm.id, mine.uid, 'Mia invoice is ready');
    await seedNotification(firm.id, theirs.uid, 'Otto invoice is ready');

    const forMe = await mine.api.get(P('notifications'));
    const forThem = await theirs.api.get(P('notifications'));

    expect(forMe.status).toBe(200);
    expect(forMe.body.notifications.map((n: any) => n.title)).toEqual(['Mia invoice is ready']);
    expect(bodyText(forMe)).not.toContain('Otto invoice is ready');
    // The neighbour's row is reachable by its own owner, so the exclusion above
    // is a predicate rather than a notification that never got written.
    expect(forThem.body.notifications.map((n: any) => n.title)).toEqual(['Otto invoice is ready']);
  });

  it('counts unread for this client only', async () => {
    await seedNotification(firm.id, mine.uid, 'Mia invoice is ready');
    await seedNotification(firm.id, theirs.uid, 'Otto invoice is ready');
    await seedNotification(firm.id, theirs.uid, 'Otto hearing moved');

    const res = await mine.api.get(P('notifications'));

    // The badge is a separate query from the list, so a list that is correctly
    // scoped can still sit under a count that is not. Three rows exist in the
    // firm; one belongs to this client.
    expect(res.body.unreadCount).toBe(1);
  });

  it('pages without losing a row that shares a millisecond with the last one', async () => {
    // The portal builds its own cursor from the same rows the firm-side feed
    // does, on its own line of code, so it needs its own case. `created_at` is
    // `timestamptz` (microseconds) and node-pg parses it into a JS `Date`
    // (milliseconds); serving the parsed value back rounded the cursor DOWN, and
    // the comparison is strictly less-than, so a row later in the same
    // millisecond was skipped by that page and by every page after it.
    const micros = ['000900', '000600', '000300'];
    for (let i = 0; i < micros.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedNotification(firm.id, mine.uid, `Update ${i}`, `2026-06-01 10:00:00.${micros[i]}+00`);
    }

    const seen: string[] = [];
    let query = '?limit=1';
    for (let page = 0; page < 6; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await mine.api.get(P(`notifications${query}`));
      expect(res.status).toBe(200);
      seen.push(...res.body.notifications.map((n: any) => n.title));
      if (!res.body.nextBefore) break;
      query = `?limit=1&before=${encodeURIComponent(res.body.nextBefore)}`
        + `&beforeId=${res.body.nextBeforeId}`;
    }

    // Newest first, so the order also proves the cursor compares at full
    // precision rather than merely returning everything.
    expect(seen).toEqual(['Update 0', 'Update 1', 'Update 2']);
  });
});

/* ------------------------------------------------------------------ */
/*  The dashboard                                                      */
/* ------------------------------------------------------------------ */

describe('the client dashboard', () => {
  it('is built from this client own matters and invoices', async () => {
    await seedClientInvoice(firm.id, mine.clientId, {
      totalCents: 250_000, invoiceNumber: 'INV-MIA-1',
    });
    await seedClientInvoice(firm.id, theirs.clientId, {
      totalCents: 999_900, invoiceNumber: 'INV-OTTO-1',
    });
    const theirMatter = await seedMatter(firm.id, 'Otto Only', [theirs.clientId]);

    const res = await mine.api.get(P('dashboard'));

    expect(res.status).toBe(200);
    expect(res.body.matters.map((m: any) => m.id).sort()).toEqual([myMatter, sharedMatter].sort());
    expect(res.body.matters.map((m: any) => m.id)).not.toContain(theirMatter);
    // Dollars, from `total_cents`. The neighbour's 9,999 must appear nowhere,
    // and neither must the firm-wide sum of 12,499.
    expect(res.body.billingSummary.totalBilled).toBe(2500);
    expect(bodyText(res)).not.toContain('9999');
    expect(bodyText(res)).not.toContain('12499');
  });

  it('ships only display-safe fields on the client profile', async () => {
    // The raw `clients` row carries firm-internal columns. All three are SET
    // here, so this is a whitelist being enforced rather than a row that
    // happened to be empty: the negotiated rate card the firm bills this client
    // at, the Stripe customer handle, and who invited them.
    const updated = await testPool.query(
      `update clients
          set billing_rates = '{"partner": 65000}'::jsonb,
              stripe_customer_id = 'cus_internal_only',
              invited_by = $2
        where id = $1`,
      [mine.clientId, owner.uid],
    );
    expect(updated.rowCount).toBe(1);

    const res = await mine.api.get(P('dashboard'));

    expect(Object.keys(res.body.profile).sort()).toEqual([
      'address', 'email', 'id', 'matterIds', 'name', 'organization',
      'phone', 'preferredContactMethod', 'status', 'userId',
    ]);
    expect(bodyText(res)).not.toContain('cus_internal_only');
    expect(bodyText(res)).not.toContain('65000');
  });
});
