/**
 * INVOICE_PAYMENT_RECEIVED: the firm-admin "payment received" email fan-out in
 * `stripe.events.ts`.
 *
 * WHAT IS PINNED, AND WHAT BREAKS EACH CASE
 *
 *   1. Recipients. Every owner/admin/partner of THIS firm gets exactly one email;
 *      a member with an ordinary role and another firm's owner get none. Breaks if
 *      `getFirmAdminRecipients` loses its role filter or its tenant scope, or if
 *      the fan-out drops or duplicates a recipient.
 *
 *   2. Bound. At most three sends are in flight at once, because each send runs a
 *      recipient-cap query against the small shared pool. Breaks if the fan-out
 *      goes back to an unbounded `Promise.all` (five in flight here).
 *
 *   3. One failing send. The handler logs its error and the other admins are
 *      still emailed, which is what the original `Promise.all` did: every send
 *      had already started, and the rejection only reached the handler's catch.
 *      Breaks if a failure starts suppressing the remaining sends or escapes the
 *      handler unlogged.
 *
 * THE SEAM
 * `sendEmail` never rejects on its own (the cap check and the transport call
 * both catch), so the only way to hold a send open or make one fail is to wrap
 * the export the listener calls. The wrapper delegates to the REAL function, so
 * the cap check, the template and the captured Resend payload all still run.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  drainEvents,
  resetEmails,
  recipientsOf,
  type Firm,
} from '../support/setupInProcess';

const mockSendControl = {
  delayMs: 0,
  failFor: null as string | null,
  inFlight: 0,
  peak: 0,
  calls: [] as Promise<unknown>[],
};

jest.mock('../../src/shared/services/emailService', () => {
  const actual = jest.requireActual('../../src/shared/services/emailService');
  return {
    ...actual,
    sendPaymentReceivedNotificationEmail: (args: any) => {
      const run = (async () => {
        mockSendControl.inFlight += 1;
        mockSendControl.peak = Math.max(mockSendControl.peak, mockSendControl.inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, mockSendControl.delayMs));
          if (mockSendControl.failFor && args?.to === mockSendControl.failFor) {
            throw new Error(`transport refused ${args.to}`);
          }
          return await actual.sendPaymentReceivedNotificationEmail(args);
        } finally {
          mockSendControl.inFlight -= 1;
        }
      })();
      mockSendControl.calls.push(run.catch(() => undefined));
      return run;
    },
  };
});

// Registered after the harness so the event drain wraps this listener.
require('../../src/modules/stripe/stripe.events');
const eventBus = require('../../src/shared/events/eventBus');
const { INVOICE_PAYMENT_RECEIVED } = require('../../src/shared/events/eventTypes');

const INVOICE_NAME = 'INV-4471';
const SUBJECT = `Payment received: Invoice #${INVOICE_NAME}`;

let firm: Firm;
let eligible: string[];
let associateEmail: string;
let foreignOwnerEmail: string;

async function emailOf(uid: string): Promise<string> {
  const { rows } = await testPool.query('select email from users where id = $1', [uid]);
  expect(rows[0]?.email).toBeTruthy();
  return rows[0].email;
}

/** A non-owner member whose role carries `roleName`. */
async function memberWithRoleName(lawFirmId: string, roleName: string): Promise<string> {
  const member = await createFirmMember(lawFirmId, { isOwner: false });
  const res = await testPool.query('update roles set name = $1 where id = $2', [roleName, member.roleId]);
  expect(res.rowCount).toBe(1);
  return emailOf(member.uid);
}

async function emitPaymentReceived(lawFirmId: string) {
  eventBus.emit(INVOICE_PAYMENT_RECEIVED, {
    lawFirmId,
    invoiceId: randomUUID(),
    amountPaidCents: 12_345,
    invoiceName: INVOICE_NAME,
    source: 'manual',
  });
  await drainEvents();
  // The handler can return before a send it started has settled (a rejected
  // batch reaches its catch first), so wait for every wrapped send as well.
  await Promise.all(mockSendControl.calls);
}

let consoleError: jest.SpyInstance;

beforeEach(async () => {
  Object.assign(mockSendControl, { delayMs: 0, failFor: null, inFlight: 0, peak: 0, calls: [] });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  firm = await createFirm();
  const owner = await ownerOf(firm.id);
  eligible = [
    await emailOf(owner.uid),
    await memberWithRoleName(firm.id, 'Admin'),
    await memberWithRoleName(firm.id, 'PARTNER'),
    await memberWithRoleName(firm.id, 'Owner'),
    await memberWithRoleName(firm.id, 'admin'),
  ];
  associateEmail = await memberWithRoleName(firm.id, 'Associate');

  const otherFirm = await createFirm();
  foreignOwnerEmail = await emailOf((await ownerOf(otherFirm.id)).uid);

  await drainEvents();
  resetEmails();
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('INVOICE_PAYMENT_RECEIVED admin emails', () => {
  it('emails every owner, admin and partner of the firm exactly once, and nobody else', async () => {
    await emitPaymentReceived(firm.id);

    const recipients = recipientsOf(SUBJECT);
    expect([...recipients].sort()).toEqual([...eligible].sort());
    expect(recipients).not.toContain(associateEmail);
    expect(recipients).not.toContain(foreignOwnerEmail);
  });

  it('never has more than three sends in flight at once', async () => {
    mockSendControl.delayMs = 40;

    await emitPaymentReceived(firm.id);

    expect([...recipientsOf(SUBJECT)].sort()).toEqual([...eligible].sort());
    // At least two proves the sends overlap, so the cap below is measured.
    expect(mockSendControl.peak).toBeGreaterThanOrEqual(2);
    expect(mockSendControl.peak).toBeLessThanOrEqual(3);
  });

  it('logs a failed send and still emails every other admin', async () => {
    const failing = eligible[1];
    mockSendControl.failFor = failing;

    await emitPaymentReceived(firm.id);

    const expected = eligible.filter((email) => email !== failing).sort();
    expect([...recipientsOf(SUBJECT)].sort()).toEqual(expected);
    expect(consoleError).toHaveBeenCalledWith(
      '[stripe.events] INVOICE_PAYMENT_RECEIVED handler error:',
      `transport refused ${failing}`,
    );
  });
});
