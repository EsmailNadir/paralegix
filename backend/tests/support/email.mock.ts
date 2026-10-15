/**
 * Captures outbound email instead of sending it.
 *
 * The mock sits at the TRANSPORT, replacing the `resend` package, not at
 * `sendEmail`. That matters. `sendEmail` is where the firm-level notification
 * toggle is honoured (`isFirmEmailEnabled`) and where the per-recipient daily
 * cap is enforced, and both are behaviour a suite should be able to assert.
 * Mocking `sendEmail` would delete them and leave only the typed helpers under
 * test. Mocking the transport keeps the entire path real, right down to the
 * compliance footer and the List-Unsubscribe header, and captures the payload
 * that would have gone over the wire.
 *
 * RESEND_API_KEY must be set for any of this to run: with no key, `initResend()`
 * leaves `emailReady` false and `sendEmail` returns `{ sent: false }` before it
 * reaches either check. `installEmailCapture()` sets a dummy key for that reason.
 */

export interface CapturedEmail {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: unknown[];
  reply_to?: string;
  idempotencyKey?: string;
}

const outbox: CapturedEmail[] = [];
let nextRejection: string | undefined;
let heldSend: { arrive: () => void; released: Promise<void> } | undefined;

/** Refuse the next provider request without recording a delivered message. */
export function rejectNextEmail(message: string): void {
  nextRejection = message;
}

/**
 * Pause the next provider request until `release` is called. `arrived`
 * resolves once that request is inside the transport, which is the moment a
 * spec can look at what the sender has, or has not, committed.
 */
export function holdNextEmail(): { arrived: Promise<void>; release: () => void } {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  heldSend = { arrive, released };
  return { arrived, release };
}

/**
 * Register the mock. Like the Firebase mock, this MUST run before the spec
 * imports anything that reaches `src/`.
 */
export function installEmailCapture(): void {
  // A value is required, not a valid one. Nothing in the mocked transport reads
  // it; it exists so `emailReady` flips true and the real send path executes.
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

  jest.mock('resend', () => ({
    Resend: class {
      emails = {
        send: async (payload: CapturedEmail, options?: { idempotencyKey?: string }) => {
          if (heldSend) {
            const held = heldSend;
            heldSend = undefined;
            held.arrive();
            await held.released;
          }
          if (nextRejection) {
            const message = nextRejection;
            nextRejection = undefined;
            return { data: null, error: { message } };
          }
          outbox.push(options?.idempotencyKey ? { ...payload, idempotencyKey: options.idempotencyKey } : payload);
          return { data: { id: `captured-${outbox.length}` }, error: null };
        },
      };
    },
  }));
}

/** Every message that reached the transport since the last reset, in order. */
export function sentEmails(): CapturedEmail[] {
  return outbox;
}

/** The messages whose subject matches, for the common "was this sent" assertion. */
export function emailsMatching(subject: string | RegExp): CapturedEmail[] {
  const matches = (s: string) => (typeof subject === 'string' ? s.includes(subject) : subject.test(s));
  return outbox.filter((m) => matches(m.subject || ''));
}

/**
 * Flattened recipient addresses for the messages whose subject matches.
 *
 * This is the shape most organization assertions want: "who was told about the
 * invoice", where the answer must exclude a roster member without
 * `can_view_billing`.
 */
export function recipientsOf(subject: string | RegExp): string[] {
  return emailsMatching(subject)
    .flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]))
    .filter(Boolean);
}

export function resetEmails(): void {
  outbox.length = 0;
  nextRejection = undefined;
  heldSend = undefined;
}
