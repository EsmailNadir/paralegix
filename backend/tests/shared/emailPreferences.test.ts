/**
 * Email preference gate.
 *
 * The pure `resolve*`/`isTransactionalCategory` tests run against plain
 * objects, no IO. The async DB-backed functions run against an in-memory
 * stand-in for the `law_firms` / `user_settings` / `clients` tables, following
 * the same mocking pattern as `tests/shared/rateLimiters.test.js`: mock
 * `src/shared/database/db` so both this module's direct pool.query calls and
 * the settings repository it delegates to (which imports the same db module)
 * read from the same fake rows.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/emailPreferences.test.js
 */

const mockLawFirms = new Map(); // id -> settings object
const mockUserSettings = new Map(); // user_id -> preferences object
const mockClients = new Map(); // `${lawFirmId}:${clientId}` -> settings object
let mockFailQueries = false;

jest.mock('../../src/shared/database/db', () => ({
  pool: {
    query: async (text: any, params: any) => {
      if (mockFailQueries) throw new Error('connection terminated unexpectedly');
      const arrayMode = typeof text !== 'string' && text.rowMode === 'array';
      text = typeof text === 'string' ? text : text.text;

      if (text.includes('from law_firms')) {
        const [id] = params;
        const settings = mockLawFirms.get(id);
        return { rows: settings === undefined ? [] : [{ settings }] };
      }
      if (text.includes('from "users"') && text.includes('"id", "preferences"')) {
        const [ids] = params;
        const requestedIds = Array.isArray(ids) ? ids : params;
        const rows = requestedIds
          .filter((id: any) => mockUserSettings.has(id))
          .map((id: any) => arrayMode
            ? [id, mockUserSettings.get(id)]
            : { user_id: id, preferences: mockUserSettings.get(id) });
        return { rows };
      }
      if (text.includes('from users') || text.includes('from "users"')) {
        const [userId] = params;
        const preferences = mockUserSettings.get(userId);
        return { rows: preferences === undefined ? [] : [arrayMode ? [preferences] : { preferences }] };
      }
      if (text.includes('from clients')) {
        const [lawFirmId, clientId] = params;
        const settings = mockClients.get(`${lawFirmId}:${clientId}`);
        return { rows: settings === undefined ? [] : [{ settings }] };
      }
      return { rows: [] };
    },
  },
}));

// Extend the real DEFAULTS with a synthetic `user.notifications.email.digest`
// default so resolveUserCategory's DEFAULTS fallback is actually exercised -
// the real module has no such default yet (see the emailPreferences.js header
// comment). `client` defaults are left untouched
// (spread from the real module) so the resolveClientCategory tests below still
// see the real shipped values.
jest.mock('../../src/modules/settings/settings.defaults', () => {
  const actual = jest.requireActual('../../src/modules/settings/settings.defaults');
  return {
    ...actual,
    DEFAULTS: {
      ...actual.DEFAULTS,
      user: {
        ...actual.DEFAULTS.user,
        notifications: {
          ...actual.DEFAULTS.user.notifications,
          email: { digest: false },
        },
      },
    },
  };
});

const {
  isTransactionalCategory,
  resolveUserCategory,
  resolveClientCategory,
  isFirmEmailEnabled,
  isUserEmailCategoryEnabled,
  isClientEmailCategoryEnabled,
  isClientEmailCategoryEnabledByUserId,
  shouldSendClientEmail,
  filterEmailRecipientsByPreference,
  getEmailPrefsForUsers,
  EMAIL_CATEGORIES,
} = require('../../src/shared/services/emailPreferences');

const FIRM_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_CLIENT_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  mockLawFirms.clear();
  mockUserSettings.clear();
  mockClients.clear();
  mockFailQueries = false;
});

describe('isTransactionalCategory', () => {
  test('transactional categories are never gated', () => {
    expect(isTransactionalCategory('invitation')).toBe(true);
    expect(isTransactionalCategory('paymentReceipt')).toBe(true);
    expect(isTransactionalCategory('signingInvite')).toBe(true);
    expect(isTransactionalCategory('intakeForm')).toBe(true);
  });

  test('notification categories are gated', () => {
    expect(isTransactionalCategory('taskAssigned')).toBe(false);
    expect(isTransactionalCategory('digest')).toBe(false);
  });

  test('an unknown category is not exempted from gating (it is not transactional)', () => {
    expect(isTransactionalCategory('somethingNew')).toBe(false);
  });
});

describe('resolveUserCategory', () => {
  test('defaults to enabled when the user has no stored preference', () => {
    expect(resolveUserCategory({}, 'taskAssigned')).toBe(true);
  });

  test('respects an explicit false', () => {
    const prefs = { notifications: { email: { taskAssigned: false } } };
    expect(resolveUserCategory(prefs, 'taskAssigned')).toBe(false);
  });

  test('an explicit true is enabled', () => {
    const prefs = { notifications: { email: { taskAssigned: true } } };
    expect(resolveUserCategory(prefs, 'taskAssigned')).toBe(true);
  });

  test('an unrelated category is unaffected', () => {
    const prefs = { notifications: { email: { taskAssigned: false } } };
    expect(resolveUserCategory(prefs, 'mention')).toBe(true);
  });

  test('a null category is un-gateable', () => {
    const prefs = { notifications: { email: { taskAssigned: false } } };
    expect(resolveUserCategory(prefs, null)).toBe(true);
  });

  test('a stored value wins over the shipped default', () => {
    // "digest" defaults to false in the mocked DEFAULTS above, but the user
    // explicitly turned it back on.
    const prefs = { notifications: { email: { digest: true } } };
    expect(resolveUserCategory(prefs, 'digest')).toBe(true);
  });

  test('an absent stored value falls through to the shipped default', () => {
    expect(resolveUserCategory({}, 'digest')).toBe(false);
  });
});

describe('unrecognized categories', () => {
  // Five separate call sites hand-write these strings. A typo must not silently
  // disable the gate, so the resolvers warn rather than failing quietly - but
  // they must never throw, because a bad category must not break a send path.
  test('warn, and resolve to enabled rather than throwing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveUserCategory({}, 'taskdue')).toBe(true);
    expect(resolveClientCategory({}, 'invoiceissued')).toBe(true);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/taskdue/);
    expect(warn.mock.calls[1][0]).toMatch(/invoiceissued/);

    warn.mockRestore();
  });

  test('a recognized category never warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    resolveUserCategory({}, 'taskDue');
    resolveClientCategory({}, 'invoiceIssued');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveClientCategory', () => {
  test('maps a category to the client key and defaults to the shipped default', () => {
    expect(resolveClientCategory({}, 'invoiceIssued')).toBe(true);
    expect(resolveClientCategory({}, 'matterUpdate')).toBe(false);
  });

  test('respects a stored client opt-out', () => {
    const settings = { notifications: { emailOnNewInvoice: false } };
    expect(resolveClientCategory(settings, 'invoiceIssued')).toBe(false);
  });

  test('an unmapped category is enabled', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveClientCategory({}, 'notAClientCategory')).toBe(true);
    warn.mockRestore();
  });

  test('invoiceReminder is not covered by the new-invoice toggle', () => {
    // A client who mutes "Email on new invoice" must still receive dunning
    // reminders on invoices they already have - that checkbox never promised
    // to cover reminders.
    const settings = { notifications: { emailOnNewInvoice: false } };
    expect(resolveClientCategory(settings, 'invoiceReminder')).toBe(true);
  });
});

describe('EMAIL_CATEGORIES', () => {
  test('every gated category has a stable string id', () => {
    Object.values(EMAIL_CATEGORIES).forEach((id: any) => {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  test('is frozen so a category id cannot be reassigned', () => {
    expect(Object.isFrozen(EMAIL_CATEGORIES)).toBe(true);
    // This expectation FLIPPED with the TypeScript conversion, and the flip is
    // the point. Strictness is a property of the code doing the assigning, not
    // of the frozen object: this spec used to be a sloppy-mode CommonJS file, so
    // the write silently no-oped. Every module now compiles to an ES module,
    // which is always strict, so the same write throws instead of being ignored.
    expect(() => {
      (EMAIL_CATEGORIES as Record<string, string>).TASK_ASSIGNED = 'somethingElse';
    }).toThrow(TypeError);
    expect(EMAIL_CATEGORIES.TASK_ASSIGNED).toBe('taskAssigned');
  });
});

describe('isFirmEmailEnabled', () => {
  test('enabled when the firm has no stored switch', async () => {
    expect(await isFirmEmailEnabled(FIRM_ID)).toBe(true);
  });

  test('respects an explicit false', async () => {
    mockLawFirms.set(FIRM_ID, { emailNotificationsEnabled: false });
    expect(await isFirmEmailEnabled(FIRM_ID)).toBe(false);
  });

  test('a missing firm row is treated as enabled, not suppressed', async () => {
    expect(await isFirmEmailEnabled('99999999-9999-9999-9999-999999999999')).toBe(true);
  });

  test('fails open when the database throws', async () => {
    mockLawFirms.set(FIRM_ID, { emailNotificationsEnabled: false });
    mockFailQueries = true;
    expect(await isFirmEmailEnabled(FIRM_ID)).toBe(true);
  });

  test('a malformed id fails open without querying', async () => {
    expect(await isFirmEmailEnabled('not-a-uuid')).toBe(true);
  });
});

describe('isUserEmailCategoryEnabled', () => {
  test('respects a stored opt-out', async () => {
    mockUserSettings.set('user-1', { notifications: { email: { taskAssigned: false } } });
    expect(await isUserEmailCategoryEnabled('user-1', 'taskAssigned')).toBe(false);
  });

  test('a user with no stored row defaults to enabled', async () => {
    expect(await isUserEmailCategoryEnabled('user-unknown', 'taskAssigned')).toBe(true);
  });

  test('fails open when the database throws', async () => {
    mockUserSettings.set('user-1', { notifications: { email: { taskAssigned: false } } });
    mockFailQueries = true;
    expect(await isUserEmailCategoryEnabled('user-1', 'taskAssigned')).toBe(true);
  });
});

describe('isClientEmailCategoryEnabled', () => {
  test('respects a stored opt-out', async () => {
    mockClients.set(`${FIRM_ID}:${CLIENT_ID}`, { notifications: { emailOnNewInvoice: false } });
    expect(await isClientEmailCategoryEnabled(FIRM_ID, CLIENT_ID, 'invoiceIssued')).toBe(false);
  });

  // A missing client row must resolve to enabled, not silently collapse into
  // "client with empty settings" and pick up the shipped default (which is
  // false for matterUpdate) as an implicit opt-out.
  test('a missing client row is treated as enabled, not suppressed', async () => {
    expect(await isClientEmailCategoryEnabled(FIRM_ID, OTHER_CLIENT_ID, 'matterUpdate')).toBe(true);
  });

  test('fails open when the database throws', async () => {
    mockClients.set(`${FIRM_ID}:${CLIENT_ID}`, { notifications: { emailOnNewInvoice: false } });
    mockFailQueries = true;
    expect(await isClientEmailCategoryEnabled(FIRM_ID, CLIENT_ID, 'invoiceIssued')).toBe(true);
  });

  test('malformed ids fail open without querying', async () => {
    expect(await isClientEmailCategoryEnabled('not-a-uuid', CLIENT_ID, 'invoiceIssued')).toBe(true);
    expect(await isClientEmailCategoryEnabled(FIRM_ID, 'not-a-uuid', 'invoiceIssued')).toBe(true);
  });
});

// The by-user-id lookup reads the same `clients` table, so the mock's
// `from clients` branch serves it with the portal uid in the second param slot.
const CLIENT_UID = 'firebase-uid-client-1';

describe('isClientEmailCategoryEnabledByUserId', () => {
  test('respects a stored opt-out', async () => {
    mockClients.set(`${FIRM_ID}:${CLIENT_UID}`, { notifications: { emailOnNewMessage: false } });
    expect(await isClientEmailCategoryEnabledByUserId(FIRM_ID, CLIENT_UID, 'message')).toBe(false);
  });

  test('an unlinked/unknown portal user is treated as enabled, not suppressed', async () => {
    expect(await isClientEmailCategoryEnabledByUserId(FIRM_ID, 'uid-nobody', 'matterUpdate')).toBe(true);
  });

  test('a transactional category bypasses the database entirely', async () => {
    mockFailQueries = true; // would throw if a query were attempted
    expect(await isClientEmailCategoryEnabledByUserId(FIRM_ID, CLIENT_UID, 'paymentReceipt')).toBe(true);
  });

  test('fails open when the database throws', async () => {
    mockClients.set(`${FIRM_ID}:${CLIENT_UID}`, { notifications: { emailOnNewMessage: false } });
    mockFailQueries = true;
    expect(await isClientEmailCategoryEnabledByUserId(FIRM_ID, CLIENT_UID, 'message')).toBe(true);
  });

  test('a malformed firm id fails open without querying', async () => {
    expect(await isClientEmailCategoryEnabledByUserId('not-a-uuid', CLIENT_UID, 'message')).toBe(true);
  });
});

describe('shouldSendClientEmail', () => {
  test('allows a send when neither the firm nor the client has opted out', async () => {
    expect(await shouldSendClientEmail({
      lawFirmId: FIRM_ID, clientUserId: CLIENT_UID, category: 'message',
    })).toBe(true);
  });

  test('the firm master switch suppresses even a client who opted in', async () => {
    mockLawFirms.set(FIRM_ID, { emailNotificationsEnabled: false });
    mockClients.set(`${FIRM_ID}:${CLIENT_UID}`, { notifications: { emailOnNewMessage: true } });
    expect(await shouldSendClientEmail({
      lawFirmId: FIRM_ID, clientUserId: CLIENT_UID, category: 'message',
    })).toBe(false);
  });

  test('the client opt-out suppresses a send the firm still allows', async () => {
    mockClients.set(`${FIRM_ID}:${CLIENT_UID}`, { notifications: { emailOnFileShared: false } });
    expect(await shouldSendClientEmail({
      lawFirmId: FIRM_ID, clientUserId: CLIENT_UID, category: 'fileShared',
    })).toBe(false);
  });

  test('resolves by clients-row id when that is the id the caller holds', async () => {
    mockClients.set(`${FIRM_ID}:${CLIENT_ID}`, { notifications: { emailOnFileShared: false } });
    expect(await shouldSendClientEmail({
      lawFirmId: FIRM_ID, clientId: CLIENT_ID, category: 'fileShared',
    })).toBe(false);
  });

  test('with no client id at all, only the firm switch applies', async () => {
    expect(await shouldSendClientEmail({ lawFirmId: FIRM_ID, category: 'message' })).toBe(true);
    mockLawFirms.set(FIRM_ID, { emailNotificationsEnabled: false });
    expect(await shouldSendClientEmail({ lawFirmId: FIRM_ID, category: 'message' })).toBe(false);
  });

  test('a transactional category is sent even with the firm switch off', async () => {
    mockLawFirms.set(FIRM_ID, { emailNotificationsEnabled: false });
    expect(await shouldSendClientEmail({
      lawFirmId: FIRM_ID, clientUserId: CLIENT_UID, category: 'paymentReceipt',
    })).toBe(true);
  });

  test('fails open when the database throws', async () => {
    mockLawFirms.set(FIRM_ID, { emailNotificationsEnabled: false });
    mockFailQueries = true;
    expect(await shouldSendClientEmail({
      lawFirmId: FIRM_ID, clientUserId: CLIENT_UID, category: 'message',
    })).toBe(true);
  });
});

describe('filterEmailRecipientsByPreference', () => {
  test('drops only recipients who opted out, keeping unknown/absent rows enabled', async () => {
    // "taskAssigned" has no shipped default in the mocked DEFAULTS, so an
    // absent stored preference falls through to plain enabled.
    mockUserSettings.set('user-1', { notifications: { email: { taskAssigned: false } } });
    mockUserSettings.set('user-2', { notifications: { email: { taskAssigned: true } } });
    // user-3 has no stored row at all.
    const result = await filterEmailRecipientsByPreference(['user-1', 'user-2', 'user-3'], 'taskAssigned');
    expect(result.sort()).toEqual(['user-2', 'user-3']);
  });

  test('dedupes the input id list', async () => {
    mockUserSettings.set('user-1', { notifications: { email: { digest: true } } });
    const result = await filterEmailRecipientsByPreference(['user-1', 'user-1', 'user-1'], 'digest');
    expect(result).toEqual(['user-1']);
  });

  test('fails open, returning every input id, when the database throws', async () => {
    mockUserSettings.set('user-1', { notifications: { email: { digest: false } } });
    mockUserSettings.set('user-2', { notifications: { email: { digest: false } } });
    mockFailQueries = true;
    const result = await filterEmailRecipientsByPreference(['user-1', 'user-2'], 'digest');
    expect(result.sort()).toEqual(['user-1', 'user-2']);
  });

  test('a transactional category bypasses the database entirely', async () => {
    mockFailQueries = true; // would throw if a query were attempted
    const result = await filterEmailRecipientsByPreference(['user-1', 'user-2'], 'invitation');
    expect(result.sort()).toEqual(['user-1', 'user-2']);
  });
});

describe('getEmailPrefsForUsers', () => {
  test('returns a Map keyed by user id, covering every id in a single query', async () => {
    mockUserSettings.set('user-1', { notifications: { email: { digest: false } } });
    mockUserSettings.set('user-2', { notifications: { email: { digest: true } } });
    const prefs = await getEmailPrefsForUsers(['user-1', 'user-2', 'user-3']);
    expect(prefs.get('user-1')).toEqual({ notifications: { email: { digest: false } } });
    expect(prefs.get('user-2')).toEqual({ notifications: { email: { digest: true } } });
    expect(prefs.has('user-3')).toBe(false); // no stored row
  });

  test('an empty input returns an empty Map without querying', async () => {
    mockFailQueries = true; // would throw if a query were attempted
    const prefs = await getEmailPrefsForUsers([]);
    expect(prefs.size).toBe(0);
  });

  // This is the one loader that deliberately does NOT swallow a DB error: a
  // caller doing its own batching needs to know the read failed so it can
  // decide what to do. `filterEmailRecipientsByPreference` is the layer that
  // turns that throw into the fail-open default. Adding a catch here would
  // silently make that path unreachable.
  test('propagates a database error instead of failing open', async () => {
    mockFailQueries = true;
    await expect(getEmailPrefsForUsers(['user-1'])).rejects.toThrow('Failed query');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
