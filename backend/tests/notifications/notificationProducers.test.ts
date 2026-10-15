/**
 * Notification PRODUCERS, driven through the real routes.
 *
 * `tests/notifications/notificationOwnership.test.ts` covers the seven read/write
 * routes on `/api/lawfirms/:lawFirmId/notifications`. Nothing covered the 20
 * listeners in `notifications.events.ts` and its siblings that actually create
 * those rows: dropping a listener, or narrowing its recipient query, changes
 * no screen and nothing else in the suite would catch it.
 *
 * Each case here does the real action, drains the event bus, then reads the
 * `notifications` table directly rather than through the read API, so a route
 * bug can never mask a producer bug. Each asserts three things together where
 * relevant: the exact recipient set (a second member who must NOT receive it
 * is always seeded), that the actor never notifies themselves, and that the
 * deep link (`action_url`) carries the entity id rather than a bare list URL.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  ownerOf,
  memberWith,
} from '../support/setupInProcess';

async function notificationsFor(lawFirmId: string, type: string) {
  const { rows } = await testPool.query(
    `select user_id, entity_id, action_url, created_by, title, body
       from notifications where law_firm_id = $1 and type = $2
       order by user_id`,
    [lawFirmId, type],
  );
  return rows;
}

describe('matter_added: creating a matter with another lead notifies them', () => {
  it('notifies the added lead, not the creator, with a deep link to the matter', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const lead = await memberWith(firmId, ['matters.view']);
    const bystander = await memberWith(firmId, ['matters.view']);

    const res = await owner.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send({ name: 'Estate of Rivera', leadUserIds: [lead.uid] });
    expect(res.status).toBe(201);
    await drainEvents();

    const rows = await notificationsFor(firmId, 'matter_added');
    expect(rows.map((r: any) => r.user_id)).toEqual([lead.uid]);
    expect(rows[0].entity_id).toBe(res.body.matterId);
    expect(rows[0].action_url).toBe(
      `${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${firmId}/matters/${res.body.matterId}`,
    );
    expect(rows[0].created_by).toBe(owner.uid);
    expect(rows.map((r: any) => r.user_id)).not.toContain(bystander.uid);
  });

  it('does not notify the creator when they name themselves as the only lead', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);

    const res = await owner.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send({ name: 'Solo-led matter' });
    expect(res.status).toBe(201);
    await drainEvents();

    const rows = await notificationsFor(firmId, 'matter_added');
    expect(rows).toHaveLength(0);
  });

  it('never notifies a member of a different firm', async () => {
    const { id: firmId } = await createFirm();
    const { id: otherFirmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const lead = await memberWith(firmId, ['matters.view']);
    await ownerOf(otherFirmId);

    await owner.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send({ name: 'Cross-firm isolation check', leadUserIds: [lead.uid] });
    await drainEvents();

    const otherFirmRows = await notificationsFor(otherFirmId, 'matter_added');
    expect(otherFirmRows).toHaveLength(0);
  });
});

describe('member_role_changed: changing a colleague role notifies them', () => {
  async function seedRole(lawFirmId: string, permissions: string[]): Promise<string> {
    const id = randomUUID();
    await testPool.query(
      `insert into roles (id, law_firm_id, name, is_built_in, permissions)
       values ($1, $2, $3, false, $4)`,
      [id, lawFirmId, `Role ${id.slice(0, 8)}`, permissions],
    );
    return id;
  }

  it('notifies the member whose role changed, naming the new role, not the actor who changed it', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.view']);
    const bystander = await memberWith(firmId, ['matters.view']);
    const newRoleId = await seedRole(firmId, ['matters.view', 'tasks.view']);

    const res = await owner.api
      .put(`/api/lawfirms/${firmId}/members/${member.uid}/role`)
      .send({ roleId: newRoleId });
    expect(res.status).toBe(200);
    await drainEvents();

    const rows = await notificationsFor(firmId, 'member_role_changed');
    expect(rows.map((r: any) => r.user_id)).toEqual([member.uid]);
    expect(rows[0].created_by).toBe(owner.uid);
    expect(rows[0].body).toContain(res.body.roleName);

    expect(rows.map((r: any) => r.user_id)).not.toContain(owner.uid);
    expect(rows.map((r: any) => r.user_id)).not.toContain(bystander.uid);
  });
});

describe('intake_submitted: a public intake submission notifies the firm side', () => {
  async function seedIntakeTemplate(lawFirmId: string): Promise<{ publicToken: string }> {
    const publicToken = `pt-${randomUUID()}`;
    await testPool.query(
      `insert into intake_form_templates
         (id, law_firm_id, name, public_token, fields, is_active)
       values ($1, $2, 'General Intake', $3, $4::jsonb, true)`,
      [
        randomUUID(),
        lawFirmId,
        publicToken,
        JSON.stringify([
          { key: 'full_name', label: 'Full name', type: 'text', required: true },
          { key: 'email', label: 'Email', type: 'email', required: true },
        ]),
      ],
    );
    return { publicToken };
  }

  it('notifies the owner and leads.view/leads.manage holders, not a member without either', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const leadHandler = await memberWith(firmId, ['leads.view']);
    const uninvolved = await memberWith(firmId, ['matters.view']);
    const { publicToken } = await seedIntakeTemplate(firmId);

    const submitRes = await request()
      .post(`/api/intake/${publicToken}/submit`)
      .send({ fieldValues: { full_name: 'Dana Reed', email: 'dana@example.test' } });
    expect(submitRes.status).toBe(201);
    await drainEvents();

    const rows = await notificationsFor(firmId, 'intake_submitted');
    const recipients = rows.map((r: any) => r.user_id).sort();
    expect(recipients).toEqual([leadHandler.uid, owner.uid].sort());
    expect(recipients).not.toContain(uninvolved.uid);
  });
});
