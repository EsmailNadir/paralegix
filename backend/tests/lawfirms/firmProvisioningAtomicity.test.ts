import { randomUUID } from 'crypto';
import { as, testPool, tokenFor, drainEvents } from '../support/setupInProcess';
import { gateMethod } from '../support/gate';

const practiceAreasRepo = require('../../src/modules/practiceAreas/practiceAreas.repository');
const chargeCodesRepo = require('../../src/modules/billing/chargeCodes/chargeCodes.repository');
const stagesRepo = require('../../src/modules/leads/stages/leadStages.repository');
const intakeRepo = require('../../src/modules/leads/intakeForms.repository');
const eventBus = require('../../src/shared/events/eventBus');
const { MEMBER_ADDED } = require('../../src/shared/events/eventTypes');

async function founder() {
  const uid = `founder-${randomUUID()}`;
  await testPool.query(
    "insert into users (id, email, name, user_type) values ($1, $2, 'Founder', 'firm_member')",
    [uid, `${uid}@example.test`],
  );
  return { uid, api: as(tokenFor({ uid })) };
}

describe('firm provisioning atomicity', () => {
  it('allows only one overlapping firm creation for a founder at the membership limit', async () => {
    const owner = await founder();
    const usersRepo = require('../../src/modules/users/users.repository');
    const gate = gateMethod(usersRepo, 'findById');
    const fire = async (name: string) => owner.api.post('/api/lawfirms/create-lawfirm').send({ name });
    const first = fire('First');
    const second = fire('Second');
    try {
      await gate.arrived(2);
      expect(gate.waiting()).toBe(2);
      gate.open();
      const results = await Promise.all([first, second]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
      const { rows } = await testPool.query('select law_firm_id from members where user_id = $1', [owner.uid]);
      expect(rows).toHaveLength(1);
    } finally {
      gate.restore();
      await Promise.all([first, second]);
    }
  });

  it.each([
    ['practice area', practiceAreasRepo, 'create'],
    ['charge code', chargeCodesRepo, 'create'],
    ['pipeline stage', stagesRepo, 'create'],
    ['intake template', intakeRepo, 'createTemplate'],
  ])('rolls back the firm and every default after a %s write fails', async (_label, repo, method) => {
    const owner = await founder();
    const name = `Atomic ${randomUUID()}`;
    const original = repo[method];
    let writtenId: string | undefined;
    let firmId: string | undefined;
    const memberAdded = jest.fn();
    eventBus.on(MEMBER_ADDED, memberAdded);
    const fault = jest.spyOn(repo, method).mockImplementation(async (...args: any[]) => {
      const row = await original.apply(repo, args);
      writtenId = row.id;
      firmId = args[0];
      throw new Error('Injected failure after a default was written');
    });
    try {
      const response = await owner.api.post('/api/lawfirms/create-lawfirm').send({ name });
      expect(response.status).toBe(500);
      expect(writtenId).toBeDefined();
      expect(firmId).toBeDefined();
      await drainEvents();
      for (const table of ['law_firms', 'members', 'roles', 'practice_areas', 'billing_codes', 'lead_stages', 'intake_form_templates']) {
        const column = table === 'law_firms' ? 'id' : 'law_firm_id';
        const { rows } = await testPool.query(`select 1 from ${table} where ${column} = $1`, [firmId]);
        expect({ table, rows }).toEqual({ table, rows: [] });
      }
      expect(memberAdded).not.toHaveBeenCalled();
    } finally {
      fault.mockRestore();
      eventBus.off(MEMBER_ADDED, memberAdded);
    }
  });
});
