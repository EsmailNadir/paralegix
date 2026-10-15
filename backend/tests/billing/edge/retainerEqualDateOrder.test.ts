/**
 * Retainer allowance consumption when entries share a date: the covered entry is stable.
 */
import {
  testPool, createFirm, createPersonClient, ownerOf, drainEvents, type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const P = () => `/api/lawfirms/${firm.id}/billing/plans`;
const T = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

async function logTime(hours: number, date: string, rate = 200, description = 'Work') {
  const res = await owner.api.post(T()).send({
    clientId: client.id, userId: owner.uid, hours, date, hourlyRate: rate, description,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}
async function createPlan(includedHours: number, extra: Record<string, unknown> = {}) {
  const res = await owner.api.post(P()).send({
    contextType: 'client', entityId: client.id, name: 'Retainer', intervalUnit: 'month',
    startDate: '2026-03-01', amount: 500, includedHours, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.plan.id as string;
}
const periodOf = async (planId: string, id = '2026-03-01') => {
  const res = await owner.api.get(P());
  return res.body.plans.find((p: any) => p.id === planId).periods.find((p: any) => p.id === id);
};
const draft = (planId: string, id = '2026-03-01') => owner.api.post(`${P()}/${planId}/periods/${id}/create-draft`).send({});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Retainer Client', email: 'ret@example.test' });
  await drainEvents();
});

describe('which entry the allowance covers when dates tie', () => {
  it('covers the same entry after an unrelated description edit and a recompute', async () => {
    const first = await logTime(2, '2026-03-10', 200, 'First');
    const second = await logTime(1, '2026-03-10', 200, 'Second');
    const planId = await createPlan(2);
    const before = await periodOf(planId);
    expect(before.coveredTimeEntryIds).toEqual([first]);
    expect(before.overageTimeEntryIds).toEqual([second]);

    const edited = await owner.api.put(`${T()}/client/${client.id}/${first}`).send({ description: 'First, corrected' });
    expect(edited.status).toBe(200);
    // Moving the plan start to the same day makes the generator walk the period again.
    const recomputed = await owner.api.put(`${P()}/${planId}`).send({ startDate: '2026-03-01' });
    expect(recomputed.status).toBe(200);

    const after = await periodOf(planId);
    expect(after.coveredTimeEntryIds).toEqual([first]);
    expect(after.overageTimeEntryIds).toEqual([second]);
  });
});

