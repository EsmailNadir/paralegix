/**
 * B02.3, last bullet: "Malformed but unauthorized request: auth/permission
 * refusal still runs before sensitive validation or data lookup, without
 * asserting one global order between independent validation/timezone
 * middleware."
 *
 * `backend/AGENTS.md`'s Route Pattern section fixes half the middleware chain
 * as an invariant: `verifyToken` and `requirePermission` ALWAYS come before
 * `validate` (and `requireTimezone`, when present) - only the latter two are
 * free to swap. Every route file in this repo is hand-wired in that order, so
 * nothing here is expected to fail; this is a REGRESSION FENCE around an
 * invariant a future edit could break silently; moving `validate(...)` one
 * line earlier during a refactor is a one-line, easy-to-miss mistake, and its
 * consequence is a real security defect (a malformed field's validation
 * message, or a downstream existence lookup, answering BEFORE the caller has
 * been proven to belong to the firm at all).
 *
 * The proof needs a request that is BOTH unauthorized AND malformed at the
 * same time, so the two candidate refusals actually compete: the body is
 * missing a Zod-required field AND it names a real resource id that belongs
 * to a DIFFERENT firm (never a nonexistent id - a real one is the stronger
 * test, since a service-layer existence lookup would find it and could leak
 * a distinct error shape). If auth genuinely runs first, the malformed field
 * and the foreign id are never even reached: the response is the flat,
 * content-free `{ error, code, requestId }` refusal, not a 400 that echoes
 * which field was wrong or a lookup result that discloses the foreign row
 * exists.
 *
 * Three POST routes across three different modules, matching the plan's
 * ask for real coverage rather than one anecdote:
 *   - billing/invoices  (`billing.manageInvoices`)
 *   - tasks             (`tasks.create`)
 *   - messaging/send    (`messaging.send`)
 *
 * The caller is wrongly scoped: real and authenticated, but a member of a
 * DIFFERENT firm, so `requirePermission` must refuse with 403 FORBIDDEN,
 * "Not a member of this firm". The anonymous half (401 NO_TOKEN ahead of
 * everything) is owned by the route-catalog sweep in `anonymousCaller.test.ts`.
 *
 * Firm A owns the "foreign" matter and client referenced in every malformed
 * body; firm B is the target of the request. Firm A's owner is a real,
 * authenticated caller with zero standing in firm B.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firmA: Firm;
let ownerA: Actor;
let firmB: Firm;
let matterA: string;
let clientA: string;

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A (owns the foreign resources)' });
  ownerA = await ownerOf(firmA.id);
  firmB = await createFirm({ name: 'Firm B (target of every malformed request below)' });

  const matterRes = await ownerA.api
    .post(`/api/lawfirms/${firmA.id}/matters`)
    .send({ name: 'Firm A Confidential Matter' });
  expect(matterRes.status).toBe(201);
  matterA = matterRes.body.matterId;

  const client = await createPersonClient(firmA.id, {
    name: 'Firm A Confidential Client',
    email: 'confidential-client@example.test',
  });
  clientA = client.id;

  await drainEvents();
});

const FOREIGN_MATTER_LEAKS = ['Firm A Confidential Matter', 'matterId', 'invoiceName', 'title', 'required'];
const FOREIGN_CLIENT_LEAKS = ['Firm A Confidential Client', 'confidential-client@example.test', 'clientId', 'content'];

const CASES = [
  {
    // createInvoiceSchema requires `invoiceName`; the body omits it AND names
    // firm A's matter under firm B.
    name: 'billing/invoices, before Zod or the matter lookup run',
    suffix: '/billing/invoices',
    table: 'invoices',
    body: () => ({ matterId: matterA }),
    leaks: () => [matterA, ...FOREIGN_MATTER_LEAKS],
  },
  {
    // createTaskSchema requires `title`; the body omits it AND names firm A's
    // matter under firm B.
    name: 'tasks, before Zod or the matter lookup run',
    suffix: '/tasks',
    table: 'tasks',
    body: () => ({ matterId: matterA }),
    leaks: () => [matterA, ...FOREIGN_MATTER_LEAKS],
  },
  {
    // sendMessageSchema's superRefine requires non-empty content OR an
    // attachment; the body has neither AND names firm A's client under firm B.
    name: 'messaging/send, before Zod or the client lookup run',
    suffix: '/messaging/send',
    table: 'messages',
    body: () => ({ clientId: clientA, content: '' }),
    leaks: () => [clientA, ...FOREIGN_CLIENT_LEAKS],
  },
];

describe('B02.3: auth refusal beats validation and data lookup', () => {
  it.each(CASES)('wrongly-scoped caller (firm A owner, no standing in firm B): 403 on $name', async ({
    suffix, table, body, leaks,
  }) => {
    const res = await ownerA.api
      .post(`/api/lawfirms/${firmB.id}${suffix}`)
      .send(body());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.error).toBe('Not a member of this firm');
    // The "not a member" branch never attaches `.details` (only the
    // "member but missing permission" branch does, and only with the fixed,
    // non-leaking `requiredPermission` code list) - its presence here would
    // mean some OTHER check ran and decorated the error.
    expect(res.body.details).toBeUndefined();
    const raw = JSON.stringify(res.body ?? {});
    for (const needle of leaks()) {
      expect(raw).not.toContain(needle);
    }

    const { rows } = await testPool.query(`select id from ${table} where law_firm_id = $1`, [firmB.id]);
    expect(rows).toHaveLength(0);
  });
});
