/**
 * The PUBLIC intake surface: `/api/intake/:token`.
 *
 * Every other route in this application sits behind `verifyToken`. These three
 * do not. The token in the URL is the entire authorization, so the token checks
 * ARE the security boundary and each one is worth a case of its own.
 *
 * Two token spaces feed the same three routes, and they behave differently:
 *
 *   THE TEMPLATE'S `public_token` is a generic embed. Anyone holding it can
 *   open the form and submit, and the submission mints a NEW lead (or attaches
 *   to an existing one by email). `resolveToken` refuses an inactive template
 *   on this path, which is how a firm takes a public form down.
 *
 *   A SUBMISSION'S `token` is a per-recipient targeted send (see
 *   `tests/leads/intakeSend.test.ts` for how one is issued). It resolves to a
 *   pre-created row and a named lead, and it deliberately does NOT re-check the
 *   template's `is_active` flag, so a link already in someone's inbox keeps
 *   working after the firm retires the form.
 *
 * `tests/leads/intakeForms.test.ts` and `tests/leads/intakeSend.test.ts` cover
 * the FIRM side: creating templates, hiding the access-code hash from firm
 * members, minting and mailing a targeted link. Nothing covered the side a
 * prospective client actually touches, which is this one.
 *
 * Three things are pinned here that no screen shows:
 *
 *   WHAT THE PUBLIC PAYLOAD CONTAINS. The repository's `formatTemplate` carries
 *   `id`, `lawFirmId`, `publicToken`, `isActive`, `createdBy` and optionally
 *   `accessCodeHash`. The service hand-builds a much smaller object from it. If
 *   anyone ever spreads the template instead, the public page starts serving the
 *   firm's internal ids and the gate's own hash to the open internet, and it
 *   renders identically. The key sets below are enumerated exactly so that
 *   adding a field is a deliberate decision.
 *
 *   THE ACCESS-CODE GATE, on both the read and the write path. It is checked
 *   twice, independently: `getIntakeForm` withholds the fields, and
 *   `submitIntake` re-checks the code carried in the body. The second check is
 *   the one that matters, because a caller can skip the read entirely and POST
 *   straight to `/submit`.
 *
 *   WHICH FIRM THE WRITE LANDS IN. The law firm is derived from the token, not
 *   from the URL, so an ordinary `:lawFirmId` scope test does not apply. The
 *   cross-firm cases below submit through one firm's token and re-read the
 *   OTHER firm's tables, because a correct-looking 201 proves nothing about
 *   where the row went.
 *
 * Fixtures are plain SQL. A form seeded through the firm-side create route
 * would share its bugs with the code under test, and the access-code cases in
 * particular need the stored hash to be at an exactly known value.
 *
 * NOT covered here: what the limiters DO. The harness sets
 * `RATE_LIMITS_DISABLED=true`, so `intakeReadLimiter`, `intakeGateLimiter` and
 * `intakeSubmitLimiter` are all inert here and
 * `tests/shared/rateLimiters.test.ts` owns their behaviour. WHICH of them each
 * route is mounted with is covered, because that is where the access-code gate's
 * brute-force hole actually lived.
 */
import { randomUUID, createHash } from 'crypto';

import {
  testPool,
  request,
  createFirm,
  type Firm,
} from '../support/setupInProcess';

/** Mirrors `hashAccessCode` in leads/intakeForms.repository.ts. */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const CODE = 'LETMEIN';
const WRONG = 'GUESSING';

/**
 * A realistic field set, shaped like `DEFAULT_INTAKE_FORM`. The types matter:
 * `email` drives the format check and the lead's address, `select` drives the
 * options check, and `textarea` is what gets folded into the lead's notes.
 */
const FIELDS = [
  { key: 'full_name', label: 'Full name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: false },
  {
    key: 'matter_type',
    label: 'What can we help you with?',
    type: 'select',
    required: true,
    options: ['Family Law', 'Estate Planning'],
  },
  { key: 'details', label: 'Tell us about your situation', type: 'textarea', required: false },
];

const ANSWERS = {
  full_name: 'Dana Reed',
  email: 'Dana.Reed@Example.Test',
  phone: '555-0134',
  matter_type: 'Family Law',
  details: 'Need help with a will.',
};

/** A prospective client arrives carrying nothing at all: no token, no headers. */
const visitor = () => request();

const getForm = (token: string) => visitor().get(`/api/intake/${token}`);
const verify = (token: string, body: unknown) => visitor().post(`/api/intake/${token}/verify-access-code`).send(body as never);
const submit = (token: string, body: unknown) => visitor().post(`/api/intake/${token}/submit`).send(body as never);

let firm: Firm;

async function seedTemplate(
  lawFirmId: string,
  overrides: {
    name?: string;
    fields?: unknown[];
    accessCode?: string | null;
    isActive?: boolean;
  } = {},
): Promise<{ id: string; name: string; publicToken: string }> {
  const id = randomUUID();
  const name = overrides.name ?? 'General Intake';
  const publicToken = `pt-${randomUUID()}`;
  const res = await testPool.query(
    `insert into intake_form_templates
       (id, law_firm_id, name, public_token, fields, access_code_hash, is_active)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      id, lawFirmId, name, publicToken,
      JSON.stringify(overrides.fields ?? FIELDS),
      overrides.accessCode ? sha256(overrides.accessCode) : null,
      overrides.isActive ?? true,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, name, publicToken };
}

async function seedLead(
  lawFirmId: string,
  overrides: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    organization?: string | null;
    notes?: string | null;
    stageId?: string | null;
  } = {},
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = overrides.name ?? 'Prospective Client';
  const res = await testPool.query(
    `insert into leads (id, law_firm_id, name, email, phone, organization, notes, stage_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id, lawFirmId, name,
      overrides.email ?? null,
      overrides.phone ?? null,
      overrides.organization ?? null,
      overrides.notes ?? null,
      overrides.stageId ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, name };
}

async function seedSubmission(
  lawFirmId: string,
  templateId: string,
  overrides: {
    leadId?: string | null;
    status?: string;
    sentToEmail?: string | null;
    openedAt?: string | null;
  } = {},
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = `st-${randomUUID()}`;
  const res = await testPool.query(
    `insert into intake_submissions
       (id, law_firm_id, intake_form_template_id, token, status, lead_id, sent_to_email, sent_at, opened_at)
     values ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
    [
      id, lawFirmId, templateId, token,
      overrides.status ?? 'sent',
      overrides.leadId ?? null,
      overrides.sentToEmail ?? null,
      overrides.openedAt ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, token };
}

async function seedStage(
  lawFirmId: string,
  overrides: { name?: string; sortOrder?: number; isClosed?: boolean } = {},
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = overrides.name ?? 'New';
  const res = await testPool.query(
    `insert into lead_stages (id, law_firm_id, name, sort_order, is_closed)
     values ($1, $2, $3, $4, $5)`,
    [id, lawFirmId, name, overrides.sortOrder ?? 0, overrides.isClosed ?? false],
  );
  expect(res.rowCount).toBe(1);
  return { id, name };
}

async function submissionRows(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select id, intake_form_template_id, token, field_values, status, lead_id,
            sent_to_email, submitted_ip, opened_at, completed_at
       from intake_submissions where law_firm_id = $1 order by created_at asc`,
    [lawFirmId],
  );
  return rows;
}

async function leadRows(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select id, name, email, phone, organization, notes, stage_id
       from leads where law_firm_id = $1 order by created_at asc`,
    [lawFirmId],
  );
  return rows;
}

async function openedAtOf(submissionId: string): Promise<Date | null> {
  const { rows } = await testPool.query(
    'select opened_at from intake_submissions where id = $1',
    [submissionId],
  );
  return rows[0]?.opened_at ?? null;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Harper & Vance LLP' });
});

// ---------------------------------------------------------------------------
// GET /api/intake/:token
// ---------------------------------------------------------------------------

describe('GET /:token: opening the form', () => {
  it('serves the form for a live template token', async () => {
    const template = await seedTemplate(firm.id);

    const res = await getForm(template.publicToken);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('General Intake');
    expect(res.body.lawFirmName).toBe('Harper & Vance LLP');
    expect(res.body.fields).toEqual(FIELDS);
  });

  it('answers not-found for a token nobody issued', async () => {
    // The token IS the authorization. A lookup that matched loosely, or that
    // fell back to "any template" when the token missed, would hand the first
    // firm in the table to anyone who typed a URL.
    const res = await getForm(`pt-${randomUUID()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/intake form not found/i);
  });

  it('answers not-found for a DEACTIVATED template', async () => {
    const live = await seedTemplate(firm.id, { name: 'Live' });
    const retired = await seedTemplate(firm.id, { name: 'Retired', isActive: false });

    // The live form is fetched first so the refusal below cannot pass because
    // the route is broken for every token.
    expect((await getForm(live.publicToken)).status).toBe(200);

    const res = await getForm(retired.publicToken);

    // Turning `is_active` off is the only way a firm takes a public embed down
    // without regenerating the token. A 200 here means the "off" switch is
    // decorative and the form keeps collecting answers.
    expect(res.status).toBe(404);
  });

  it('rejects an absurdly long token before it reaches the database', async () => {
    const res = await getForm('x'.repeat(201));

    // `tokenParams` caps the token at 200 characters. This is the only bound on
    // what an anonymous caller can push into a token lookup.
    expect(res.status).toBe(400);
  });

  it('lets a token of exactly 200 characters through to the lookup', async () => {
    // The boundary from below: past validation, and simply not found.
    const res = await getForm('x'.repeat(200));

    expect(res.status).toBe(404);
  });
});

describe('GET /:token: what the public payload exposes', () => {
  it('returns EXACTLY name, lawFirmName, fields and prefill', async () => {
    const template = await seedTemplate(firm.id);

    const res = await getForm(template.publicToken);

    // Enumerated rather than spot-checked. The template row this is built from
    // carries the firm id, the template id, the public token and the access-code
    // hash, and the service hand-picks four keys out of it. Anyone who replaces
    // that with a spread makes this go red, which is the entire point: the page
    // would look identical and be serving the gate's own hash.
    expect(Object.keys(res.body).sort()).toEqual(['fields', 'lawFirmName', 'name', 'prefill']);
  });

  it('leaks no firm-internal identifier anywhere in the response', async () => {
    const template = await seedTemplate(firm.id, { accessCode: null });

    const res = await getForm(template.publicToken);

    // Serialized and searched, so a value nested inside `fields` or `prefill`
    // is caught too, not just a top-level key.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(firm.id);
    expect(serialized).not.toContain(template.id);
    expect(serialized).not.toContain(template.publicToken);
  });

  it('has a null prefill for a generic embed', async () => {
    const template = await seedTemplate(firm.id);

    // A generic embed has no recipient, so there is nobody to prefill for.
    // A non-null prefill here would mean the page is showing one visitor a
    // previous visitor's name and address.
    expect((await getForm(template.publicToken)).body.prefill).toBeNull();
  });

  it('prefills the recipient on a targeted send', async () => {
    const template = await seedTemplate(firm.id);
    const lead = await seedLead(firm.id, { name: 'Dana Reed', email: 'dana@old.test' });
    const sent = await seedSubmission(firm.id, template.id, {
      leadId: lead.id,
      sentToEmail: 'dana@new.test',
    });

    const res = await getForm(sent.token);

    expect(res.status).toBe(200);
    // The address the form was SENT to wins over the address on the lead row.
    // The recipient is the person reading the page, and showing them an old
    // address they no longer use is how a submission comes back unmatched.
    expect(res.body.prefill).toEqual({ name: 'Dana Reed', email: 'dana@new.test' });
  });

  it('exposes no submission internals on a targeted send', async () => {
    const template = await seedTemplate(firm.id);
    const lead = await seedLead(firm.id, { name: 'Dana Reed' });
    const sent = await seedSubmission(firm.id, template.id, { leadId: lead.id });

    const res = await getForm(sent.token);

    expect(Object.keys(res.body).sort()).toEqual(['fields', 'lawFirmName', 'name', 'prefill']);
    const serialized = JSON.stringify(res.body);
    // The submission's own token would be a self-disclosure of no consequence,
    // but the lead id and the firm id are internal handles, and `submitted_ip`
    // on a re-opened link is another person's address.
    expect(serialized).not.toContain(lead.id);
    expect(serialized).not.toContain(sent.id);
    expect(serialized).not.toContain(firm.id);
  });

  it('reports a completed send as done, without the fields', async () => {
    const template = await seedTemplate(firm.id);
    const done = await seedSubmission(firm.id, template.id, { status: 'completed' });

    const res = await getForm(done.token);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['alreadyCompleted', 'lawFirmName', 'name']);
    expect(res.body.alreadyCompleted).toBe(true);
  });

  it('CHARACTERISATION: a targeted link outlives its template being retired', async () => {
    const template = await seedTemplate(firm.id, { isActive: false });
    const sent = await seedSubmission(firm.id, template.id);

    const res = await getForm(sent.token);

    // 200, unlike the public-token path, which 404s on the same template.
    // `resolveToken` only checks `is_active` when it resolved by PUBLIC token,
    // and `submitIntake` repeats that asymmetry (`!isActive && !submission`).
    // Recorded rather than changed: a link already sitting in a recipient's
    // inbox should not die because the firm stopped embedding the form on its
    // website. This goes red if someone "fixes" the asymmetry, which would be a
    // real behaviour change and would silently strand every link in flight.
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual(FIELDS);
  });
});

describe('GET /:token: the read-side access-code gate', () => {
  it('withholds the fields behind a code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await getForm(template.publicToken);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['lawFirmName', 'name', 'requiresAccessCode']);
    expect(res.body.requiresAccessCode).toBe(true);
  });

  it('the withheld fields are the ones the code unlocks', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const gated = await getForm(template.publicToken);
    const unlocked = await verify(template.publicToken, { code: CODE });

    // Proves the absence above is a refusal and not an empty form. Without the
    // second half, a template that simply had no fields would satisfy it.
    expect(gated.body.fields).toBeUndefined();
    expect(unlocked.body.fields).toEqual(FIELDS);
  });

  it('never puts the stored hash on the wire', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const gated = await getForm(template.publicToken);
    const unlocked = await verify(template.publicToken, { code: CODE });

    // `resolveToken` deliberately loads the template WITH `accessCodeHash`, so
    // the value is present in the object both responses are built from. A
    // SHA-256 of a short human-chosen code is trivially reversible, so shipping
    // it would be shipping the code itself.
    const hash = sha256(CODE);
    expect(JSON.stringify(gated.body)).not.toContain(hash);
    expect(JSON.stringify(unlocked.body)).not.toContain(hash);
  });

  it('does not stamp opened_at while the form is still locked', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });
    const sent = await seedSubmission(firm.id, template.id);

    await getForm(sent.token);

    // `opened_at` is what the firm reads as "the recipient has seen this".
    // A locked page shows the recipient nothing, so stamping it here would tell
    // the firm someone engaged when all that happened is a link preview or a
    // stranger hitting the URL.
    expect(await openedAtOf(sent.id)).toBeNull();
  });

  it('stamps opened_at once the code has been accepted', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });
    const sent = await seedSubmission(firm.id, template.id);

    await verify(sent.token, { code: CODE });

    expect(await openedAtOf(sent.id)).toBeInstanceOf(Date);
  });

  it('stamps opened_at on an ungated targeted link', async () => {
    const template = await seedTemplate(firm.id);
    const sent = await seedSubmission(firm.id, template.id);

    await getForm(sent.token);

    // The other side of the rule above: with no code in the way, the GET is the
    // moment the recipient actually sees the form.
    expect(await openedAtOf(sent.id)).toBeInstanceOf(Date);
  });

  it('does not move an opened_at that is already set', async () => {
    const template = await seedTemplate(firm.id);
    const first = new Date(Date.now() - 86_400_000).toISOString();
    const sent = await seedSubmission(firm.id, template.id, { openedAt: first });

    await getForm(sent.token);

    // `markOpened` filters on `opened_at is null`. Overwriting would turn "first
    // opened" into "last opened" and destroy the only engagement signal the
    // firm has on a link it cannot otherwise observe.
    expect((await openedAtOf(sent.id))?.toISOString()).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Which limiter guards which public route
// ---------------------------------------------------------------------------

describe('the limiters mounted on the public routes', () => {
  const intakeRouter = require('../../src/modules/intake/intake.routes');
  const {
    intakeReadLimiter,
    intakeGateLimiter,
    intakeSubmitLimiter,
  } = require('../../src/shared/middleware/rateLimiters');

  // The harness sets RATE_LIMITS_DISABLED, so no limiter can be shown to REJECT
  // from here (`tests/shared/rateLimiters.test.ts` owns that). What can be shown
  // is the wiring, which is where the defect actually lived: the gate and the
  // read shared one address-keyed limiter, and no behavioural test on either
  // route could see it.
  const handlersFor = (method: string, path: string) => {
    const layer = (intakeRouter as any).stack.find(
      (l: any) => l.route?.path === path && l.route?.methods?.[method],
    );
    expect(layer).toBeDefined();
    return layer.route.stack.map((s: any) => s.handle);
  };

  it('guards the access-code gate with the TOKEN-keyed limiter', () => {
    const handlers = handlersFor('post', '/:token/verify-access-code');

    expect(handlers).toContain(intakeGateLimiter);
    // NOT the read limiter. Keyed on the address, guessing was bounded per
    // caller, so rotating addresses bought unlimited attempts at a code a firm
    // member typed by hand.
    expect(handlers).not.toContain(intakeReadLimiter);
  });

  it('leaves the form READ on the address-keyed limiter', () => {
    const handlers = handlersFor('get', '/:token');

    // The other half of the fix, and the reason the gate got its own limiter
    // instead of a `keyBy` on this one: the public token is printed on websites
    // and in email footers, so a token-keyed cap here would let any anonymous
    // caller spend a firm's whole allowance and blank its intake page.
    expect(handlers).toContain(intakeReadLimiter);
    expect(handlers).not.toContain(intakeGateLimiter);
  });

  it('leaves submit on its own token-keyed limiter', () => {
    expect(handlersFor('post', '/:token/submit')).toContain(intakeSubmitLimiter);
  });
});

// ---------------------------------------------------------------------------
// POST /api/intake/:token/verify-access-code
// ---------------------------------------------------------------------------

describe('POST /:token/verify-access-code', () => {
  it('accepts the correct code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await verify(template.publicToken, { code: CODE });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.fields).toEqual(FIELDS);
  });

  it('refuses a wrong code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await verify(template.publicToken, { code: WRONG });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/incorrect access code/i);
  });

  it('returns no part of the form on a wrong code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await verify(template.publicToken, { code: WRONG });

    // The status alone is not the behaviour. A 403 that still carried `fields`
    // in its body would be a complete bypass for anything reading the response
    // rather than the status, which is every scripted caller.
    expect(res.body.fields).toBeUndefined();
    expect(res.body.verified).toBeUndefined();
  });

  it('refuses a code differing by one character', async () => {
    const template = await seedTemplate(firm.id, { accessCode: 'LETMEIN' });

    // Compared as SHA-256 digests through `timingSafeEqual`, so this cannot pass
    // by prefix or coercion. A near miss is what both a mistyping recipient and
    // a walking attacker actually send.
    expect((await verify(template.publicToken, { code: 'LETMEIM' })).status).toBe(403);
  });

  it('accepts a code with surrounding whitespace', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    // `verifyAccessCode` trims before hashing. Recorded because it differs from
    // the signing gate, which does not trim, and because a recipient pasting a
    // code out of an email is the normal case rather than the exception. Goes
    // red if the trim is dropped.
    expect((await verify(template.publicToken, { code: `  ${CODE}\n` })).status).toBe(200);
  });

  it('refuses to "verify" a form that has no code at all', async () => {
    const template = await seedTemplate(firm.id, { accessCode: null });

    const res = await verify(template.publicToken, { code: CODE });

    // Not 200. An ungated form is opened by holding the URL, and answering
    // `verified: true` here would let a caller manufacture an unlocked-looking
    // response for a form the firm never gated.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not require an access code/i);
  });

  it('rejects a request with no code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await verify(template.publicToken, {});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required|expected string/i);
  });

  it('rejects a non-string code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: '123456' });

    // 123456 as a NUMBER carries the same digits as the code. Zod's `z.string()`
    // stops it at the edge; without that, `hashAccessCode` would `String()` it
    // and a typed-wrong client would succeed by accident.
    expect((await verify(template.publicToken, { code: 123456 })).status).toBe(400);
  });

  it('answers not-found for a token nobody issued', async () => {
    const res = await verify(`pt-${randomUUID()}`, { code: CODE });

    expect(res.status).toBe(404);
  });

  it('answers not-found for a DEACTIVATED template', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE, isActive: false });

    // The gate must not be reachable on a form that is already off. Otherwise a
    // retired embed is still an oracle for guessing the code, which the firm
    // very likely reuses on the replacement form.
    expect((await verify(template.publicToken, { code: CODE })).status).toBe(404);
  });

  it('reports a completed send as done rather than reopening it', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });
    const done = await seedSubmission(firm.id, template.id, { status: 'completed' });

    const res = await verify(done.token, { code: CODE });

    expect(res.status).toBe(200);
    expect(res.body.alreadyCompleted).toBe(true);
    // The correct code does not un-complete a submission. Returning the fields
    // here would invite a second submit that the service then refuses anyway,
    // after the recipient has retyped everything.
    expect(res.body.fields).toBeUndefined();
  });

  it('CHARACTERISATION: no durable lockout; the only cap is the token-keyed limiter', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await verify(template.publicToken, { code: `${WRONG}${i}` })).status);
    }
    const after = await verify(template.publicToken, { code: CODE });

    // Twelve consecutive failures and the thirteenth request still works. The
    // signing gate counts failures on a durable column and locks; intake has no
    // such column.
    //
    // WHAT THIS CASE USED TO SAY, and why it changed: the gate shared
    // `intakeReadLimiter` with GET /:token, which is keyed on the ADDRESS, so a
    // caller with rotating addresses had no cap at all and this comment recorded
    // that outright. The gate now has its own `intakeGateLimiter`, keyed on the
    // URL token at 5/min, so guesses at one form share one bucket however they
    // are distributed (`tests/shared/rateLimiters.test.ts` proves the keying,
    // and the wiring section above proves this route is the one that gets it).
    //
    // What has NOT changed is the absence of a durable lock, and that is a
    // decision rather than an omission. Signing's lock lives on
    // `signature_participants`, so tripping it denies one named signer. The
    // intake code lives on the TEMPLATE and is shared by every recipient of the
    // form, so the same lock would let a stranger hard-lock a firm's whole lead
    // pipeline with a handful of wrong guesses. If one is ever wanted it belongs
    // on `intake_submissions`, the per-recipient analogue, and can only cover
    // targeted sends.
    //
    // The harness sets RATE_LIMITS_DISABLED, so the thirteen requests below are
    // measuring the SERVICE and nothing else: still no counter, still no lock.
    // Recorded, not asserted as correct. It goes red the day durable counters
    // are added, which is when someone should read this comment.
    expect(statuses).toEqual(Array(12).fill(403));
    expect(after.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/intake/:token/submit: generic embed
// ---------------------------------------------------------------------------

describe('POST /:token/submit: a generic embed', () => {
  it('records the submission against the right firm', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, { fieldValues: ANSWERS });

    expect(res.status).toBe(201);
    const rows = await submissionRows(firm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(res.body.id);
    expect(rows[0].intake_form_template_id).toBe(template.id);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).toBeInstanceOf(Date);
  });

  it('stores the answers keyed by field', async () => {
    const template = await seedTemplate(firm.id);

    await submit(template.publicToken, { fieldValues: ANSWERS });

    const [row] = await submissionRows(firm.id);
    // The values are trimmed but otherwise stored verbatim; only the derived
    // LEAD email is normalized. This is the firm's record of what the person
    // actually typed, so silent rewriting of it would be a evidentiary problem
    // as much as a data one.
    expect(row.field_values).toEqual(ANSWERS);
  });

  it('returns only the new id', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, { fieldValues: ANSWERS });

    // The service returns the whole formatted submission; the route picks one
    // key off it. A route that sent the object through would hand an anonymous
    // visitor the firm id, the lead id, the submission's own token, and the IP
    // recorded against it.
    expect(Object.keys(res.body)).toEqual(['id']);
  });

  it('records the submitter IP', async () => {
    const template = await seedTemplate(firm.id);

    await submit(template.publicToken, { fieldValues: ANSWERS });

    // The only forensic trace on an unauthenticated write. Nothing else on the
    // row says who sent it.
    expect((await submissionRows(firm.id))[0].submitted_ip).toBeTruthy();
  });

  it('creates a lead from the answers', async () => {
    const template = await seedTemplate(firm.id);

    await submit(template.publicToken, { fieldValues: ANSWERS });

    const leads = await leadRows(firm.id);
    expect(leads).toHaveLength(1);
    expect(leads[0].name).toBe('Dana Reed');
    // Normalized. The lead is looked up by lowercased email on the next
    // submission, so storing the typed casing would produce a duplicate lead
    // for the same person.
    expect(leads[0].email).toBe('dana.reed@example.test');
    expect(leads[0].phone).toBe('555-0134');
  });

  it('folds the free-text answers into the lead notes', async () => {
    const template = await seedTemplate(firm.id);

    await submit(template.publicToken, { fieldValues: ANSWERS });

    // A textarea answer has no column of its own. If it were not carried into
    // notes, the substance of what the prospect wrote would live only inside
    // the submission's jsonb and never appear on the lead the firm works from.
    expect((await leadRows(firm.id))[0].notes)
      .toBe('Tell us about your situation: Need help with a will.');
  });

  it('files the new lead in the first open stage', async () => {
    const template = await seedTemplate(firm.id);
    await seedStage(firm.id, { name: 'Closed Lost', sortOrder: 5, isClosed: true });
    const first = await seedStage(firm.id, { name: 'New', sortOrder: 0 });

    await submit(template.publicToken, { fieldValues: ANSWERS });

    // A lead with no stage does not appear on the pipeline board, so it is a
    // lead nobody works. The closed stage is seeded too, so a `getDefaultOpenStage`
    // that ignored `is_closed` would land the lead in "Closed Lost" and this
    // goes red rather than passing on a one-stage world.
    expect((await leadRows(firm.id))[0].stage_id).toBe(first.id);
  });

  it('attaches to an existing lead with the same email instead of duplicating', async () => {
    const template = await seedTemplate(firm.id);
    const existing = await seedLead(firm.id, { name: 'Dana Reed', email: 'dana.reed@example.test' });

    await submit(template.publicToken, { fieldValues: ANSWERS });

    const leads = await leadRows(firm.id);
    expect(leads).toHaveLength(1);
    expect(leads[0].id).toBe(existing.id);
    expect((await submissionRows(firm.id))[0].lead_id).toBe(existing.id);
  });

  it('fills only the blanks on an existing lead', async () => {
    const template = await seedTemplate(firm.id);
    await seedLead(firm.id, {
      name: 'Dana Reed',
      email: 'dana.reed@example.test',
      phone: '555-9999',
      organization: 'Reed Holdings',
    });

    await submit(template.publicToken, { fieldValues: ANSWERS });

    const [lead] = await leadRows(firm.id);
    // The firm-entered phone survives a submission carrying a different one.
    // A blanket overwrite would let anyone who knows a client's email address
    // rewrite that client's contact details from a public form.
    expect(lead.phone).toBe('555-9999');
    expect(lead.organization).toBe('Reed Holdings');
  });

  it('appends to existing notes rather than replacing them', async () => {
    const template = await seedTemplate(firm.id);
    await seedLead(firm.id, {
      name: 'Dana Reed',
      email: 'dana.reed@example.test',
      notes: 'Referred by Marta.',
    });

    await submit(template.publicToken, { fieldValues: ANSWERS });

    const [lead] = await leadRows(firm.id);
    // Notes are the one field a submission is allowed to add to a non-blank
    // value, so it is the one field where replacement would destroy the firm's
    // own writing.
    expect(lead.notes).toBe('Referred by Marta.\n\n--- Intake ---\nTell us about your situation: Need help with a will.');
  });

  it('refuses a submission carrying no email', async () => {
    const template = await seedTemplate(firm.id, {
      fields: [{ key: 'details', label: 'Details', type: 'textarea', required: true }],
    });

    const res = await submit(template.publicToken, { fieldValues: { details: 'Hello' } });

    // A generic embed has no recipient, so the email is the only thing that
    // identifies who submitted. Without it the firm gets an anonymous lead it
    // cannot answer.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email address is required/i);
    expect(await submissionRows(firm.id)).toHaveLength(0);
    expect(await leadRows(firm.id)).toHaveLength(0);
  });

  it('ignores answers to fields the template does not declare', async () => {
    const template = await seedTemplate(firm.id, {
      fields: [{ key: 'details', label: 'Details', type: 'textarea', required: true }],
    });

    const res = await submit(template.publicToken, {
      fieldValues: { details: 'Hello', email: 'smuggled@example.test', full_name: 'Nobody' },
    });

    // The undeclared `email` is dropped by `validateFieldValues`, which walks the
    // TEMPLATE's fields rather than the submitted keys, so the request fails for
    // want of an email. That filtering is what stops an anonymous caller writing
    // arbitrary keys into a firm's `field_values` jsonb.
    expect(res.status).toBe(400);
    expect(await submissionRows(firm.id)).toHaveLength(0);
  });

  it('answers not-found for a token nobody issued', async () => {
    const res = await submit(`pt-${randomUUID()}`, { fieldValues: ANSWERS });

    expect(res.status).toBe(404);
    expect(await submissionRows(firm.id)).toHaveLength(0);
  });

  it('answers not-found for a DEACTIVATED template', async () => {
    const live = await seedTemplate(firm.id, { name: 'Live' });
    const retired = await seedTemplate(firm.id, { name: 'Retired', isActive: false });

    expect((await submit(live.publicToken, { fieldValues: ANSWERS })).status).toBe(201);

    const res = await submit(retired.publicToken, {
      fieldValues: { ...ANSWERS, email: 'other@example.test' },
    });

    expect(res.status).toBe(404);
    // One submission, from the live form. A retired embed that still accepted
    // writes would keep filling the pipeline from a page the firm believes is
    // switched off.
    expect(await submissionRows(firm.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/intake/:token/submit: the write-side access-code gate
// ---------------------------------------------------------------------------

describe('POST /:token/submit: the access-code gate', () => {
  it('accepts a submission carrying the correct code', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await submit(template.publicToken, { fieldValues: ANSWERS, accessCode: CODE });

    // The happy path first, so the two refusals below cannot pass because the
    // gated route is simply broken.
    expect(res.status).toBe(201);
    expect(await submissionRows(firm.id)).toHaveLength(1);
  });

  it('refuses a submission that never passed the gate', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await submit(template.publicToken, { fieldValues: ANSWERS });

    // The read route and the submit route are independent. Nothing stops a
    // caller skipping GET and POSTing straight here, so `submitIntake` has to
    // re-check the code itself; the earlier `requiresAccessCode` response is
    // advice to a browser, not a control.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/access code is required/i);
  });

  it('writes nothing when the gate refuses an ungated submission', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    await submit(template.publicToken, { fieldValues: ANSWERS });

    // The consequence of the case above, stated as state. A 400 that had already
    // inserted the row would be the leak itself: the firm receives the answers
    // and the code protected nothing.
    expect(await submissionRows(firm.id)).toHaveLength(0);
    expect(await leadRows(firm.id)).toHaveLength(0);
  });

  it('refuses a submission carrying the wrong code, and writes nothing', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await submit(template.publicToken, { fieldValues: ANSWERS, accessCode: WRONG });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/incorrect access code/i);
    expect(await submissionRows(firm.id)).toHaveLength(0);
    expect(await leadRows(firm.id)).toHaveLength(0);
  });

  it('checks the code BEFORE the answers', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await submit(template.publicToken, { fieldValues: {}, accessCode: WRONG });

    // Empty answers would fail the required-field check on their own. Ordering
    // it the other way round would turn the submit route into a field oracle for
    // a caller who never had the code: they would learn the template's shape
    // from the validation errors.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/incorrect access code/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/intake/:token/submit: targeted send
// ---------------------------------------------------------------------------

describe('POST /:token/submit: a targeted send', () => {
  it('completes the existing row instead of inserting a second one', async () => {
    const template = await seedTemplate(firm.id);
    const lead = await seedLead(firm.id, { name: 'Dana Reed', email: 'dana.reed@example.test' });
    const sent = await seedSubmission(firm.id, template.id, {
      leadId: lead.id,
      sentToEmail: 'dana.reed@example.test',
    });

    const res = await submit(sent.token, { fieldValues: ANSWERS });

    expect(res.status).toBe(201);
    const rows = await submissionRows(firm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent.id);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].field_values).toEqual(ANSWERS);
  });

  it('does not mint a second lead for the recipient', async () => {
    const template = await seedTemplate(firm.id);
    const lead = await seedLead(firm.id, { name: 'Dana Reed', email: 'someone.else@example.test' });
    const sent = await seedSubmission(firm.id, template.id, { leadId: lead.id });

    await submit(sent.token, { fieldValues: ANSWERS });

    const leads = await leadRows(firm.id);
    // The submission's own answers carry a DIFFERENT email from the lead's. The
    // targeted path attaches by `lead_id`, never by email, so the firm's pipeline
    // must not gain a stranger's duplicate for a form it sent to a known person.
    expect(leads).toHaveLength(1);
    expect(leads[0].id).toBe(lead.id);
    expect(leads[0].email).toBe('someone.else@example.test');
  });

  it('refuses a second submission on a completed link', async () => {
    const template = await seedTemplate(firm.id);
    const sent = await seedSubmission(firm.id, template.id, { status: 'completed' });

    const res = await submit(sent.token, { fieldValues: ANSWERS });

    // A targeted token stays live after use. Without this check anyone holding
    // a forwarded link could overwrite the recipient's answers with their own,
    // and the firm would see only the last write.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been submitted/i);
  });

  it('leaves the completed answers untouched when it refuses', async () => {
    const template = await seedTemplate(firm.id);
    const sent = await seedSubmission(firm.id, template.id, { status: 'completed' });
    await testPool.query(
      `update intake_submissions set field_values = $2::jsonb where id = $1`,
      [sent.id, JSON.stringify({ full_name: 'Original Answer' })],
    );

    await submit(sent.token, { fieldValues: ANSWERS });

    expect((await submissionRows(firm.id))[0].field_values).toEqual({ full_name: 'Original Answer' });
  });

  it('CHARACTERISATION: a targeted link still submits after the template is retired', async () => {
    const template = await seedTemplate(firm.id, { isActive: false });
    const sent = await seedSubmission(firm.id, template.id);

    // `!template.isActive && !submission`: the guard exempts a targeted send on
    // purpose, matching the GET path. Pinned here for the same reason: it is the
    // difference between retiring an embed and invalidating every link already
    // in flight.
    expect((await submit(sent.token, { fieldValues: ANSWERS })).status).toBe(201);
  });

  it('a submission token wins over a template token of the same value', async () => {
    const template = await seedTemplate(firm.id);
    const shared = `shared-${randomUUID()}`;
    await testPool.query(
      'update intake_form_templates set public_token = $2 where id = $1',
      [template.id, shared],
    );
    const sent = await seedSubmission(firm.id, template.id, { status: 'completed' });
    await testPool.query('update intake_submissions set token = $2 where id = $1', [sent.id, shared]);

    const res = await getForm(shared);

    // `resolveToken` looks up the submission first and returns without ever
    // consulting the template token. The completed submission is the tell: had
    // the template won, this would be a live form rather than a finished one.
    expect(res.body.alreadyCompleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

describe('POST /:token/submit: validation of the answers', () => {
  it('refuses a missing required answer, and writes nothing', async () => {
    const template = await seedTemplate(firm.id);
    const { full_name: _omitted, ...withoutName } = ANSWERS;

    const res = await submit(template.publicToken, { fieldValues: withoutName });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full name is required/i);
    expect(await submissionRows(firm.id)).toHaveLength(0);
    expect(await leadRows(firm.id)).toHaveLength(0);
  });

  it('treats a whitespace-only answer as missing', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, { fieldValues: { ...ANSWERS, full_name: '   ' } });

    // Required-ness is checked after trimming. A space bar is not an answer,
    // and accepting one produces a lead named with a blank.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full name is required/i);
  });

  it('refuses a malformed email answer', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, { fieldValues: { ...ANSWERS, email: 'dana at example' } });

    // The email becomes the lead's address and the key the next submission is
    // matched on, so an unusable one is a lead the firm cannot contact and
    // cannot deduplicate.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email address/i);
    expect(await leadRows(firm.id)).toHaveLength(0);
  });

  it('refuses a select answer that is not one of the offered options', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, { fieldValues: { ...ANSWERS, matter_type: 'Maritime Law' } });

    // The options are the firm's own list. Free text arriving in a select field
    // means the value came from something other than the rendered form.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/available options/i);
  });

  it('accepts an omitted optional answer and stores it as null', async () => {
    const template = await seedTemplate(firm.id);
    const { phone: _noPhone, details: _noDetails, ...required } = ANSWERS;

    const res = await submit(template.publicToken, { fieldValues: required });

    // The other side of the required-field rule. Without this, a validator that
    // rejected everything would satisfy every case above.
    expect(res.status).toBe(201);
    expect((await submissionRows(firm.id))[0].field_values)
      .toEqual({ ...required, phone: null, details: null });
  });

  it('rejects an answer longer than the 5000-character cap', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, {
      fieldValues: { ...ANSWERS, details: 'x'.repeat(5001) },
    });

    // The HTTP-shape bound in `intake.validation.ts`. It is the only thing
    // between an anonymous caller and an unbounded jsonb write, since
    // `validateFieldValues` has no length rule of its own.
    expect(res.status).toBe(400);
    expect(await submissionRows(firm.id)).toHaveLength(0);
  });

  it('accepts an answer exactly at the cap, counted in characters rather than bytes', async () => {
    const template = await seedTemplate(firm.id);
    // Two bytes each in UTF-8, so a byte-counting cap would refuse this.
    const atCap = 'é'.repeat(5000);

    // The boundary from below, so an off-by-one that refused a 5000-character
    // answer cannot hide behind the case above.
    const res = await submit(template.publicToken, {
      fieldValues: { ...ANSWERS, details: atCap },
    });

    expect(res.status).toBe(201);
    expect((await submissionRows(firm.id))[0].field_values.details).toBe(atCap);
  });

  it('accepts exactly 100 submitted keys and rejects the 101st', async () => {
    const template = await seedTemplate(firm.id);
    const many: Record<string, string> = { ...ANSWERS };
    for (let i = 0; Object.keys(many).length < 100; i += 1) many[`extra_${i}`] = 'x';

    const atCap = await submit(template.publicToken, { fieldValues: many });
    expect(atCap.status).toBe(201);

    many.extra_overflow = 'x';
    const over = await submit(template.publicToken, { fieldValues: many });

    // Undeclared keys are dropped later, but they are parsed first. The cap
    // bounds the parse itself.
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('Too many fields submitted');
    expect(await submissionRows(firm.id)).toHaveLength(1);
  });

  it('accepts a key of exactly 100 characters and rejects 101', async () => {
    const template = await seedTemplate(firm.id);

    const atCap = await submit(template.publicToken, {
      fieldValues: { ...ANSWERS, ['k'.repeat(100)]: 'x' },
    });
    const over = await submit(template.publicToken, {
      fieldValues: { ...ANSWERS, ['k'.repeat(101)]: 'x' },
    });

    expect(atCap.status).toBe(201);
    expect(over.status).toBe(400);
  });

  it('rejects a non-string answer', async () => {
    const template = await seedTemplate(firm.id);

    const res = await submit(template.publicToken, { fieldValues: { ...ANSWERS, details: { nested: true } } });

    // `validateFieldValues` would `String()` an object into "[object Object]"
    // and store it. The schema stops it at the edge instead.
    expect(res.status).toBe(400);
    expect(await submissionRows(firm.id)).toHaveLength(0);
  });

  it('rejects an access code longer than 100 characters', async () => {
    const template = await seedTemplate(firm.id, { accessCode: CODE });

    const res = await submit(template.publicToken, {
      fieldValues: ANSWERS,
      accessCode: 'x'.repeat(101),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe('the token decides which firm the write lands in', () => {
  it('a submission never touches the neighbouring firm', async () => {
    const other = await createFirm({ name: 'Other Firm LLP' });
    await seedTemplate(other.id, { name: 'Other Intake' });
    const mine = await seedTemplate(firm.id);

    expect((await submit(mine.publicToken, { fieldValues: ANSWERS })).status).toBe(201);

    // There is no `:lawFirmId` in this URL, so the usual scope check does not
    // apply: the firm is derived from the token alone. The neighbour's tables
    // are re-read directly, because a 201 says nothing about where the row went.
    expect(await submissionRows(firm.id)).toHaveLength(1);
    expect(await leadRows(firm.id)).toHaveLength(1);
    expect(await submissionRows(other.id)).toHaveLength(0);
    expect(await leadRows(other.id)).toHaveLength(0);
  });

  it('does not attach to a lead of the same email in another firm', async () => {
    const other = await createFirm({ name: 'Other Firm LLP' });
    const theirLead = await seedLead(other.id, { name: 'Dana Reed', email: 'dana.reed@example.test' });
    const mine = await seedTemplate(firm.id);

    await submit(mine.publicToken, { fieldValues: ANSWERS });

    // `findByEmail` is tenant-scoped. An unscoped lookup would match the
    // neighbour's lead, and the submission would be filed under a firm that
    // never published the form, with the neighbour's notes rewritten by a
    // stranger's answers.
    const theirs = await leadRows(other.id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].notes).toBeNull();
    const mineLeads = await leadRows(firm.id);
    expect(mineLeads).toHaveLength(1);
    expect(mineLeads[0].id).not.toBe(theirLead.id);
  });

  it('serves the token holder their OWN firm name, not the first firm on file', async () => {
    const other = await createFirm({ name: 'Other Firm LLP' });
    const theirs = await seedTemplate(other.id, { name: 'Other Intake' });

    const res = await getForm(theirs.publicToken);

    expect(res.body.lawFirmName).toBe('Other Firm LLP');
    expect(res.body.name).toBe('Other Intake');
  });
});
