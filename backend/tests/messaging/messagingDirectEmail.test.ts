/**
 * The "you have a new message" email a DIRECT thread sends its client.
 *
 * Two promises the group thread already kept and the direct thread did not:
 *
 *  - A member who presents to clients as the firm stays the firm in the email
 *    too. The thread masks them; an email naming the individual undoes that.
 *  - The one-hour cooldown is claimed atomically. Two messages landing together
 *    must not both see an expired cooldown and mail the client twice.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  emailsMatching,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const msgRepo = require('../../src/modules/messaging/messaging.repository');

let firm: Firm;
let owner: Actor;
let ownerName: string;

const M = (suffix = '') => `/api/lawfirms/${firm.id}/messaging${suffix}`;

/** The new-message emails addressed to one client. */
const emailsTo = (uid: string) => emailsMatching(/New message/i)
  .filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(`${uid}@example.test`));

/**
 * The email is fire-and-forget from the send route, so poll for it. A negative
 * or exact-count assertion waits the full budget before reading the outbox.
 */
async function waitForEmails(uid: string, atLeast: number, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (emailsTo(uid).length >= atLeast) return emailsTo(uid);
    if (Date.now() >= deadline) return emailsTo(uid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freshClient() {
  const portal = await createPortalUser({ name: 'Notified Client' });
  await createPersonClient(firm.id, { name: 'Notified Client', userId: portal.uid });
  return portal.uid;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Harbor Legal Group' });
  owner = await ownerOf(firm.id);
  const { rows } = await testPool.query('select name from users where id = $1', [owner.uid]);
  ownerName = rows[0].name;
  expect(ownerName).toBeTruthy();
  await drainEvents();
});

describe('who the email says the message is from', () => {
  it('names the individual when they write as themselves', async () => {
    const uid = await freshClient();

    const res = await owner.api.post(M('/send')).send({ clientId: uid, content: 'Personal note' });
    expect(res.status).toBe(201);

    const [email] = await waitForEmails(uid, 1);
    expect(email).toBeDefined();
    expect(email.html).toContain(`${ownerName} at <strong>Harbor Legal Group</strong>`);
  });

  it('names the firm, not the member, when the member presents as the firm', async () => {
    const pref = await owner.api.put(M('/present-as-firm')).send({ presentAsFirm: true });
    expect(pref.status).toBe(200);
    const uid = await freshClient();

    const res = await owner.api.post(M('/send')).send({ clientId: uid, content: 'From the firm' });
    expect(res.status).toBe(201);

    const [email] = await waitForEmails(uid, 1);
    expect(email).toBeDefined();
    expect(email.html).toContain('Harbor Legal Group at <strong>Harbor Legal Group</strong>');
    expect(email.html).not.toContain(ownerName);
  });
});

describe('the per-conversation cooldown', () => {
  it('mails the client once when two messages arrive after the cooldown expired', async () => {
    const uid = await freshClient();
    const opener = await owner.api.post(M('/send')).send({ clientId: uid, content: 'Opener' });
    expect(opener.status).toBe(201);
    expect(await waitForEmails(uid, 1)).toHaveLength(1);
    await testPool.query(
      `update conversations set last_notification_email_at = now() - interval '2 hours' where id = $1`,
      [opener.body.conversationId],
    );

    const gate = gateMethod(msgRepo, 'sendMessage');
    try {
      const a = owner.api.post(M('/send')).send({ clientId: uid, content: 'First of two' });
      const b = owner.api.post(M('/send')).send({ clientId: uid, content: 'Second of two' });
      const both = Promise.all([a, b]);
      await gate.arrived(2);
      gate.open();
      const [resA, resB] = await both;
      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
    } finally {
      gate.restore();
    }
    await drainEvents();

    // The opener's email plus exactly one for the pair.
    expect(await waitForEmails(uid, 3)).toHaveLength(2);
  });
});
