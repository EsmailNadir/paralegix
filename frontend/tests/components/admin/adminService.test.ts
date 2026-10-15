/**
 * The platform admin service, tested OFFLINE against a fake transport.
 *
 * This is the console that acts ACROSS firms: it changes another firm's plan,
 * comps or cancels its subscription, grants platform admin, and removes members
 * from firms the operator does not belong to. Nothing here is tenant-scoped by
 * the caller's own membership, so the id in the path is the only thing that
 * decides which firm a change lands on. Every case therefore matches the
 * COMPLETE pathname and query with `getExact`/`patchExact`: a request that
 * lands on another firm, member or invite matches nothing and the transport
 * throws.
 *
 * The list reads build their query from an object, and the console's cards are
 * drawn from the defaults this layer fills in when the server omits `stats`, so
 * both the serialization and the defaults are pinned exactly.
 */
jest.unmock('@/services/admin.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import adminService from '@/services/admin.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const ADMIN = '/api/admin';
const FIRM_ID = 'firm-1';
const FIRM = `${ADMIN}/lawfirms/${FIRM_ID}`;
const MB = 1024 * 1024;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

describe('firm reads', () => {
  it('reads one firm detail by id and returns the body as is', async () => {
    const detail = { lawFirm: { id: FIRM_ID }, members: [], roles: [] };
    api.getExact(FIRM, detail);

    await expect(adminService.getLawFirmDetail(FIRM_ID)).resolves.toEqual(detail);
    expect(onlyCall('GET').headers.authorization).toMatch(/^Bearer /);
  });

  it('lists every firm, empty for an envelope with no lawFirms key', async () => {
    api.getExact(`${ADMIN}/lawfirms`, {});

    await expect(adminService.getLawFirms()).resolves.toEqual([]);
  });

  it('serializes a firm page query, trimming strings and dropping blanks', async () => {
    api.getExact(
      `${ADMIN}/lawfirms?page=2&limit=25&search=roe&sortBy=createdAt&order=desc&planId=pro`,
      { lawFirms: [{ id: FIRM_ID }], totalItems: 26, totalFirms: 140, stats: { total: 140, new7d: 3, new30d: 9, byPlan: {}, byBillingStatus: {} } },
    );

    const page = await adminService.getLawFirmsPaged({
      page: 2, limit: 25, search: '  roe ', sortBy: 'createdAt', order: 'desc', planId: 'pro', billingStatus: '   ',
    });

    expect(page.totalItems).toBe(26);
    expect(page.totalFirms).toBe(140);
  });

  it('fills a bare firm page from the rows it has, with zeroed stats', async () => {
    api.getExact(`${ADMIN}/lawfirms`, { lawFirms: [{ id: 'a' }, { id: 'b' }] });

    await expect(adminService.getLawFirmsPaged()).resolves.toEqual({
      lawFirms: [{ id: 'a' }, { id: 'b' }],
      totalItems: 2,
      totalFirms: 2,
      stats: { total: 2, new7d: 0, new30d: 0, byPlan: {}, byBillingStatus: {} },
    });
  });

  it('looks up firms by trimmed search with a limit', async () => {
    api.getExact(`${ADMIN}/lawfirms/lookup?search=roe&limit=10`, { items: [{ value: FIRM_ID, label: 'Roe' }], hasMore: true });

    await expect(adminService.lookupLawFirms({ search: ' roe ', limit: 10 }))
      .resolves.toEqual({ items: [{ value: FIRM_ID, label: 'Roe' }], hasMore: true });
  });

  it('resolves labels by comma-joined ids, and defaults a bare body', async () => {
    api.getExact(`${ADMIN}/lawfirms/lookup?ids=firm-1,firm-2`, {});

    await expect(adminService.lookupLawFirms({ ids: ['firm-1', 'firm-2'] })).resolves.toEqual({ items: [], hasMore: false });
  });

  it('sends no query for a lookup with nothing to look up', async () => {
    api.getExact(`${ADMIN}/lawfirms/lookup`, { items: [] });

    await adminService.lookupLawFirms({ search: '   ' });

    expect(onlyCall('GET').search).toBe('');
  });

  it('reads the firm plan', async () => {
    const plan = { lawFirm: { id: FIRM_ID }, limits: { matters: 100 }, features: { trust: true }, usage: { matters: 4, members: 2, storageBytes: 10 } };
    api.getExact(`${FIRM}/plan`, plan);

    await expect(adminService.getLawFirmPlan(FIRM_ID)).resolves.toEqual(plan);
  });
});

describe('user and client reads', () => {
  it('lists every user, empty for a bare envelope', async () => {
    api.getExact(`${ADMIN}/users`, {});

    await expect(adminService.getUsers()).resolves.toEqual([]);
  });

  it('sends a boolean filter as its literal and keeps the server stats', async () => {
    const stats = { total: 9, clients: 4, firmMembers: 4, pending: 1, admins: 1, new24h: 0, new7d: 1, new30d: 2 };
    api.getExact(`${ADMIN}/users?userType=firm_member&isAdmin=false&lawFirmId=firm-1`, { users: [{ id: 'u-1' }], totalItems: 1, stats });

    const page = await adminService.getUsersPaged({ userType: 'firm_member', isAdmin: false, lawFirmId: FIRM_ID });

    // `isAdmin=false`, not dropped as falsy: "non-admins only" is a real filter.
    expect(page).toEqual({ users: [{ id: 'u-1' }], totalItems: 1, stats });
  });

  it('fills a bare user page with zeroed stats', async () => {
    api.getExact(`${ADMIN}/users`, { users: [{ id: 'u-1' }] });

    await expect(adminService.getUsersPaged()).resolves.toEqual({
      users: [{ id: 'u-1' }],
      totalItems: 1,
      stats: { total: 1, clients: 0, firmMembers: 0, pending: 0, admins: 0, new24h: 0, new7d: 0, new30d: 0 },
    });
  });

  it('serializes the client page filters', async () => {
    api.getExact(`${ADMIN}/clients?offset=0&portal=pending&clientType=company`, { clients: [], totalItems: 0, stats: { total: 0 } });

    await adminService.getClientsPaged({ offset: 0, portal: 'pending', clientType: 'company' });

    // `offset=0` survives: the guard is `== null`, not truthiness.
    expect(new URL(onlyCall('GET').url).searchParams.get('offset')).toBe('0');
  });

  it('fills a bare client page with zeroed stats', async () => {
    api.getExact(`${ADMIN}/clients`, {});

    await expect(adminService.getClientsPaged()).resolves.toEqual({
      clients: [],
      totalItems: 0,
      stats: {
        total: 0, withPortal: 0, invitesPending: 0, new7d: 0, new30d: 0,
        personCount: 0, companyCount: 0, rosterContactTotal: 0, rosterPortalTotal: 0, peopleTotal: 0,
      },
    });
  });

  it('serializes the audit filters, keeping a zero offset', async () => {
    const body = { events: [{ id: 'ae-1' }], total: 1 };
    api.getExact(`${ADMIN}/audit-events?limit=50&offset=0&action=login&actorUid=u-1&lawFirmId=firm-1&search=roe`, body);

    await expect(adminService.getAuditEvents({ limit: 50, offset: 0, action: 'login', actorUid: 'u-1', lawFirmId: FIRM_ID, search: 'roe' }))
      .resolves.toEqual(body);
  });

  it('sends no query for an unfiltered audit read', async () => {
    api.getExact(`${ADMIN}/audit-events`, { events: [] });

    await adminService.getAuditEvents();

    expect(onlyCall('GET').search).toBe('');
  });
});

describe('cross-firm writes address exactly one firm and one target', () => {
  it('PATCHes a firm role by firm and role id', async () => {
    api.patchExact(`${FIRM}/roles/role-1`, { message: 'Role updated' });

    await adminService.updateLawFirmRole(FIRM_ID, 'role-1', { name: 'Senior paralegal' } as never);

    expect(onlyCall('PATCH').body).toEqual({ name: 'Senior paralegal' });
  });

  it('PATCHes a member role with only the role id in the body', async () => {
    api.patchExact(`${FIRM}/members/u-2/role`, { message: 'Member role updated' });

    await adminService.updateMemberRole(FIRM_ID, 'u-2', 'role-admin');

    expect(onlyCall('PATCH').body).toEqual({ roleId: 'role-admin' });
  });

  it('PATCHes firm fields', async () => {
    api.patchExact(FIRM, { message: 'ok', lawFirm: { id: FIRM_ID } });

    await adminService.updateLawFirm(FIRM_ID, { name: 'Roe LLP' } as never);

    expect(onlyCall('PATCH').body).toEqual({ name: 'Roe LLP' });
  });

  it('removes one member, and deletes a member invite and a client invite on their own routes', async () => {
    api.deleteExact(`${FIRM}/members/u-2`, { message: 'removed' });
    api.deleteExact(`${FIRM}/pending-invites/inv-1`, { message: 'deleted' });
    api.deleteExact(`${FIRM}/pending-client-invites/inv-2`, { message: 'deleted' });

    await adminService.removeMember(FIRM_ID, 'u-2');
    await adminService.deletePendingInvite(FIRM_ID, 'inv-1');
    await adminService.deletePendingClientInvite(FIRM_ID, 'inv-2');

    expect(api.calls('DELETE').map((c) => c.pathname)).toEqual([
      `${FIRM}/members/u-2`,
      `${FIRM}/pending-invites/inv-1`,
      `${FIRM}/pending-client-invites/inv-2`,
    ]);
  });

  it('grants platform admin with an explicit boolean', async () => {
    api.patchExact(`${ADMIN}/users/u-1/admin`, { message: 'ok', user: { id: 'u-1', isAdmin: false } });

    await adminService.updateUserAdmin('u-1', false);

    expect(onlyCall('PATCH').body).toEqual({ isAdmin: false });
  });

  it('PATCHes a plan change, clearing a trial end with an explicit null', async () => {
    api.patchExact(`${FIRM}/plan`, { message: 'ok', lawFirm: { id: FIRM_ID } });

    await adminService.updateLawFirmPlan(FIRM_ID, { planId: 'pro', trialEndsAt: null, limitOverrides: { matters: 500 } });

    expect(onlyCall('PATCH').body).toEqual({ planId: 'pro', trialEndsAt: null, limitOverrides: { matters: 500 } });
  });

  it('recounts storage with a bodiless POST and returns the byte count', async () => {
    api.postExact(`${FIRM}/storage/recount`, { message: 'ok', usedBytes: 5 * MB, fileCount: 3, lawFirm: { id: FIRM_ID } });

    const result = await adminService.recountStorage(FIRM_ID);

    expect(onlyCall('POST').body).toBeNull();
    expect(result.usedBytes).toBe(5 * MB);
  });

  it('comps and cancels a subscription on their own sub-routes', async () => {
    api.postExact(`${FIRM}/subscription/comp`, { message: 'Comped' });
    api.postExact(`${FIRM}/subscription/cancel`, { message: 'Cancelled' });

    await adminService.compFirm(FIRM_ID, { planId: 'pro', reason: 'Design partner' });
    await adminService.adminCancelSubscription(FIRM_ID, { immediate: true, reason: 'Fraud' });

    const [comp, cancel] = api.calls('POST');
    expect(comp.body).toEqual({ planId: 'pro', reason: 'Design partner' });
    expect(cancel.body).toEqual({ immediate: true, reason: 'Fraud' });
  });

  it('returns undefined rather than a parse error for a 204', async () => {
    api.deleteExact(`${FIRM}/members/u-2`, { status: 204 });

    await expect(adminService.removeMember(FIRM_ID, 'u-2')).resolves.toBeUndefined();
  });
});

describe('the sign-up whitelist and test accounts', () => {
  it('lists whitelist entries, empty for a bare envelope', async () => {
    api.getExact(`${ADMIN}/whitelist`, {});

    await expect(adminService.getWhitelist()).resolves.toEqual([]);
  });

  it('adds an entry and removes one by email in a DELETE body', async () => {
    api.postExact(`${ADMIN}/whitelist`, { message: 'Added', email: 'jane@roe.test' });
    api.deleteExact(`${ADMIN}/whitelist`, { message: 'Removed', email: 'jane@roe.test' });

    await adminService.addWhitelistEntry({ email: 'jane@roe.test', note: 'Pilot' });
    await adminService.removeWhitelistEntry('jane@roe.test');

    expect(onlyCall('POST').body).toEqual({ email: 'jane@roe.test', note: 'Pilot' });
    const removal = onlyCall('DELETE');
    expect(removal.body).toEqual({ email: 'jane@roe.test' });
    expect(removal.headers['content-type']).toBe('application/json');
  });

  it('creates a test account and unwraps the account from the envelope', async () => {
    const account = { uid: 'u-t', email: 'test@roe.test', password: 'x', kind: 'client' };
    api.postExact(`${ADMIN}/test-accounts`, { account });

    const created = await adminService.createTestAccount({ kind: 'client', email: 'test@roe.test' } as never);

    expect(onlyCall('POST').body).toEqual({ kind: 'client', email: 'test@roe.test' });
    expect(created).toEqual(account);
  });
});

describe('a write refused with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, 'post' | 'patch' | 'delete', string, () => Promise<unknown>, string]> = [
    ['updateLawFirmRole', 'patch', `${FIRM}/roles/role-1`, () => adminService.updateLawFirmRole(FIRM_ID, 'role-1', {} as never), 'Failed to update role'],
    ['updateMemberRole', 'patch', `${FIRM}/members/u-2/role`, () => adminService.updateMemberRole(FIRM_ID, 'u-2', 'r'), 'Failed to update member role'],
    ['updateLawFirm', 'patch', FIRM, () => adminService.updateLawFirm(FIRM_ID, {} as never), 'Failed to update law firm'],
    ['removeMember', 'delete', `${FIRM}/members/u-2`, () => adminService.removeMember(FIRM_ID, 'u-2'), 'Failed to remove member'],
    ['deletePendingInvite', 'delete', `${FIRM}/pending-invites/inv-1`, () => adminService.deletePendingInvite(FIRM_ID, 'inv-1'), 'Failed to delete pending invite'],
    ['deletePendingClientInvite', 'delete', `${FIRM}/pending-client-invites/inv-2`, () => adminService.deletePendingClientInvite(FIRM_ID, 'inv-2'), 'Failed to delete pending client invite'],
    ['updateUserAdmin', 'patch', `${ADMIN}/users/u-1/admin`, () => adminService.updateUserAdmin('u-1', true), 'Failed to update user admin access'],
    ['updateLawFirmPlan', 'patch', `${FIRM}/plan`, () => adminService.updateLawFirmPlan(FIRM_ID, {}), 'Failed to update plan'],
    ['recountStorage', 'post', `${FIRM}/storage/recount`, () => adminService.recountStorage(FIRM_ID), 'Failed to recount storage'],
    ['compFirm', 'post', `${FIRM}/subscription/comp`, () => adminService.compFirm(FIRM_ID, { reason: 'r' }), 'Failed to comp firm'],
    ['adminCancelSubscription', 'post', `${FIRM}/subscription/cancel`, () => adminService.adminCancelSubscription(FIRM_ID, {}), 'Failed to cancel subscription'],
    ['addWhitelistEntry', 'post', `${ADMIN}/whitelist`, () => adminService.addWhitelistEntry({ email: 'a@b.test' }), 'Failed to add whitelist entry'],
    ['removeWhitelistEntry', 'delete', `${ADMIN}/whitelist`, () => adminService.removeWhitelistEntry('a@b.test'), 'Failed to remove whitelist entry'],
    ['createTestAccount', 'post', `${ADMIN}/test-accounts`, () => adminService.createTestAccount({} as never), 'Failed to create test account'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    ({ post: api.postExact, patch: api.patchExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
    expect(error.requestMethod).toBe(method.toUpperCase());
  });

  it('carries the server reason on a refused read', async () => {
    api.getExact(`${ADMIN}/users`, { status: 403, body: { error: 'Platform admin only' } });

    const error = await rejectionOf(adminService.getUsers());

    expect(error.message).toBe('Platform admin only');
    expect(error.status).toBe(403);
  });
});

describe('storage unit conversions', () => {
  it('converts a quota in bytes to MB rounded to two places, never below 1', () => {
    expect(adminService.quotaBytesToMb(1536 * 1024)).toBe(1.5);
    expect(adminService.quotaBytesToMb(10)).toBe(1);
    expect(adminService.quotaBytesToMb(0)).toBe(1);
    expect(adminService.quotaBytesToMb(Number.NaN)).toBe(1);
  });

  it('converts a quota in MB to whole bytes, never below 1 MB', () => {
    expect(adminService.quotaMbToBytes(2.5)).toBe(2.5 * MB);
    expect(adminService.quotaMbToBytes(0.1)).toBe(MB);
    expect(adminService.quotaMbToBytes(-3)).toBe(MB);
    expect(adminService.quotaMbToBytes(Number.POSITIVE_INFINITY)).toBe(MB);
  });

  it('converts a per-file limit in bytes to MB, zero for nothing', () => {
    expect(adminService.bytesToMb(MB + MB / 4)).toBe(1.25);
    expect(adminService.bytesToMb(-1)).toBe(0);
  });

  it('converts a per-file limit in MB to whole bytes, zero for nothing', () => {
    expect(adminService.mbToBytes(0.5)).toBe(MB / 2);
    expect(adminService.mbToBytes(0.0000001)).toBe(0);
    expect(adminService.mbToBytes(0)).toBe(0);
  });
});
