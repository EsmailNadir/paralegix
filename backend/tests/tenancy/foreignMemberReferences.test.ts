/**
 * B02 A06: foreign MEMBER references in a JSON body.
 *
 * `foreignClientWrites.test.ts` covers the client/matter half of this class.
 * This file covers the other half: a route that accepts a user id in the body
 * (a task assignee, a subtask assignee, a matter-member target) and hands work
 * or firm access to whoever that id names, without first asking whether the id
 * belongs to anyone this firm has a relationship with.
 *
 * `assertLawFirmMemberships` and `assertMatterMemberships`
 * (`src/shared/utils/membership.ts`) are the two shared gates every route below
 * goes through. Both refuse the write, which is the easy half. The part that
 * went untested is what the REFUSAL discloses: both used to resolve the
 * supplied id to a display name via an UNSCOPED `select ... from users where
 * id = any($1)` and put that name in the error message. `users` is a global
 * table with no tenant column, so the id in the body did not have to belong to
 * anyone in this firm, or in any firm the caller has ever heard of, for its
 * owner's real name (or email, the coalesce fallback) to come back in a 403.
 *
 * A caller only needs to know (or guess, or recall from a past job) somebody's
 * Firebase UID; this endpoint would confirm they still exist and hand back
 * their current name, for a person the caller shares no firm with at all.
 *
 * Fixed in `src/shared/utils/membership.ts`:
 *   - `assertLawFirmMemberships` no longer resolves a name at all for a
 *     non-member. There is no tenant-safe scope for that lookup: by
 *     definition these ids are not members of the firm being asked about, so
 *     nothing distinguishes "a colleague who left five minutes ago" from "a
 *     stranger at an unrelated firm". The raw id is used instead.
 *   - `assertMatterMemberships` still resolves a name, but the lookup is now
 *     scoped to `members` filtered by THIS firm's `law_firm_id`, so a name
 *     only comes back for an outsider who is a genuine colleague not yet
 *     staffed on this particular matter (the ordinary, same-tenant case this
 *     message exists for). Anyone outside the firm still falls back to their
 *     raw id.
 */
import {
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let home: Firm;
let owner: Actor;
let matterId: string;

/** A different firm, entirely unrelated to `home`. */
let stranger: Firm;

const body = (res: any) => JSON.stringify(res.body ?? {});

beforeEach(async () => {
  home = await createFirm({ name: 'Home Firm' });
  owner = await ownerOf(home.id);
  stranger = await createFirm({ name: 'Stranger Firm' });

  const client = await createPersonClient(home.id, { name: 'Home Client' });
  const matter = await owner.api.post(`/api/lawfirms/${home.id}/matters`).send({
    name: 'Home Matter', clients: [{ clientId: client.id, name: 'Home Client' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

describe('task assignee: a matter task assigned to a member of another firm', () => {
  it('refuses to create the task', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Very Secret Outsider' });

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Draft the motion', matterId, assignedTo: [outsider.uid],
    });

    expect(res.status).toBe(403);
  });

  it('does NOT disclose the outsider name or email in the refusal', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Very Secret Outsider' });

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Draft the motion', matterId, assignedTo: [outsider.uid],
    });

    expect(body(res)).not.toContain('Very Secret Outsider');
    expect(body(res)).not.toContain(`${outsider.uid}@example.test`);
  });

  it('creates no task at all, rather than one with the assignment dropped', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Very Secret Outsider' });

    await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Draft the motion', matterId, assignedTo: [outsider.uid],
    });

    const { testPool } = require('../support/setupInProcess');
    const { rows } = await testPool.query(
      'select id from tasks where law_firm_id = $1', [home.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('still names a same-firm colleague not yet on the matter (the safe, intended case)', async () => {
    // The positive control for the fix. A colleague who exists in THIS firm but
    // has not been added to this matter is a routine, tenant-safe case: naming
    // them is what lets the caller act on "add this person to the matter" rather
    // than staring at an opaque id. The fix must not have thrown this out along
    // with the cross-tenant leak.
    const colleague = await createFirmMember(home.id, { name: 'Pat Colleague' });

    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Draft the motion', matterId, assignedTo: [colleague.uid],
    });

    expect(res.status).toBe(403);
    expect(body(res)).toContain('Pat Colleague');
  });

  it('still allows assigning an actual matter member', async () => {
    // The ordinary positive path, so "refuse every assignee" cannot pass this file.
    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`).send({
      title: 'Draft the motion', matterId, assignedTo: [owner.uid],
    });

    expect(res.status).toBe(201);
  });
});

describe('task assignee: updating an existing task to a foreign-firm assignee', () => {
  let taskId: string;

  beforeEach(async () => {
    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`)
      .send({ title: 'Existing task', matterId });
    taskId = res.body.taskId;
    await drainEvents();
  });

  it('refuses the update and discloses nothing', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Another Secret Outsider' });

    const res = await owner.api.put(`/api/lawfirms/${home.id}/tasks/${taskId}`)
      .send({ assignedTo: [outsider.uid] });

    expect(res.status).toBe(403);
    expect(body(res)).not.toContain('Another Secret Outsider');
  });
});

describe('subtask assignee: a foreign-firm user', () => {
  let taskId: string;

  beforeEach(async () => {
    const res = await owner.api.post(`/api/lawfirms/${home.id}/tasks`)
      .send({ title: 'Parent task', matterId });
    taskId = res.body.taskId;
    await drainEvents();
  });

  it('refuses the assignment and discloses nothing', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Subtask Secret Outsider' });

    const res = await owner.api
      .post(`/api/lawfirms/${home.id}/tasks/${taskId}/subtasks`)
      .send({ title: 'A subtask', assigneeUserId: outsider.uid });

    expect(res.status).toBe(403);
    expect(body(res)).not.toContain('Subtask Secret Outsider');
  });
});

describe('matter members: adding a foreign-firm user directly to a matter', () => {
  it('refuses and discloses nothing', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Roster Secret Outsider' });

    const res = await owner.api
      .post(`/api/lawfirms/${home.id}/matters/${matterId}/members`)
      .send({ targetUserIds: [outsider.uid] });

    expect(res.status).toBe(403);
    expect(body(res)).not.toContain('Roster Secret Outsider');
  });
});

describe('bulk-add-member: a foreign-firm target user', () => {
  it('refuses and discloses nothing, on the write endpoint', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Bulk Secret Outsider' });

    const res = await owner.api
      .post(`/api/lawfirms/${home.id}/matters/bulk-add-member`)
      .send({ userId: outsider.uid, matterIds: [matterId] });

    expect(res.status).toBe(403);
    expect(body(res)).not.toContain('Bulk Secret Outsider');
  });

  it('refuses and discloses nothing, on the preview endpoint', async () => {
    const outsider = await createFirmMember(stranger.id, { name: 'Preview Secret Outsider' });

    const res = await owner.api
      .post(`/api/lawfirms/${home.id}/matters/bulk-add-member/preview`)
      .send({ userId: outsider.uid, matterIds: [matterId] });

    expect(res.status).toBe(403);
    expect(body(res)).not.toContain('Preview Secret Outsider');
  });

  it('still allows bulk-adding an actual firm member', async () => {
    const colleague = await createFirmMember(home.id, { name: 'Real Colleague' });

    const res = await owner.api
      .post(`/api/lawfirms/${home.id}/matters/bulk-add-member`)
      .send({ userId: colleague.uid, matterIds: [matterId] });

    expect(res.status).toBe(200);
    expect(res.body.added).toContain(matterId);
  });
});
