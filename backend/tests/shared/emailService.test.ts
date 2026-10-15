/**
 * Everything `sendEmail` does between a caller asking for a message and the
 * message reaching the wire.
 *
 * The harness replaces the RESEND TRANSPORT, not `sendEmail`, so all of it runs
 * for real here: the firm-level notification switch, the per-recipient daily
 * cap, the CAN-SPAM footer and the List-Unsubscribe header. A suite that mocked
 * `sendEmail` would delete exactly the parts worth testing and leave only the
 * HTML builders.
 *
 * Every case asks the same question - who was actually told - because that is
 * the only thing these controls change. A suppression returns
 * `{ sent: false, suppressed: true }`, but a caller that stopped calling the
 * gate would also return `{ sent: true }` and mail the person anyway, so the
 * return value is the weaker assertion of the two.
 *
 * WHERE SUPPRESSION IS PROVEN, SOMETHING ELSE IS PROVEN DELIVERED in the same
 * case. An empty outbox is the same shape whether the gate worked or the send
 * never happened, so each negative is paired with a positive from the same run.
 *
 * NOTE ON SCOPE: there is no send-time recipient allowlist in this codebase.
 * `shared/utils/emailWhitelist.ts` is the email-VERIFICATION whitelist (which
 * accounts may skip verifying their address), and it is never consulted by
 * `sendEmail`. Nothing here pretends otherwise.
 */
import {
  testPool,
  createFirm,
  emailsMatching,
  recipientsOf,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

// Required after the harness import so the transport mock is registered first.
const emailService = require('../../src/shared/services/emailService');
const { EMAIL_CATEGORIES } = require('../../src/shared/services/emailPreferences');
const { pool } = require('../../src/shared/database/db');

it('forwards a stable provider retry key while distinguishing changed email content', async () => {
  const message = {
    to: 'retry@example.test', recipientName: 'Member', taskTitle: 'File response',
    dueDate: 'September 5', reminderType: 'due_today', idempotencyKey: 'task-reminder/delivery/0',
  };
  const first = await emailService.sendTaskDueReminderEmail(message);
  const retry = await emailService.sendTaskDueReminderEmail(message);
  const changed = await emailService.sendTaskDueReminderEmail({ ...message, taskTitle: 'File appeal' });
  expect([first.sent, retry.sent, changed.sent]).toEqual([true, true, true]);
  const { sentEmails } = require('../support/setupInProcess');
  const emails = sentEmails();
  expect(emails).toHaveLength(3);
  expect(emails[0].idempotencyKey).toMatch(/^task-reminder\/delivery\/0\/[a-f0-9]{64}$/);
  expect(emails[1].idempotencyKey).toBe(emails[0].idempotencyKey);
  expect(emails[2].idempotencyKey).not.toBe(emails[0].idempotencyKey);
});

/**
 * Deploy-time configuration, resolved here the same way the module resolves it.
 *
 * The exact strings are not the behaviour under test; their PRESENCE in what a
 * recipient receives is. Reading them from the environment keeps these cases
 * honest on a machine that has set them.
 */
const CAP = Number(process.env.EMAIL_MAX_PER_RECIPIENT_PER_DAY || 100);
const POSTAL_ADDRESS = process.env.COMPANY_POSTAL_ADDRESS
  || 'Paralegix, [physical mailing address not set]';
const PREFERENCES_URL = `${(process.env.APP_URL || 'https://paralegix.com').replace(/\/+$/, '')}/account`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@paralegix.com';

let counter = 0;
/** A unique subject per send, so `recipientsOf` answers about one message. */
const subjectFor = (label: string) => {
  counter += 1;
  return `[case ${counter}] ${label}`;
};
/** A unique address per case, so one case's cap counter never reaches another. */
const addressFor = (label: string) => {
  counter += 1;
  return `${label}-${counter}@recipient.test`;
};

/** Turn a firm's master email switch off. */
async function disableFirmEmail(lawFirmId: string) {
  const res = await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
                       || '{"emailNotificationsEnabled": false}'::jsonb
      where id = $1`,
    [lawFirmId],
  );
  expect(res.rowCount).toBe(1);
}

/**
 * Put a recipient's daily counter at an exact value.
 *
 * The cap is backed by the shared `rate_limits` table under the key
 * `email-daily:<lowercased address>`. Seeding it beats sending a hundred real
 * messages, and it puts the boundary cases exactly on the boundary rather than
 * near it.
 */
async function seedDailyCounter(address: string, hits: number, window: 'active' | 'expired') {
  const res = await testPool.query(
    `insert into rate_limits (key, hits, expires_at) values ($1, $2, now() + $3::interval)`,
    [`email-daily:${address.toLowerCase()}`, hits, window === 'active' ? '12 hours' : '-1 hour'],
  );
  expect(res.rowCount).toBe(1);
}

const dailyHits = async (address: string) => {
  const { rows } = await testPool.query(
    'select hits from rate_limits where key = $1',
    [`email-daily:${address.toLowerCase()}`],
  );
  return rows[0] ? Number(rows[0].hits) : null;
};

/** A minimal gated message. `message` is a category a recipient may turn off. */
const gatedMessage = (to: string, subject: string, lawFirmId: string) => ({
  to,
  subject,
  html: '<html><body><p>Body</p></body></html>',
  text: 'Body',
  lawFirmId,
  category: EMAIL_CATEGORIES.MESSAGE,
});

describe('the firm notification switch', () => {
  let firmOff: Firm;
  let firmOn: Firm;

  beforeEach(async () => {
    firmOff = await createFirm();
    firmOn = await createFirm();
    await disableFirmEmail(firmOff.id);
  });

  it('suppresses mail for the firm that turned it off and not for the firm next door', async () => {
    const subject = subjectFor('Matter update');
    const mutedRecipient = addressFor('muted');
    const otherRecipient = addressFor('other');

    await emailService.sendEmail(gatedMessage(mutedRecipient, subject, firmOff.id));
    await emailService.sendEmail(gatedMessage(otherRecipient, subject, firmOn.id));

    // The switch is one firm's setting. A gate that read a global flag, or read
    // the wrong firm's row, would either mail a firm that opted out or mute a
    // firm that never did - and the second failure is invisible, because nobody
    // reports mail they did not receive.
    expect(recipientsOf(subject)).toEqual([otherRecipient]);
  });

  it('still sends a transactional category from a firm that turned mail off', async () => {
    const subject = subjectFor('You have been invited');
    const recipient = addressFor('invitee');

    await emailService.sendEmail({
      ...gatedMessage(recipient, subject, firmOff.id),
      category: EMAIL_CATEGORIES.INVITATION,
    });

    // Invitations, receipts and signing requests are how a person gets into the
    // product or proves they paid. A firm muting its notifications must not
    // silently strand the people it is inviting.
    expect(recipientsOf(subject)).toEqual([recipient]);
  });
});

describe('the per-recipient daily cap', () => {
  it('admits exactly one overlapping send for the last slot despite address casing', async () => {
    const address = addressFor('race');
    await seedDailyCounter(address, CAP - 1, 'active');
    const subject = subjectFor('overlapping sends');
    const gate = gateMethod(pool, 'query');
    const first = emailService.sendEmail({ to: address, subject, text: 'First' });
    const second = emailService.sendEmail({ to: address.toUpperCase(), subject, text: 'Second' });
    try {
      await gate.arrived(2);
      expect(gate.waiting()).toBe(2);
      gate.open();
      const results = await Promise.all([first, second]);
      expect(results.filter((result) => result.sent)).toHaveLength(1);
      expect(results.filter((result) => result.throttled)).toHaveLength(1);
      expect(emailsMatching(subject)).toHaveLength(1);
      expect(recipientsOf(subject).map((recipient) => recipient.toLowerCase())).toEqual([address]);
      expect(await dailyHits(address)).toBe(CAP + 1);
    } finally { gate.restore(); await Promise.allSettled([first, second]); }
  });
  it('allows the send that lands exactly on the cap', async () => {
    const subject = subjectFor('Last one through');
    const recipient = addressFor('atlimit');
    await seedDailyCounter(recipient, CAP - 1, 'active');

    await emailService.sendEmail({ to: recipient, subject, html: '<p>Body</p>', text: 'Body' });

    // The cap is a ceiling, not a fence one short of it. An off-by-one here
    // drops a legitimate message for every high-volume recipient on the last
    // send of their day.
    expect(recipientsOf(subject)).toEqual([recipient]);
    expect(await dailyHits(recipient)).toBe(CAP);
  });

  it('stops the next send to that address, and only that address', async () => {
    const cappedSubject = subjectFor('Blocked');
    const freeSubject = subjectFor('Unaffected');
    const capped = addressFor('capped');
    const free = addressFor('free');
    await seedDailyCounter(capped, CAP, 'active');

    await emailService.sendEmail({ to: capped, subject: cappedSubject, html: '<p>x</p>', text: 'x' });
    await emailService.sendEmail({ to: free, subject: freeSubject, html: '<p>x</p>', text: 'x' });

    // The cap has to actually stop a send, not merely count it: it is the last
    // line against an inbox being mail-bombed through the public, unauthenticated
    // endpoints that trigger mail. The second address proves the transport was
    // working throughout, and that the counter is keyed per recipient rather
    // than shared.
    expect(recipientsOf(cappedSubject)).toEqual([]);
    expect(recipientsOf(freeSubject)).toEqual([free]);
  });

  it('lets a recipient through again once their 24 hour window has passed', async () => {
    const subject = subjectFor('New day');
    const recipient = addressFor('yesterday');
    await seedDailyCounter(recipient, CAP + 5, 'expired');

    await emailService.sendEmail({ to: recipient, subject, html: '<p>x</p>', text: 'x' });

    // A DAILY cap that never resets is a permanent ban. The upsert restarts the
    // window at one hit rather than carrying yesterday's total forward.
    expect(recipientsOf(subject)).toEqual([recipient]);
    expect(await dailyHits(recipient)).toBe(1);
  });

  it('drops a multi-recipient message entirely when one address is capped', async () => {
    const sharedSubject = subjectFor('Sent to two');
    const soloSubject = subjectFor('Sent to one');
    const capped = addressFor('capped');
    const clean = addressFor('clean');
    await seedDailyCounter(capped, CAP, 'active');

    await emailService.sendEmail({
      to: [capped, clean], subject: sharedSubject, html: '<p>x</p>', text: 'x',
    });
    await emailService.sendEmail({
      to: [clean], subject: soloSubject, html: '<p>x</p>', text: 'x',
    });

    // One Resend call carries every address on it, so a capped recipient cannot
    // be dropped from the list without splitting the send. The whole message is
    // refused instead. The second send proves the clean address was deliverable,
    // which is what makes the first assertion mean anything.
    expect(recipientsOf(sharedSubject)).toEqual([]);
    expect(recipientsOf(soloSubject)).toEqual([clean]);
  });
});

describe('the compliance footer a client receives', () => {
  const invite = (recipientEmail: string) => emailService.sendClientInvitationEmail({
    recipientEmail,
    lawFirmName: 'Hartley & Vance',
    inviterName: 'Dana Hartley',
    isExistingUser: false,
    inviteUrl: 'https://app.paralegix.test/invite/abc',
  });

  const invitationSubject = "Hartley & Vance has invited you to their client portal";

  it('carries the postal address and preferences link inside the message body', async () => {
    const recipient = addressFor('client');

    await invite(recipient);

    const [message] = emailsMatching(invitationSubject);
    expect(message).toBeDefined();
    expect(message.to).toBe(recipient);
    // CAN-SPAM requires the sender's physical address and a way to opt out on
    // commercial mail, and a client portal invitation is the most externally
    // visible mail this product sends. The footer is appended by `sendEmail`, so
    // it rides on every sender rather than being remembered per template.
    expect(message.html).toContain(POSTAL_ADDRESS);
    expect(message.html).toContain(PREFERENCES_URL);
    // Inside the document, not bolted on after it. Markup past </body> is at the
    // mercy of the reading client and several drop it outright.
    expect(message.html!.indexOf(POSTAL_ADDRESS)).toBeLessThan(message.html!.indexOf('</body>'));
  });

  it('carries the same footer on the plain-text part', async () => {
    const recipient = addressFor('client');

    await invite(recipient);

    const [message] = emailsMatching(invitationSubject);
    expect(message).toBeDefined();
    // The text/plain alternative is what a text-only reader and most spam
    // filters see. A footer present only in the HTML satisfies neither.
    expect(message.text).toContain(POSTAL_ADDRESS);
    expect(message.text).toContain(PREFERENCES_URL);
  });

  it('sets a List-Unsubscribe header offering both a mailbox and a link', async () => {
    const recipient = addressFor('client');

    await invite(recipient);

    const [message] = emailsMatching(invitationSubject);
    expect(message).toBeDefined();
    // Mailbox providers read this header to render their own unsubscribe
    // control, and its absence measurably costs deliverability for the whole
    // sending domain - every firm's mail, not just this message.
    expect(message.headers!['List-Unsubscribe'])
      .toBe(`<mailto:${SUPPORT_EMAIL}>, <${PREFERENCES_URL}>`);
  });
});
