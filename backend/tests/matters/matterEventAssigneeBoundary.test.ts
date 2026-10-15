/**
 * Matter-event assignees receive event reminders. They therefore need the same
 * matter-membership gate as task assignees; firm membership alone would email
 * restricted matter details across an ethical wall.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let matterId: string;

const E = (suffix = '') => `/api/lawfirms/${firm.id}/matters/${matterId}/events${suffix}`;

async function createEvent(body: Record<string, unknown> = {}) {
  return owner.api.post(E()).send({
    type: 'hearing',
    title: 'Confidential hearing',
    date: '2026-12-10',
    ...body,
  });
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Restricted hearing matter', $3)`,
    [matterId, firm.id, `REF-${matterId.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [firm.id, matterId, owner.uid],
  );
});

describe('matter-event assignees respect the matter boundary', () => {
  it('refuses creating an event assigned to a firm member outside the matter', async () => {
    const outsider = await memberWith(firm.id, ['matters.view']);

    const created = await createEvent({ assignedTo: [outsider.uid] });

    expect(created.status).toBe(403);
    const { rows } = await testPool.query(
      'select 1 from events where law_firm_id = $1 and matter_id = $2',
      [firm.id, matterId],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses reassigning an event to a firm member outside the matter', async () => {
    const outsider = await memberWith(firm.id, ['matters.view']);
    const created = await createEvent();
    expect(created.status).toBe(201);

    const updated = await owner.api.put(E(`/${created.body.eventId}`))
      .send({ assignedTo: [outsider.uid] });

    expect(updated.status).toBe(403);
    const { rows } = await testPool.query(
      `select coalesce(array_agg(user_id), '{}') as assigned_to
         from event_assignees where event_id = $1`,
      [created.body.eventId],
    );
    expect(rows[0].assigned_to).toEqual([]);
  });

  it('allows assigning a matter event to another member of that matter', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, matterId, colleague.uid],
    );

    const created = await createEvent({ assignedTo: [colleague.uid] });

    expect(created.status).toBe(201);
    expect(created.body.event.assignedTo).toEqual([colleague.uid]);
  });
});
