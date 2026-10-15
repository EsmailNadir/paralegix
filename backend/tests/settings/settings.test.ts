/**
 * The settings module, driven through the real app.
 *
 * Eight routes across three scopes (the caller's own preferences, the firm's
 * settings, one client's settings) and no in-process spec until now. Three
 * properties are worth a test here and none of them is visible on a screen:
 *
 *   WHOSE ROW. `/settings/user` never names a user. It writes whoever the token
 *   says, which is right, and means the only way to catch a regression is to
 *   read the OTHER person's row back afterwards.
 *
 *   WHAT THE EDGE ACCEPTS. Two of the three payload schemas are `.strict()` and
 *   the third is deliberately open. The firm one additionally drops
 *   plan-controlled keys in the service, which is what stops a firm raising its
 *   own storage quota through a free-form settings PUT.
 *
 *   WHOSE LOCK. A firm admin lock is enforced from the caller's REAL
 *   memberships, not from the `?lawFirmId=` query param they supply. The param
 *   was once the only trigger, so omitting it bypassed the lock entirely; that
 *   is the single most valuable case in this file.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  memberWith,
  portalUser,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let member: Actor;

const USER_SETTINGS = '/api/settings/user';
const firmSettings = (lawFirmId = firm.id) => `/api/lawfirms/${lawFirmId}/settings/firm`;
const clientSettings = (clientId: string, lawFirmId = firm.id) =>
  `/api/lawfirms/${lawFirmId}/clients/${clientId}/settings`;

/** One user's stored preferences, read with plain SQL. */
async function storedPreferences(userId: string): Promise<Record<string, any>> {
  const { rows } = await testPool.query(
    'select preferences from users where id = $1',
    [userId],
  );
  return rows[0]?.preferences ?? {};
}

/** One client's stored settings blob, read with plain SQL. */
async function storedClientSettings(clientId: string): Promise<Record<string, any>> {
  const { rows } = await testPool.query('select settings from clients where id = $1', [clientId]);
  return rows[0]?.settings ?? {};
}

/** The firm's settings blob and its authoritative quota column. */
async function storedFirmSettings(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select settings, storage_quota_bytes, storage_warn_at_percent
       from law_firms where id = $1`,
    [lawFirmId],
  );
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  // The always-on baseline and nothing else: `settings.viewFirm` and
  // `clients.view` are in it, `settings.manageFirm` and `clients.manage` are not.
  member = await memberWith(firm.id, []);
  await drainEvents();
});

describe('user preferences round-trip', () => {
  it('stores what was posted and reads it back merged over the defaults', async () => {
    const write = await owner.api.post(USER_SETTINGS).send({
      preferences: { theme: 'dark', dateFormat: 'DD/MM/YYYY' },
    });
    expect(write.status).toBe(200);

    const read = await owner.api.get(USER_SETTINGS);

    expect(read.status).toBe(200);
    expect(read.body.preferences.theme).toBe('dark');
    expect(read.body.preferences.dateFormat).toBe('DD/MM/YYYY');
    // The read merges over DEFAULTS, so a key nobody has ever written still
    // comes back. A read that returned the raw stored row would omit this.
    expect(read.body.preferences.notifications.inApp.taskAssigned).toBe(true);
    expect(read.body.preferences.calendarView).toBe('month');
  });

  it('merges a second write into the first rather than replacing it', async () => {
    await owner.api.post(USER_SETTINGS).send({ preferences: { theme: 'dark' } });
    await owner.api.post(USER_SETTINGS).send({ preferences: { dateFormat: 'YYYY-MM-DD' } });

    const stored = await storedPreferences(owner.uid);

    // The write is a deep jsonb merge. A whole-column overwrite would leave only
    // the second key here, and every setting the user touched last week would
    // disappear the next time they changed one.
    expect(stored.theme).toBe('dark');
    expect(stored.dateFormat).toBe('YYYY-MM-DD');
  });

  it('merges into a nested category without dropping its siblings', async () => {
    await owner.api.post(USER_SETTINGS).send({
      preferences: { notifications: { inApp: { taskAssigned: false } } },
    });

    const read = await owner.api.get(USER_SETTINGS);

    expect(read.body.preferences.notifications.inApp.taskAssigned).toBe(false);
    // Muting one category must not mute the other twelve, which is what a
    // shallow merge of the `notifications` object would do.
    expect(read.body.preferences.notifications.inApp.mention).toBe(true);
    expect(read.body.preferences.notifications.digest.hour).toBe(7);
  });
});

describe('what the user-preferences edge accepts', () => {
  it('rejects a wrongly typed known key and writes nothing', async () => {
    await owner.api.post(USER_SETTINGS).send({ preferences: { theme: 'dark' } });

    const res = await owner.api.post(USER_SETTINGS).send({ preferences: { theme: 'neon' } });

    expect(res.status).toBe(400);
    // The write above proves the route stores a theme, so this is the schema
    // refusing rather than the route being broken.
    expect((await storedPreferences(owner.uid)).theme).toBe('dark');
  });

  it('rejects a payload with more keys than the bound allows', async () => {
    const preferences: Record<string, number> = {};
    for (let i = 0; i < 51; i += 1) preferences[`key${i}`] = i;

    const res = await owner.api.post(USER_SETTINGS).send({ preferences });

    expect(res.status).toBe(400);
    expect(await storedPreferences(owner.uid)).toEqual({});
  });

  it('rejects a serialized preferences payload above sixty-four kilobytes before storing it', async () => {
    const res = await owner.api.post(USER_SETTINGS).send({
      preferences: { retainedDraft: 'x'.repeat(64 * 1024) },
    });

    // Preferences intentionally allow unknown UI keys, so the byte ceiling is
    // the protection against one otherwise-valid draft inflating the jsonb row.
    expect(res.status).toBe(400);
    expect(await storedPreferences(owner.uid)).toEqual({});
  });

  it('rejects a preferences tree deeper than twelve levels before storing it', async () => {
    let nested: Record<string, unknown> | string = 'leaf';
    for (let level = 0; level < 12; level += 1) nested = { child: nested };

    const res = await owner.api.post(USER_SETTINGS).send({ preferences: { nested } });

    // A tiny but deeply nested object is cheap to transmit yet expands the
    // server-side deep-merge work at every level.
    expect(res.status).toBe(400);
    expect(await storedPreferences(owner.uid)).toEqual({});
  });

  it('accepts an unknown key, because this shape is open by design', async () => {
    const res = await owner.api.post(USER_SETTINGS).send({
      preferences: { sidebarCollapsed: true },
    });

    // CHARACTERISED, NOT ENDORSED. `userPreferencesSchema` is `.passthrough()`
    // on purpose: the General and calendar pages stash assorted ad-hoc UI flags
    // in here, and an allow-list would silently reject valid writes. Abuse is
    // contained by the key-count and byte bounds above rather than by a closed
    // shape. The two `.strict()` schemas below are the contrast.
    expect(res.status).toBe(200);
    expect((await storedPreferences(owner.uid)).sidebarCollapsed).toBe(true);
  });
});

describe('one user cannot reach another user preferences', () => {
  it('reads only the caller own row', async () => {
    await owner.api.post(USER_SETTINGS).send({ preferences: { theme: 'dark' } });

    const res = await member.api.get(USER_SETTINGS);

    expect(res.status).toBe(200);
    // Not "no theme": the default. The route has no user parameter to get
    // wrong, so what this catches is a read that resolved the row by firm.
    expect(res.body.preferences.theme).toBe('system');
  });

  it('writes only the caller own row', async () => {
    await owner.api.post(USER_SETTINGS).send({ preferences: { theme: 'dark' } });

    const res = await member.api.post(USER_SETTINGS).send({ preferences: { theme: 'light' } });

    expect(res.status).toBe(200);
    expect((await storedPreferences(member.uid)).theme).toBe('light');
    expect((await storedPreferences(owner.uid)).theme).toBe('dark');
  });

  it('refuses to read against a firm the caller does not belong to', async () => {
    const otherFirm = await createFirm();

    const foreign = await member.api.get(`${USER_SETTINGS}?lawFirmId=${otherFirm.id}`);
    const own = await member.api.get(`${USER_SETTINGS}?lawFirmId=${firm.id}`);

    // The param decides whose locks are applied to the answer, so it is checked
    // against real membership rather than trusted.
    expect(foreign.status).toBe(403);
    expect(own.status).toBe(200);
  });

  it('writes the caller own row even when the param names a foreign firm', async () => {
    const otherFirm = await createFirm();

    const res = await member.api.post(`${USER_SETTINGS}?lawFirmId=${otherFirm.id}`)
      .send({ preferences: { theme: 'dark' } });

    // The param is not an addressing mechanism on write: it is ignored entirely
    // and the caller's own row is written. Pinned because the obvious "fix" for
    // the 403 above would be to make the write honour the param, which would
    // turn it into a way to name somebody else's settings.
    expect(res.status).toBe(200);
    expect((await storedPreferences(member.uid)).theme).toBe('dark');
  });
});

describe('an admin lock on a user setting', () => {
  /** Lock `theme` to `dark` for this firm, through the real route. */
  async function lockTheme() {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/settings/lock`)
      .send({ key: 'theme', value: 'dark' });
    expect(res.status).toBe(200);
  }

  it('rejects a member write of the locked key even with no lawFirmId param', async () => {
    await lockTheme();

    const res = await member.api.post(USER_SETTINGS).send({ preferences: { theme: 'light' } });

    // THE case in this file. Lock authority is derived from the caller's real
    // memberships; when it came from the query param instead, omitting the
    // param bypassed every firm lock in the product.
    expect(res.status).toBe(403);
    expect(await storedPreferences(member.uid)).toEqual({});
  });

  it('still allows a write to an unlocked key', async () => {
    await lockTheme();

    const res = await member.api.post(USER_SETTINGS)
      .send({ preferences: { dateFormat: 'DD/MM/YYYY' } });

    // The lock is per key. Refusing the whole payload would be the easy
    // over-correction, and it would leave members unable to change anything.
    expect(res.status).toBe(200);
    expect((await storedPreferences(member.uid)).dateFormat).toBe('DD/MM/YYYY');
  });

  it('substitutes the locked value on read, over what the member stored first', async () => {
    await member.api.post(USER_SETTINGS).send({ preferences: { theme: 'light' } });
    await lockTheme();

    const res = await member.api.get(USER_SETTINGS);

    // Read and write have to agree. Blocking the write while still serving the
    // member's old value would show them a theme the firm has forbidden.
    expect(res.body.preferences.theme).toBe('dark');
    expect((await storedPreferences(member.uid)).theme).toBe('light');
  });

  it('stops applying once the key is unlocked', async () => {
    await lockTheme();
    const unlock = await owner.api.post(`/api/lawfirms/${firm.id}/settings/unlock`)
      .send({ key: 'theme' });
    expect(unlock.status).toBe(200);

    const write = await member.api.post(USER_SETTINGS).send({ preferences: { theme: 'light' } });

    // An unlock that only nulled the locked VALUE would leave `locks.theme`
    // truthy and the setting permanently frozen.
    expect(write.status).toBe(200);
    expect((await member.api.get(USER_SETTINGS)).body.preferences.theme).toBe('light');
  });

  it('does not apply another firm lock to a member who is not in that firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/settings/lock`)
      .send({ key: 'theme', value: 'dark' });

    const res = await member.api.post(USER_SETTINGS).send({ preferences: { theme: 'light' } });

    // The union is over the caller's OWN memberships. A union over every firm
    // would let any firm on the platform freeze every user's theme.
    expect(res.status).toBe(200);
    expect((await storedPreferences(member.uid)).theme).toBe('light');
  });

  it('applies a lock held by a second firm the member also belongs to', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    await testPool.query(
      `insert into members (law_firm_id, user_id, role_id, is_owner, joined_at)
       values ($1, $2, null, false, now())`,
      [otherFirm.id, member.uid],
    );
    await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/settings/lock`)
      .send({ key: 'theme', value: 'dark' });

    const res = await member.api.post(`${USER_SETTINGS}?lawFirmId=${firm.id}`)
      .send({ preferences: { theme: 'light' } });

    // Routing the write "through" the firm that has no lock must not shake off
    // the firm that does. Any membership's lock refuses.
    expect(res.status).toBe(403);
    expect(await storedPreferences(member.uid)).toEqual({});
  });
});

describe('firm settings', () => {
  it('lets a baseline member read but not write', async () => {
    const read = await member.api.get(firmSettings());
    const write = await member.api.put(firmSettings())
      .send({ settings: { emailNotificationsEnabled: false } });

    // `settings.viewFirm` is in the baseline; `settings.manageFirm` is not.
    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect((await storedFirmSettings(firm.id)).settings?.emailNotificationsEnabled)
      .toBeUndefined();
  });

  it('stores a writable key for an owner', async () => {
    const res = await owner.api.put(firmSettings())
      .send({ settings: { emailNotificationsEnabled: false } });

    expect(res.status).toBe(200);
    expect((await storedFirmSettings(firm.id)).settings.emailNotificationsEnabled).toBe(false);
  });

  it('stores the firm time zone, which scheduled work reads the firm day in', async () => {
    const res = await owner.api.put(firmSettings())
      .send({ settings: { timezone: 'America/Chicago' } });

    // The schema accepts it, so a service that dropped it answered 200 while
    // reminders and late fees kept counting days in UTC.
    expect(res.status).toBe(200);
    expect((await storedFirmSettings(firm.id)).settings.timezone).toBe('America/Chicago');
    const read = await owner.api.get(firmSettings());
    expect(read.body.settings.timezone).toBe('America/Chicago');
  });

  it('rejects an unknown top-level key outright', async () => {
    const res = await owner.api.put(firmSettings())
      .send({ settings: { emailNotificationsEnabled: false, features: { trustAccounting: true } } });

    // This schema is `.strict()`, unlike the user one: the firm payload has a
    // known closed shape, and `features` is plan-derived. Accepting and silently
    // dropping it would tell an admin the switch had been flipped.
    expect(res.status).toBe(400);
    expect((await storedFirmSettings(firm.id)).settings?.emailNotificationsEnabled)
      .toBeUndefined();
  });

  it('does not let a firm raise its own storage quota', async () => {
    const before = await storedFirmSettings(firm.id);

    const res = await owner.api.put(firmSettings()).send({
      settings: { storage: { warnAtPercent: 55, quotaBytes: 999_999_999_999 } },
    });

    // `storage` stays `.passthrough()` at the edge for forward compatibility, so
    // the smuggled key gets past validation and the SERVICE whitelist is the
    // only thing that drops it. The writable sibling landing proves the request
    // ran and reached the write.
    expect(res.status).toBe(200);
    const after = await storedFirmSettings(firm.id);
    expect(after.storage_warn_at_percent).toBe(55);
    // The quota is plan-derived. A smuggled value must not reach its column, and
    // must not be left anywhere else for a later read to pick up either.
    expect(after.storage_quota_bytes).toEqual(before.storage_quota_bytes);
    expect(after.settings?.storage).toBeUndefined();
  });

  it('refuses an owner of another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.put(firmSettings())
      .send({ settings: { emailNotificationsEnabled: false } });

    expect(res.status).toBe(403);
    expect((await storedFirmSettings(firm.id)).settings?.emailNotificationsEnabled)
      .toBeUndefined();
  });
});

describe('client settings', () => {
  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Settings Client' });
  });

  it('round-trips a settings blob for a member holding clients.manage', async () => {
    const manager = await memberWith(firm.id, ['clients.manage']);

    const write = await manager.api.put(clientSettings(client.id))
      .send({ settings: { notifications: { invoiceIssued: false } } });
    expect(write.status).toBe(200);

    const read = await manager.api.get(clientSettings(client.id));

    expect(read.status).toBe(200);
    expect(read.body.settings.notifications.invoiceIssued).toBe(false);
    expect((await storedClientSettings(client.id)).notifications.invoiceIssued).toBe(false);
  });

  it('lets a baseline member read but not write', async () => {
    const read = await member.api.get(clientSettings(client.id));
    const write = await member.api.put(clientSettings(client.id))
      .send({ settings: { portal: { canUpload: false } } });

    // `clients.view` is baseline so the roster is open; changing a client is not.
    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect(await storedClientSettings(client.id)).toEqual({});
  });

  it('rejects an unknown top-level key', async () => {
    const res = await owner.api.put(clientSettings(client.id))
      .send({ settings: { notifications: { invoiceIssued: false }, legalHold: true } });

    expect(res.status).toBe(400);
    expect(await storedClientSettings(client.id)).toEqual({});
  });

  it('does not read one firm client settings from another firm', async () => {
    await owner.api.put(clientSettings(client.id))
      .send({ settings: { notifications: { invoiceIssued: false } } });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const foreign = await otherOwner.api.get(clientSettings(client.id, otherFirm.id));

    // The client id is real; only the firm in the URL is not its own. A lookup
    // by id alone would answer with this client's preferences.
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain('invoiceIssued');
  });

  it('does not write one firm client settings from another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const theirClient = await createPersonClient(otherFirm.id, { name: 'Their Client' });

    const trespass = await otherOwner.api.put(clientSettings(client.id, otherFirm.id))
      .send({ settings: { notifications: { invoiceIssued: false } } });
    const own = await otherOwner.api.put(clientSettings(theirClient.id, otherFirm.id))
      .send({ settings: { notifications: { invoiceIssued: false } } });

    // The control write proves this caller can write a client in their own firm,
    // so the untouched row below is the tenant scope and not a missing permission.
    expect(own.status).toBe(200);
    expect((await storedClientSettings(theirClient.id)).notifications.invoiceIssued).toBe(false);
    expect(trespass.status).toBe(404);
    expect(await storedClientSettings(client.id)).toEqual({});
  });

  it('refuses a portal client on the firm-side route, including for their own record', async () => {
    const portal = await portalUser();
    await testPool.query('update clients set user_id = $2 where id = $1', [client.id, portal.uid]);
    const otherClient = await createPersonClient(firm.id, { name: 'Somebody Else' });
    await owner.api.put(clientSettings(otherClient.id))
      .send({ settings: { notifications: { invoiceIssued: false } } });

    const ownRecord = await portal.api.get(clientSettings(client.id));
    const otherRecord = await portal.api.get(clientSettings(otherClient.id));

    // This surface is the firm's, gated on firm membership. A portal user has no
    // `members` row, so both are refused; the second is the one that would leak
    // another client's preferences if the gate resolved through `clients.user_id`.
    expect(ownRecord.status).toBe(403);
    expect(otherRecord.status).toBe(403);
    expect(JSON.stringify(otherRecord.body)).not.toContain('invoiceIssued');
  });

  it('refuses a firm member of another firm entirely', async () => {
    const otherFirm = await createFirm();
    const stranger = await createFirmMember(otherFirm.id, { isOwner: true });

    const res = await as(tokenFor({ uid: stranger.uid })).get(clientSettings(client.id));

    expect(res.status).toBe(403);
  });
});
