/**
 * The low-balance replenishment alert: `_createTransactionInternal`
 * (trust.service.ts) fires `TRUST_LOW_BALANCE` when a debit crosses a client's
 * configured (or firm-default) minimum, and the listener in trust.events.ts
 * notifies the firm's trust managers in-app.
 *
 * Nothing in the suite exercised this path before this file: a grep for
 * TRUST_LOW_BALANCE / trust_low_balance / minimum-balances across tests/ turned
 * up only route-catalog and fixture-shape references, never the notification
 * actually firing.
 *
 * The trigger condition, read straight off the source:
 *
 *   !isCredit && threshold > 0 && clientBalanceAfter < threshold && clientBalanceBefore >= threshold
 *
 * That is a CROSSING check, not a "currently below" check, and it is
 * per-(client, account): `trustMinRepo.getMinimum(lawFirmId, clientId, trustAccountId)`
 * falls back to the firm-wide $100 default only when no row exists for that
 * exact pair.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  createOrgClient,
  linkPersonToOrg,
  createFirmMember,
  ensureUser,
  ownerOf,
  memberWith,
  drainEvents,
  emailsMatching,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { createTrustAccount, postTrustTxn } from '../support/trust';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const F = () => `/api/lawfirms/${firm.id}/trust`;
const DEFAULT_THRESHOLD_CENTS = 10_000; // $100, LOW_BALANCE_THRESHOLD_CENTS in trust.service.ts

const createAccount = (name: string, last4: string) => createTrustAccount(owner, firm.id, { name, last4 });

async function txn(clientRec: ClientRecord, type: string, amountCents: number, extra: Record<string, unknown> = {}) {
  const res = await postTrustTxn(owner, firm.id, {
    trustAccountId: accountId, clientId: clientRec.id, type, amountCents, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.transaction.id as string;
}

async function setMinimum(clientId: string, trustAccountId: string, minimumCents: number) {
  const res = await owner.api.put(`${F()}/minimum-balances`).send({ clientId, trustAccountId, minimumCents });
  expect(res.status).toBe(200);
}

async function lowBalanceAlertsCount() {
  await drainEvents();
  const { rows } = await testPool.query(
    `select count(*)::int n from notifications where law_firm_id = $1 and type = 'trust_low_balance'`,
    [firm.id],
  );
  return rows[0].n as number;
}

async function lowBalanceRecipients() {
  await drainEvents();
  const { rows } = await testPool.query(
    `select distinct user_id from notifications where law_firm_id = $1 and type = 'trust_low_balance'`,
    [firm.id],
  );
  return rows.map((r: any) => r.user_id as string);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createAccount('Primary IOLTA', '1111');
});

describe('crossing versus remaining below the threshold', () => {
  it('fires when a withdrawal drops the balance from at-or-above the threshold to below it', async () => {
    await txn(client, 'deposit', 15_000); // above threshold
    await txn(client, 'withdrawal', 10_000); // 5,000 left: below the $100 default

    expect(await lowBalanceAlertsCount()).toBe(1);
  });

  it('does not re-fire on a further withdrawal that was already below the threshold', async () => {
    await txn(client, 'deposit', 5_000); // already below threshold; deposits never alert
    await txn(client, 'withdrawal', 1_000); // 4,000 -> still below, but never crossed FROM at-or-above

    expect(await lowBalanceAlertsCount()).toBe(0);
  });
});

describe('the firm default minimum', () => {
  const setFirmDefault = async (cents: number | null) => {
    const res = await owner.api.put(`${F()}/settings`).send({ defaultMinimumCents: cents });
    expect(res.status).toBe(200);
  };

  it('replaces the built-in $100 for a client with no minimum of its own', async () => {
    await setFirmDefault(50_000); // $500

    await txn(client, 'deposit', 60_000);
    await txn(client, 'withdrawal', 20_000); // 60,000 -> 40,000, under $500

    // Under the built-in $100 this crossing would not fire at all: the balance
    // never went below 10,000. It fires because the firm raised the bar.
    expect(await lowBalanceAlertsCount()).toBe(1);
  });

  it('still loses to a minimum set for that client and account', async () => {
    await setFirmDefault(50_000);
    await setMinimum(client.id, accountId, 10_000);

    await txn(client, 'deposit', 60_000);
    await txn(client, 'withdrawal', 20_000); // 40,000: below the firm default, above this client's

    // Most specific wins. A client on a negotiated floor must not be judged by
    // the firm-wide one.
    expect(await lowBalanceAlertsCount()).toBe(0);
  });

  it('refuses a default above the money ceiling', async () => {
    const res = await owner.api.put(`${F()}/settings`)
      .send({ defaultMinimumCents: 1_000_000_000 * 100 + 1 });
    expect(res.status).toBe(400);
  });
});

describe('a zero minimum never alerts', () => {
  it('does not fire even when a client drawn down through the $100 default would otherwise cross it', async () => {
    // An explicit 0 override means "no minimum for this client", not "an
    // unconfigured minimum" -- the two must be told apart, because
    // `getMinimum` returning 0 is a legitimate, deliberately-configured value,
    // not an absent one. `trust.service.ts` reads it with `?? LOW_BALANCE_
    // THRESHOLD_CENTS`, nullish-coalescing: 0 is not null/undefined, so the
    // override sticks. A `||` fallback instead would treat the configured 0 as
    // falsy and silently reinstate the $100 default.
    await setMinimum(client.id, accountId, 0);
    await txn(client, 'deposit', 15_000); // above the $100 default too
    // Crosses the (unused) $100 default on the way down, landing on exactly
    // the configured 0 minimum. If the override were dropped in favor of the
    // default, this withdrawal alone would trigger the alert.
    await txn(client, 'withdrawal', 15_000); // balance hits exactly 0

    expect(await lowBalanceAlertsCount()).toBe(0);
  });
});

describe('landing exactly on the threshold is not "below" it', () => {
  it('does not fire when the balance after the withdrawal equals the configured minimum', async () => {
    await setMinimum(client.id, accountId, 5_000);
    await txn(client, 'deposit', 10_000);
    await txn(client, 'withdrawal', 5_000); // lands exactly on the 5,000 minimum

    expect(await lowBalanceAlertsCount()).toBe(0);
  });

  it('fires on the very next cent below it', async () => {
    await setMinimum(client.id, accountId, 5_000);
    await txn(client, 'deposit', 10_000);
    await txn(client, 'withdrawal', 5_001); // 4,999 -- one cent under

    expect(await lowBalanceAlertsCount()).toBe(1);
  });
});

describe('the minimum is scoped to one (client, account) pair, not the client or account alone', () => {
  it('does not leak a client-specific override onto a different account for the same client', async () => {
    const secondAccountId = await createAccount('Secondary IOLTA', '2222');
    // A high override on the FIRST account only.
    await setMinimum(client.id, accountId, 30_000);

    // On the second account (no override), the default $100 threshold applies.
    // Numbers are chosen so the two thresholds disagree: 20,000 -> 8,000 crosses
    // the 10,000 default but never even reaches the 30,000 override (already
    // below it before the deposit), so a leaked override would suppress this.
    await txn(client, 'deposit', 20_000, { trustAccountId: secondAccountId });
    await txn(client, 'withdrawal', 12_000, { trustAccountId: secondAccountId });

    expect(await lowBalanceAlertsCount()).toBe(1);
  });

  it('does not leak a client-specific override onto a different client on the same account', async () => {
    const otherClient = await createPersonClient(firm.id, { name: 'Other Client' });
    await setMinimum(client.id, accountId, 30_000); // override for `client`, not `otherClient`

    // otherClient has no override, so the default 10,000 applies. Same
    // discriminating numbers as above: a leaked override would suppress this.
    await txn(otherClient, 'deposit', 20_000);
    await txn(otherClient, 'withdrawal', 12_000);

    expect(await lowBalanceAlertsCount()).toBe(1);
  });
});

describe('recovery does not suppress the next crossing', () => {
  it('fires again after a deposit brings the balance back up and a later withdrawal crosses again', async () => {
    await txn(client, 'deposit', 20_000);
    await txn(client, 'withdrawal', 15_000); // 5,000: crossing #1

    // Recovery: a deposit is a credit and never itself alerts.
    await txn(client, 'deposit', 20_000); // back to 25,000, well above threshold

    // An unrelated transaction for a different client in between must not be
    // mistaken for a repeat alert on THIS client.
    const otherClient = await createPersonClient(firm.id, { name: 'Unrelated Client' });
    await txn(otherClient, 'deposit', 50_000);

    // Landing on a DIFFERENT balance than crossing #1 (4,800, not 5,000) is
    // deliberate: the notification body embeds the dollar figure, and the
    // general notification pipeline (notifications.repository.ts createMany)
    // treats an identical (type, title, body) for the same recipient as a
    // duplicate through two mechanisms -- a sliding-window pre-check
    // (DEDUPE_WINDOW_MS, 60s) AND the per-unix-minute `dedupe_bucket` on the
    // unique index backing the insert -- regardless of whether the events are
    // actually different. Two crossings that happen to land on the exact same
    // balance within a minute of each other collide by that unrelated
    // mechanism -- characterized separately below -- so this test proves the
    // thing T08 actually asks for (recovery does not suppress a genuinely
    // later crossing) without that confound.
    await txn(client, 'withdrawal', 20_200); // 4,800: crossing #2

    expect(await lowBalanceAlertsCount()).toBe(2);
  });
});

describe('distinct low-balance crossings', () => {
  it('keeps both crossings even when their balances and rendered alert bodies match', async () => {
    await txn(client, 'deposit', 20_000);
    await txn(client, 'withdrawal', 15_000);
    await txn(client, 'deposit', 20_000);
    await txn(client, 'withdrawal', 20_000);
    expect(await lowBalanceAlertsCount()).toBe(2);
  });
});

describe('recipient permission', () => {
  it('notifies the owner and a trust.manage member, but not a member with only trust.view', async () => {
    const manager = await createFirmMember(firm.id, { isOwner: false, permissions: ['trust.manage', 'trust.view'] });
    const viewerOnly = await memberWith(firm.id, ['trust.view']);

    await txn(client, 'deposit', 15_000);
    await txn(client, 'withdrawal', 10_000); // crosses below

    const recipients = await lowBalanceRecipients();
    expect(recipients).toContain(owner.uid);
    expect(recipients).toContain(manager.uid);
    expect(recipients).not.toContain(viewerOnly.uid);
  });
});

/**
 * What the CLIENT is told when the balance crosses below the minimum. The
 * figures in these messages are the ask: the balance, the minimum, and the
 * top-up (minimum minus balance). An off-by-a-cent top-up, or one computed from
 * the wrong side, is a client being told to send the wrong amount.
 *
 * Every case lands on 49.99 below a 100.00 minimum so the top-up is 50.01 and a
 * swapped or rounded figure cannot coincide with the right one.
 */
describe('telling the client', () => {
  // `clientName` is the label the ledger form sends with every entry; the alert
  // names the client by it, so these send the record's own name as the UI does.
  const crossTo4999 = async (clientRec: ClientRecord, clientName: string) => {
    await txn(clientRec, 'deposit', 15_000, { clientName });
    await txn(clientRec, 'withdrawal', 10_001, { clientName });
    await drainEvents();
  };

  it('emails a person client the exact balance, minimum and top-up', async () => {
    const payer = await createPersonClient(firm.id, { name: 'Dana Payer', email: 'dana@example.test' });

    await crossTo4999(payer, 'Dana Payer');

    const sent = emailsMatching(/retainer with .* is running low/);
    expect(sent.map((m) => m.to)).toEqual([['dana@example.test']]);
    const html = String(sent[0].html);
    expect(html).toContain('balance of <strong>$49.99</strong>');
    expect(html).toContain('minimum of <strong>$100.00</strong>');
    expect(html).toContain('add at least <strong>$50.01</strong>');
    expect(html).toContain(`billing?clientRecordId=${payer.id}`);
  });

  it('posts the alert into a portal client\'s conversation, and reuses it on the next crossing', async () => {
    const portalUid = `portal-${firm.id.slice(0, 8)}`;
    await ensureUser(portalUid);
    const payer = await createPersonClient(firm.id, { name: 'Portal Payer', userId: portalUid });

    await crossTo4999(payer, 'Portal Payer');
    await txn(payer, 'deposit', 20_000); // 249.99, back above the minimum
    await txn(payer, 'withdrawal', 20_100); // 48.99: a second, distinct crossing
    await drainEvents();

    const conversations = await testPool.query(
      'select id from conversations where law_firm_id = $1 and client_id = $2', [firm.id, portalUid],
    );
    // One thread, not one per alert: the second crossing must find the first's.
    expect(conversations.rows).toHaveLength(1);
    const messages = await testPool.query(
      `select content, sender_name, read_by_client, read_by_firm from messages
        where conversation_id = $1 order by created_at, content`,
      [conversations.rows[0].id],
    );
    const expected = (balance: string) => ({
      content: `Your trust account balance is now ${balance}. Please contact your legal team to replenish your retainer to ensure continued service.`,
      sender_name: 'Trust Account Alert',
      read_by_client: false,
      read_by_firm: true,
    });
    expect(messages.rows).toEqual([expected('$49.99'), expected('$48.99')]);
  });

  it('alerts an organization\'s roster members who may see billing, and emails its billing recipient', async () => {
    // An organization has no portal login of its own, so it is reached through
    // its roster. The alert states the balance, so a roster member denied
    // billing must not receive it.
    const org = await createOrgClient(firm.id, { name: 'Holloway Industries' });
    const billingUid = `billing-${firm.id.slice(0, 8)}`;
    const deniedUid = `denied-${firm.id.slice(0, 8)}`;
    await ensureUser(billingUid);
    await ensureUser(deniedUid);
    const withBilling = await createPersonClient(firm.id, {
      name: 'Billing Contact', userId: billingUid, email: 'ap@holloway.example.test',
    });
    const withoutBilling = await createPersonClient(firm.id, { name: 'Other Contact', userId: deniedUid });
    await linkPersonToOrg(firm.id, withBilling.id, org.id, { canViewBilling: true, isEmailRecipient: true });
    await linkPersonToOrg(firm.id, withoutBilling.id, org.id, { canViewBilling: false });

    await crossTo4999(org, 'Holloway Industries');

    const { rows } = await testPool.query(
      `select user_id, body, action_url from notifications
        where law_firm_id = $1 and type = 'trust_low_balance' and user_id = any($2)`,
      [firm.id, [billingUid, deniedUid]],
    );
    expect(rows).toEqual([{
      user_id: billingUid,
      body: 'Holloway Industries\'s trust balance is now $49.99, below the $100.00 minimum. '
        + 'Please contact your legal team to replenish the retainer.',
      action_url: expect.stringContaining(`/trust?clientRecordId=${org.id}`),
    }]);
    // No conversation for the organization itself: it has no login to own one.
    const conversations = await testPool.query(
      'select count(*)::int n from conversations where law_firm_id = $1', [firm.id],
    );
    expect(conversations.rows[0].n).toBe(0);
    const sent = emailsMatching(/running low/);
    expect(sent.map((m) => m.to)).toEqual([['ap@holloway.example.test']]);
    expect(String(sent[0].html)).toContain('add at least <strong>$50.01</strong>');
  });
});

describe('listing the configured minimums', () => {
  it('lists this firm\'s minimums by client then account, with exact cents and names, and none of another firm\'s', async () => {
    const second = await createAccount('Second IOLTA', '2222');
    const alpha = await createPersonClient(firm.id, { name: 'Alpha Client' });
    await setMinimum(client.id, accountId, 25_001);
    await setMinimum(alpha.id, second, 7_550);
    await setMinimum(alpha.id, accountId, 100);
    const rival = await createFirm();
    const rivalOwner = await ownerOf(rival.id);

    const res = await owner.api.get(`${F()}/minimum-balances`);
    const theirs = await rivalOwner.api.get(`/api/lawfirms/${rival.id}/trust/minimum-balances`);

    expect(res.status).toBe(200);
    expect(res.body.minimumBalances.map((m: any) => [m.clientName, m.trustAccountName, m.minimumCents])).toEqual([
      ['Alpha Client', 'Primary IOLTA', 100],
      ['Alpha Client', 'Second IOLTA', 7_550],
      ['Trust Client', 'Primary IOLTA', 25_001],
    ]);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toEqual({ minimumBalances: [] });
  });
});
