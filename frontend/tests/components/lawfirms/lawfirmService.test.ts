/**
 * The law firm service, tested OFFLINE against a fake transport.
 *
 * `lawfirmLogoUpload.test.ts` next door owns the three-step logo upload. This
 * file takes everything else: creating a firm, the member roster and the
 * caller's own membership, invitations, role changes, removal, leaving and
 * deleting a firm.
 *
 * THE FIRM ID IS THE HAZARD. Every route here is `/lawfirms/{id}/...`, and the
 * id is the tenant boundary. So every case matches the COMPLETE pathname with
 * `getExact`/`postExact`: a request that lands on another firm, or on the right
 * firm's wrong sub-route, matches nothing and the transport throws.
 *
 * Membership mutations (invite, role change, removal) get exact BODY assertions
 * too. A role id sent under the wrong key, or a member id that ends up in the
 * body instead of the path, changes who can see what in the firm and reports
 * success either way.
 */
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import lawFirmService from '@/services/lawfirm.service';
import { ApiError, NETWORK_UNREACHABLE_CODE } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const FIRMS = '/api/lawfirms';
const FIRM = `${FIRMS}/${LAW_FIRM_ID}`;

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

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError & { eligibleMembers?: unknown }> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError & { eligibleMembers?: unknown },
  );
}

describe('creating a firm', () => {
  it('POSTs the firm details to create-lawfirm and returns the created firm', async () => {
    const created = { message: 'Law firm created', lawFirm: { id: 'firm-new', name: 'Roe & Partners' } };
    api.postExact(`${FIRMS}/create-lawfirm`, { status: 201, body: created });

    const result = await lawFirmService.createLawFirm({ name: 'Roe & Partners', firmSize: '2-10', practiceArea: 'Family' });

    expect(onlyCall('POST').body).toEqual({ name: 'Roe & Partners', firmSize: '2-10', practiceArea: 'Family' });
    expect(result).toEqual(created);
  });

  it('throws the server reason when the create is refused', async () => {
    api.postExact(`${FIRMS}/create-lawfirm`, { status: 409, body: { error: 'You already own a firm' } });

    const error = await rejectionOf(lawFirmService.createLawFirm({ name: 'Dup' }));
    expect(error.message).toBe('You already own a firm');
    expect(error.status).toBe(409);
  });
});

describe('reading a firm', () => {
  it('unwraps a { lawFirm } envelope', async () => {
    api.getExact(FIRM, { lawFirm: { id: LAW_FIRM_ID, name: 'Roe & Partners' } });

    await expect(lawFirmService.getLawFirmById(LAW_FIRM_ID)).resolves.toEqual({ id: LAW_FIRM_ID, name: 'Roe & Partners' });
    expect(onlyCall('GET').headers.authorization).toMatch(/^Bearer /);
  });

  it('accepts a bare firm object as well', async () => {
    api.getExact(FIRM, { id: LAW_FIRM_ID, name: 'Roe & Partners' });

    await expect(lawFirmService.getLawFirmById(LAW_FIRM_ID)).resolves.toEqual({ id: LAW_FIRM_ID, name: 'Roe & Partners' });
  });

  it('returns null for an envelope whose lawFirm is null', async () => {
    api.getExact(FIRM, { lawFirm: null });

    await expect(lawFirmService.getLawFirmById(LAW_FIRM_ID)).resolves.toBeNull();
  });

  it('throws when the firm read is refused', async () => {
    api.getExact(FIRM, { status: 403, body: { error: 'Not a member of this firm' } });

    const error = await rejectionOf(lawFirmService.getLawFirmById(LAW_FIRM_ID));
    expect(error.status).toBe(403);
    expect(error.message).toBe('Not a member of this firm');
  });
});

describe('the workspace read retries a cold start once', () => {
  it('retries an unreachable API and returns the firm from the second attempt', async () => {
    api.getExact(FIRM, sequence(
      () => { throw new TypeError('Failed to fetch'); },
      { lawFirm: { id: LAW_FIRM_ID } },
    ));

    await expect(lawFirmService.getLawFirmForWorkspace(LAW_FIRM_ID)).resolves.toEqual({ id: LAW_FIRM_ID });
    expect(api.calls('GET')).toHaveLength(2);
  });

  it('gives up after one retry and surfaces the unreachable error', async () => {
    api.getExact(FIRM, () => { throw new TypeError('Failed to fetch'); });

    const error = await rejectionOf(lawFirmService.getLawFirmForWorkspace(LAW_FIRM_ID));

    expect(error.code).toBe(NETWORK_UNREACHABLE_CODE);
    expect(api.calls('GET')).toHaveLength(2);
  });

  it('does not retry a refusal, which a second attempt cannot fix', async () => {
    api.getExact(FIRM, { status: 403, body: { error: 'Forbidden' } });

    const error = await rejectionOf(lawFirmService.getLawFirmForWorkspace(LAW_FIRM_ID));

    expect(error.status).toBe(403);
    expect(api.calls('GET')).toHaveLength(1);
  });
});

describe('members', () => {
  it('reads the roster from a { members } envelope', async () => {
    api.getExact(`${FIRM}/members`, { members: [{ id: 'u-1' }, { id: 'u-2' }] });

    await expect(lawFirmService.getLawFirmMembers(LAW_FIRM_ID)).resolves.toEqual([{ id: 'u-1' }, { id: 'u-2' }]);
  });

  it('accepts a bare array roster', async () => {
    api.getExact(`${FIRM}/members`, [{ id: 'u-1' }]);

    await expect(lawFirmService.getLawFirmMembers(LAW_FIRM_ID)).resolves.toEqual([{ id: 'u-1' }]);
  });

  it('returns an empty roster for an envelope with no members key', async () => {
    api.getExact(`${FIRM}/members`, {});

    await expect(lawFirmService.getLawFirmMembers(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('reads the caller membership from members/me and unwraps it', async () => {
    api.getExact(`${FIRM}/members/me`, { member: { userId: 'u-1', permissions: ['matters.read'] } });

    await expect(lawFirmService.getMyMembership(LAW_FIRM_ID)).resolves.toEqual({ userId: 'u-1', permissions: ['matters.read'] });
  });

  it('returns null when the member key is present but null', async () => {
    api.getExact(`${FIRM}/members/me`, { member: null });

    await expect(lawFirmService.getMyMembership(LAW_FIRM_ID)).resolves.toBeNull();
  });

  it('accepts a bare membership object', async () => {
    api.getExact(`${FIRM}/members/me`, { userId: 'u-1' });

    await expect(lawFirmService.getMyMembership(LAW_FIRM_ID)).resolves.toEqual({ userId: 'u-1' });
  });

  it('surfaces a non-member 403 as an ApiError for the caller to interpret', async () => {
    api.getExact(`${FIRM}/members/me`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await rejectionOf(lawFirmService.getMyMembership(LAW_FIRM_ID));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.isForbidden).toBe(true);
  });

  it('PUTs a role change to the member route with only the role id in the body', async () => {
    api.putExact(`${FIRM}/members/u-2/role`, { message: 'Role updated', roleId: 'role-admin', roleName: 'Admin' });

    const result = await lawFirmService.changeMemberRole(LAW_FIRM_ID, 'u-2', 'role-admin');

    expect(onlyCall('PUT').body).toEqual({ roleId: 'role-admin' });
    expect(result).toEqual({ message: 'Role updated', roleId: 'role-admin', roleName: 'Admin' });
  });

  it('DELETEs one member by id', async () => {
    api.deleteExact(`${FIRM}/members/u-2`, { status: 204 });

    await expect(lawFirmService.removeMemberFromLawFirm(LAW_FIRM_ID, 'u-2')).resolves.toBeUndefined();
    expect(onlyCall('DELETE').pathname).toBe(`${FIRM}/members/u-2`);
  });

  it('throws when a member removal is refused', async () => {
    api.deleteExact(`${FIRM}/members/u-2`, { status: 409, body: { error: 'Cannot remove the last admin' } });

    const error = await rejectionOf(lawFirmService.removeMemberFromLawFirm(LAW_FIRM_ID, 'u-2'));
    expect(error.message).toBe('Cannot remove the last admin');
  });
});

describe('member invitations', () => {
  const INVITES = `${FIRM}/invitations`;

  it('POSTs an invite with exactly the email and role', async () => {
    api.postExact(`${INVITES}/invite-member`, { message: 'Invitation sent', invitedUserId: 'u-9' });

    const result = await lawFirmService.inviteUserToLawFirm('new@roe.test', LAW_FIRM_ID, 'role-member');

    expect(onlyCall('POST').body).toEqual({ email: 'new@roe.test', roleId: 'role-member' });
    expect(result).toEqual({ message: 'Invitation sent', invitedUserId: 'u-9' });
  });

  it('lists pending invites', async () => {
    const invite = { id: 'inv-1', email: 'new@roe.test', status: 'pending' };
    api.getExact(`${INVITES}/pending-member-invites`, { invites: [invite] });

    await expect(lawFirmService.listPendingMemberInvites(LAW_FIRM_ID)).resolves.toEqual([invite]);
  });

  it('returns no invites when the key is not an array', async () => {
    api.getExact(`${INVITES}/pending-member-invites`, { invites: { id: 'inv-1' } });

    await expect(lawFirmService.listPendingMemberInvites(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('resends one invite by id in the body', async () => {
    api.postExact(`${INVITES}/resend-member-invite`, { message: 'Resent', sent: true, resendCount: 2 });

    const result = await lawFirmService.resendMemberInvitation(LAW_FIRM_ID, 'inv-1');

    expect(onlyCall('POST').body).toEqual({ inviteId: 'inv-1' });
    expect(result).toEqual({ message: 'Resent', sent: true, resendCount: 2 });
  });

  it('revokes one invite by id in the path, with no body', async () => {
    api.postExact(`${INVITES}/member-invites/inv-1/revoke`, { message: 'Revoked', inviteId: 'inv-1' });

    const result = await lawFirmService.revokeMemberInvitation(LAW_FIRM_ID, 'inv-1');

    expect(onlyCall('POST').body).toBeNull();
    expect(result).toEqual({ message: 'Revoked', inviteId: 'inv-1' });
  });
});

describe('updating, leaving and deleting a firm', () => {
  it('PUTs the edited fields and returns the body as the firm', async () => {
    api.putExact(FIRM, { id: LAW_FIRM_ID, name: 'Roe LLP' });

    const firm = await lawFirmService.updateLawFirm(LAW_FIRM_ID, { name: 'Roe LLP' });

    expect(onlyCall('PUT').body).toEqual({ name: 'Roe LLP' });
    expect(firm).toEqual({ id: LAW_FIRM_ID, name: 'Roe LLP' });
  });

  it('leaves with an empty object when no options are given', async () => {
    api.postExact(`${FIRM}/leave`, { message: 'Left the firm' });

    await expect(lawFirmService.leaveLawFirm(LAW_FIRM_ID)).resolves.toEqual({ message: 'Left the firm' });
    expect(onlyCall('POST').body).toEqual({});
  });

  it('leaves handing admin to the named member', async () => {
    api.postExact(`${FIRM}/leave`, { message: 'Left the firm' });

    await lawFirmService.leaveLawFirm(LAW_FIRM_ID, { newAdminUserId: 'u-2' });

    expect(onlyCall('POST').body).toEqual({ newAdminUserId: 'u-2' });
  });

  it('carries the eligible successors on a refused leave', async () => {
    const eligibleMembers = [{ userId: 'u-2', name: 'Jane Roe' }];
    api.postExact(`${FIRM}/leave`, {
      status: 409,
      body: { error: 'Choose a new admin first', code: 'ADMIN_TRANSFER_REQUIRED', details: { eligibleMembers } },
    });

    const error = await rejectionOf(lawFirmService.leaveLawFirm(LAW_FIRM_ID));

    // The leave dialog renders this list as the admin picker. Without it the
    // only admin of a firm can never leave.
    expect(error.message).toBe('Choose a new admin first');
    expect(error.code).toBe('ADMIN_TRANSFER_REQUIRED');
    expect(error.eligibleMembers).toEqual(eligibleMembers);
  });

  it('DELETEs the firm and returns the body', async () => {
    api.deleteExact(FIRM, { message: 'Law firm deleted' });

    await expect(lawFirmService.deleteLawFirm(LAW_FIRM_ID)).resolves.toEqual({ message: 'Law firm deleted' });
  });
});

/**
 * Each mutation checks `response.ok` itself. When the server sends no reason,
 * the message the user reads is the method's own fallback, so each row pins
 * that its OWN guard ran.
 */
describe('a mutation refused with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, 'post' | 'put' | 'delete', string, () => Promise<unknown>, string]> = [
    ['createLawFirm', 'post', `${FIRMS}/create-lawfirm`, () => lawFirmService.createLawFirm({ name: 'n' }), 'Failed to create law firm'],
    ['inviteUserToLawFirm', 'post', `${FIRM}/invitations/invite-member`, () => lawFirmService.inviteUserToLawFirm('a@b.test', LAW_FIRM_ID, 'r'), 'Failed to invite user'],
    ['resendMemberInvitation', 'post', `${FIRM}/invitations/resend-member-invite`, () => lawFirmService.resendMemberInvitation(LAW_FIRM_ID, 'inv-1'), 'Failed to resend invitation'],
    ['revokeMemberInvitation', 'post', `${FIRM}/invitations/member-invites/inv-1/revoke`, () => lawFirmService.revokeMemberInvitation(LAW_FIRM_ID, 'inv-1'), 'Failed to revoke invitation'],
    ['changeMemberRole', 'put', `${FIRM}/members/u-2/role`, () => lawFirmService.changeMemberRole(LAW_FIRM_ID, 'u-2', 'r'), 'Failed to change member role'],
    ['updateLawFirm', 'put', FIRM, () => lawFirmService.updateLawFirm(LAW_FIRM_ID, {}), 'Failed to update law firm'],
    ['removeMemberFromLawFirm', 'delete', `${FIRM}/members/u-2`, () => lawFirmService.removeMemberFromLawFirm(LAW_FIRM_ID, 'u-2'), 'Failed to remove member'],
    ['leaveLawFirm', 'post', `${FIRM}/leave`, () => lawFirmService.leaveLawFirm(LAW_FIRM_ID), 'Failed to leave law firm'],
    ['deleteLawFirm', 'delete', FIRM, () => lawFirmService.deleteLawFirm(LAW_FIRM_ID), 'Failed to delete law firm'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    ({ post: api.postExact, put: api.putExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});
