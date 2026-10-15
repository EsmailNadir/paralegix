/**
 * Fixture builders for the in-process suite.
 *
 * Every insert is plain SQL through the test pool, never the app's repositories.
 * A fixture built by the code under test cannot fail when that code is wrong,
 * and that is precisely how the organization bugs in be459ec0 stayed invisible:
 * the same broken helper produced both the data and the expectation.
 *
 * Column lists are read off db/schema.sql. Money is integer cents everywhere;
 * never pass a float.
 */
import { randomUUID } from 'crypto';
import { testPool } from './db';

export interface Firm {
  id: string;
  name: string;
}

export interface Member {
  uid: string;
  roleId: string | null;
  isOwner: boolean;
}

export interface ClientRecord {
  id: string;
}

/**
 * A law firm.
 *
 * `enterprise` rather than the schema default of `starter`, because starter and
 * basic both set `templates`, `trustAccounting` and `documentSigning` to false
 * (src/shared/plans/planDefinitions.ts). A fixture firm on the default plan is
 * answered 403 by `requireFeature` on every one of those routes, and the failure
 * reads as a permission bug rather than a plan one.
 *
 * `comped` billing satisfies `requireActiveBilling` with no Stripe subscription.
 */
export async function createFirm(overrides: { name?: string; planId?: string } = {}): Promise<Firm> {
  const id = randomUUID();
  const name = overrides.name ?? `Test Firm ${id.slice(0, 8)}`;
  await testPool.query(
    `insert into law_firms (id, name, plan_id, billing_status)
     values ($1, $2, $3, 'comped')`,
    [id, name, overrides.planId ?? 'enterprise'],
  );
  // An admitted source for the firm, so a seeded signing session has one to
  // name. `signature_sessions.source_id` is NOT NULL: a session that cannot say
  // what document it was built from cannot be finalized, because finalization
  // reads the PREPARED copy and the hash state saved over it. Seeding sessions
  // through SQL still has to satisfy that, and `seedSessionSourceSql` below is
  // how a spec names this row without carrying an extra parameter.
  await testPool.query(
    `insert into signature_sources
       (law_firm_id, object_path, status, size_bytes,
        prepared_object_path, prepared_generation, prepared_size_bytes)
     values ($1, $2, 'ready', 1024, $2, '1000', 1024)`,
    [id, `signing-uploads/${id}/seed/source.pdf`],
  );
  return { id, name };
}

/**
 * The firm's seeded signing source, as a scalar subquery.
 *
 * Written this way so a spec adds `source_id` to an insert without renumbering
 * every parameter after it. `firmParam` is whichever placeholder already
 * carries the firm id in that statement.
 */
export const seedSessionSourceSql = (firmParam: string) =>
  `(select id from signature_sources where law_firm_id = ${firmParam} order by created_at limit 1)`;

/**
 * Point the firm's seeded source at a document a spec actually stored.
 *
 * The row `createFirm` seeds describes a placeholder, which is all a spec needs
 * when it only wants a session to EXIST. A spec that finalizes needs the source
 * to describe the bytes it put in the bucket, because finalization opens the
 * prepared object pinned to the generation recorded here: a row naming a path
 * with nothing behind it fails as a storage error rather than as whatever the
 * spec was about.
 */
export async function pointFirmSourceAt(
  lawFirmId: string,
  objectPath: string,
  generation: string,
  sizeBytes: number,
): Promise<string> {
  const { rows } = await testPool.query(
    `update signature_sources
        set object_path = $2, object_generation = $3, size_bytes = $4,
            prepared_object_path = $2, prepared_generation = $3, prepared_size_bytes = $4,
            status = 'ready'
      where law_firm_id = $1
        and id = (select id from signature_sources where law_firm_id = $1 order by created_at limit 1)
      returning id`,
    [lawFirmId, objectPath, String(generation), sizeBytes],
  );
  return rows[0].id;
}

/**
 * Put a firm into a known billing state, the way the application stores one.
 *
 * Since migration 0200 `plan_id` and `billing_status` are typed COLUMNS and the
 * `plan` jsonb no longer carries `planId` / `billingStatus` at all;
 * `lawfirms.repository` routes both out of every patch it is given. A fixture
 * that writes them into the jsonb instead leaves the columns on their table
 * defaults, which is a state no code path can produce -- and because the gate
 * reads the columns, such a fixture quietly tests a firm that is `comped`
 * rather than the status it named.
 *
 * Six suites each had their own copy of this SQL and all six drifted the same
 * way when the mirror trigger was deleted, which is why it lives here now.
 *
 * The jsonb half MERGES by default, matching `mergePlan`, so seeding a billing
 * status does not silently drop a `stripeCustomerId` seeded moments earlier.
 * Pass `replace: true` where the fixture means "this is the firm's ENTIRE plan"
 * -- a test for the no-subscription path needs the seeded `stripeSubscriptionId`
 * gone, and merging would leave the firm holding one.
 *
 * Values are written to the columns verbatim rather than normalized: a fixture
 * naming a status outside the column vocabulary should fail loudly on the CHECK
 * constraint rather than be quietly translated, since the application cannot
 * store one either.
 */
export async function setFirmPlan(
  lawFirmId: string,
  patch: Record<string, unknown>,
  options: { replace?: boolean } = {},
): Promise<void> {
  const { planId, billingStatus, ...jsonb } = patch;
  await testPool.query(
    `update law_firms
        set plan           = ${options.replace ? '$2::jsonb' : "coalesce(plan, '{}'::jsonb) || $2::jsonb"},
            plan_id        = coalesce($3, plan_id),
            billing_status = coalesce($4, billing_status)
      where id = $1`,
    [lawFirmId, JSON.stringify(jsonb), planId ?? null, billingStatus ?? null],
  );
}

/**
 * A firm member.
 *
 * The permission gate resolves through `members` JOIN `roles`; there is no
 * permission column on the member itself. `isOwner` short-circuits to the full
 * permission set, which is what most fixtures want. Passing `isOwner: false`
 * creates a role carrying exactly the codes given, which is how a read-only or
 * partial role is expressed, and the only way to test one.
 */
export async function createFirmMember(
  lawFirmId: string,
  overrides: { uid?: string; isOwner?: boolean; permissions?: string[]; name?: string } = {},
): Promise<Member> {
  const uid = overrides.uid ?? `member-${randomUUID().slice(0, 8)}`;
  // A firm has AT MOST ONE owner (`members_one_owner_per_firm_idx`, migration
  // 0223). The default used to be an unconditional `true`, which quietly made
  // every member of every test firm an owner and put most fixtures in a state
  // the product cannot produce. The default is now "owner if this firm has none
  // yet", so the first member of a firm is its owner exactly as before and the
  // second is an ordinary member, which is what creating a second member does in
  // the product. A caller that needs a specific standing still says so.
  let isOwner = overrides.isOwner;
  if (isOwner === undefined) {
    const { rows } = await testPool.query(
      'select 1 from members where law_firm_id = $1 and is_owner limit 1',
      [lawFirmId],
    );
    isOwner = rows.length === 0;
  }

  // `on conflict do nothing`: a caller may pass the SAME uid across two
  // separate `createFirmMember` calls to build the A04 fixture (one real
  // person, a member of two different firms, potentially with a different
  // role in each). `users` has no per-firm scope -- one person is one row --
  // so the second call must not try to re-insert them and fail on the
  // primary key. `members` has no such conflict: its key is
  // `(law_firm_id, user_id)`, so a second row for the same uid under a
  // different firm inserts cleanly below.
  await testPool.query(
    `insert into users (id, email, name, user_type)
     values ($1, $2, $3, 'firm_member')
     on conflict (id) do nothing`,
    [uid, `${uid}@example.test`, overrides.name ?? `Member ${uid.slice(-4)}`],
  );

  let roleId: string | null = null;
  if (!isOwner) {
    roleId = randomUUID();
    await testPool.query(
      `insert into roles (id, law_firm_id, name, is_built_in, permissions)
       values ($1, $2, $3, false, $4)`,
      [roleId, lawFirmId, `Role ${roleId.slice(0, 8)}`, overrides.permissions ?? []],
    );
  }

  await testPool.query(
    `insert into members (law_firm_id, user_id, role_id, is_owner, joined_at)
     values ($1, $2, $3, $4, now())`,
    [lawFirmId, uid, roleId, isOwner],
  );

  return { uid, roleId, isOwner };
}

/** A portal user: a `users` row of type `client`, ready to own a client record. */
/**
 * Make sure a `users` row exists for `uid`, creating a bare one if not.
 *
 * For a spec that names an actor by a fixed uid (`'creator-uid'`,
 * `'someone-else'`) rather than through `createFirmMember`. Every actor column
 * is a real foreign key to `users` since migrations 0224 and 0226, so a row
 * naming an account that does not exist is refused at insert; this is what
 * turns a fixture's placeholder into an account the key accepts. Idempotent, so
 * the same uid can be ensured by every seed that mentions it.
 */
export async function ensureUser(uid: string | null | undefined): Promise<void> {
  if (!uid) return;
  await testPool.query(
    `insert into users (id, email, name, user_type)
     values ($1, $2, $3, 'firm_member')
     on conflict (id) do nothing`,
    [uid, `${uid}@example.test`, `User ${uid.slice(-6)}`],
  );
}

export async function createPortalUser(
  overrides: { uid?: string; name?: string } = {},
): Promise<{ uid: string }> {
  const uid = overrides.uid ?? `portal-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type)
     values ($1, $2, $3, 'client')`,
    [uid, `${uid}@example.test`, overrides.name ?? `Portal ${uid.slice(-4)}`],
  );
  return { uid };
}

/**
 * A person client. `client_type` is set on insert because the
 * `clients_type_immutable` trigger forbids changing it afterwards.
 */
export async function createPersonClient(
  lawFirmId: string,
  overrides: { name?: string; userId?: string | null; email?: string | null } = {},
): Promise<ClientRecord> {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type, user_id, email)
     values ($1, $2, $3, 'person', $4, $5)`,
    [
      id,
      lawFirmId,
      overrides.name ?? `Person ${id.slice(0, 8)}`,
      overrides.userId ?? null,
      overrides.email ?? null,
    ],
  );
  return { id };
}

/**
 * An organization client.
 *
 * It deliberately never carries `user_id`. An organization is one `clients` row
 * whose people are their own standalone person clients, joined through
 * `client_company_links`. The invoice-notification bug in be459ec0 was exactly
 * the assumption that a client row always has a portal user on it.
 */
export async function createOrgClient(
  lawFirmId: string,
  overrides: { name?: string; email?: string | null } = {},
): Promise<ClientRecord> {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type, email)
     values ($1, $2, $3, 'company', $4)`,
    [id, lawFirmId, overrides.name ?? `Organization ${id.slice(0, 8)}`, overrides.email ?? null],
  );
  return { id };
}

/**
 * Put a person on an organization's roster.
 *
 * `canViewBilling` is required rather than defaulted. Every money-facing
 * organization bug in be459ec0 turned on this flag, so a test has to state which
 * side of it it is covering instead of inheriting an answer.
 *
 * The table's foreign keys are composite, `(law_firm_id, person_client_id)` and
 * `(law_firm_id, company_client_id)`, and a `not_self` check forbids linking a
 * client to itself.
 */
export async function linkPersonToOrg(
  lawFirmId: string,
  personClientId: string,
  companyClientId: string,
  flags: {
    canViewBilling: boolean;
    isPrimary?: boolean;
    isEmailRecipient?: boolean;
    relationship?: string | null;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await testPool.query(
    `insert into client_company_links
       (id, law_firm_id, person_client_id, company_client_id,
        can_view_billing, is_primary, is_email_recipient, relationship)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      lawFirmId,
      personClientId,
      companyClientId,
      flags.canViewBilling,
      flags.isPrimary ?? false,
      flags.isEmailRecipient ?? false,
      flags.relationship ?? null,
    ],
  );
  return { id };
}

/**
 * Set one notification opt-out on a client. Preferences live in
 * `clients.settings` under `notifications`, one shared blob per person, so
 * muting a category applies everywhere that person is linked.
 */
export async function setClientNotificationPref(
  clientId: string,
  key: string,
  enabled: boolean,
): Promise<void> {
  // Two merges rather than jsonb_set: `create_missing` only creates the LEAF,
  // so setting {notifications,someKey} on a client whose settings have no
  // `notifications` object at all is silently a no-op. Merging preserves the
  // client's other settings and its other notification keys.
  await testPool.query(
    `update clients
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object(
               'notifications',
               coalesce(settings -> 'notifications', '{}'::jsonb)
                 || jsonb_build_object($2::text, $3::boolean)
             )
      where id = $1`,
    [clientId, key, enabled],
  );
}

/**
 * An issued invoice against a client. Money is integer cents, matching the
 * schema; never pass a float.
 *
 * Fixtures need real money on the books because the `can_view_billing` cases
 * cannot be judged without it. Against an empty world a leak and a correct
 * refusal both return zero, so a battery run without this produces false greens
 * on every money surface.
 */
export async function createInvoice(
  lawFirmId: string,
  clientId: string,
  overrides: { totalCents?: number; status?: string; invoiceNumber?: string } = {},
): Promise<{ id: string; totalCents: number }> {
  const id = randomUUID();
  const totalCents = overrides.totalCents ?? 250_000;
  // `client_context_id` is not a duplicate of `client_id`. A CHECK constraint
  // requires exactly one of `matter_id` or `client_context_id`, which is how the
  // schema distinguishes a matter invoice from a client-level one. `client_id`
  // is separately the billed client. A client-level invoice sets both to the
  // same client.
  await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, invoice_date, due_date)
     values ($1, $2, $3, $3, 'client', $4, $5, $6, current_date, current_date + 30)`,
    [
      id,
      lawFirmId,
      clientId,
      overrides.invoiceNumber ?? `INV-${id.slice(0, 8)}`,
      overrides.status ?? 'outstanding',
      totalCents,
    ],
  );
  return { id, totalCents };
}

/**
 * A trust account with one completed deposit against a client.
 *
 * Trust surfaces report TRUST money, not invoice money, so a world seeded only
 * with an invoice makes every trust `can_view_billing` case a false green: the
 * figure is absent whether it was correctly withheld or never existed.
 *
 * `trust_transactions` is append-only by database trigger. Inserting is fine;
 * anything that later needs to change one must post a reversing entry.
 */
export async function createTrustDeposit(
  lawFirmId: string,
  clientId: string,
  overrides: { amountCents?: number; accountName?: string } = {},
): Promise<{ accountId: string; transactionId: string; amountCents: number }> {
  const accountId = randomUUID();
  const transactionId = randomUUID();
  const amountCents = overrides.amountCents ?? 412_600;

  await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents)
     values ($1, $2, $3, 'iolta', 'active', $4)`,
    [accountId, lawFirmId, overrides.accountName ?? 'Test IOLTA', amountCents],
  );

  await testPool.query(
    `insert into trust_transactions
       (id, law_firm_id, trust_account_id, type, amount_cents, client_id,
        txn_date, description, status, client_balance_after_cents, account_balance_after_cents)
     values ($1, $2, $3, 'deposit', $4, $5, current_date, 'Fixture retainer',
             'completed', $4, $4)`,
    [transactionId, lawFirmId, accountId, amountCents, clientId],
  );

  return { accountId, transactionId, amountCents };
}

/**
 * The session's uuid, as a scalar subquery over the session's PUBLIC token.
 *
 * The signature children key on `session_id`. Fixtures here are written by hand
 * in SQL and hold the token, because that is what the routes under test are
 * given. Rather than every fixture doing its own lookup round trip, the two
 * helpers below inline the lookup into the statement that needs it. Neither
 * consumes a placeholder of its own, so the `$n` numbering around a call site
 * is unchanged.
 *
 * Pass the placeholder that carries the token, for example `sessionKeys('$2')`.
 */
export const sessionIdSql = (tokenParam: string) =>
  `(select id from signature_sessions where token = ${tokenParam})`;

/** `session_id, law_firm_id` for a child row, both from the session's token. */
export const sessionKeysSql = (tokenParam: string) =>
  `${sessionIdSql(tokenParam)}, (select law_firm_id from signature_sessions where token = ${tokenParam})`;

/**
 * A role on a firm, with exactly the permission codes given.
 *
 * For a spec that needs a role WITHOUT a member on it: an invitation to carry,
 * a role to assign or delete, or a built-in the admin console must list.
 * `createFirmMember` builds its own role for a member and is what to reach for
 * when a person should hold it. The name defaults to one unique to this role,
 * because a firm's role names are unique.
 */
export async function seedRole(
  lawFirmId: string,
  options: { name?: string; permissions?: string[]; isBuiltIn?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into roles (id, law_firm_id, name, is_built_in, permissions)
     values ($1, $2, $3, $4, $5)`,
    [id, lawFirmId, options.name ?? `Role ${id.slice(0, 8)}`, options.isBuiltIn ?? false, options.permissions ?? []],
  );
  return id;
}

/**
 * Put a firm in its post-deletion retention window: deletion requested a day
 * ago, hard purge due `interval` from now. A negative interval (`'-1 minute'`)
 * makes the firm due for `purgeEligibleFirms`; a positive one keeps it inside
 * the window.
 */
export async function setRetentionWindow(lawFirmId: string, interval: string): Promise<void> {
  await testPool.query(
    `update law_firms
        set pending_deletion_at = now() - interval '1 day',
            deletion_purge_after = now() + $2::interval
      where id = $1`,
    [lawFirmId, interval],
  );
}
