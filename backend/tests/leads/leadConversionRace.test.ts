/**
 * B10.3: two simultaneous conversions of the SAME lead.
 *
 * `convertLead` reads the lead (`leadsRepo.getById`, an unlocked SELECT), checks
 * `lead.convertedAt` in application code, and only writes the converted markers
 * afterwards via a plain `leadsRepo.update`. Nothing serializes the check against
 * the write, so two `POST .../convert` requests racing the same lead can both read
 * `convertedAt: null` before either commits, and both proceed to create a client
 * (and, for the matter path, a matter) for the same lead. The lead ends up
 * pointing at whichever write landed last, and the other client/matter is an
 * orphan nothing ever references again.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { createLead } from '../../src/modules/leads/leads.service';

const leadsRepo = require('../../src/modules/leads/leads.repository');

let firm: Firm;
let owner: Actor;
let gate: Gate | null = null;

afterEach(() => {
  gate?.restore();
  gate = null;
});

async function clientCountByEmail(lawFirmId: string, email: string): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as n from clients where law_firm_id = $1 and lower(email) = lower($2)`,
    [lawFirmId, email],
  );
  return rows[0].n;
}

describe('lead conversion race', () => {
  it('two simultaneous client-only conversions of the same lead: only one succeeds and only one client is created', async () => {
    firm = await createFirm({ name: 'Conversion Race Firm' });
    owner = await ownerOf(firm.id);

    const email = `race-${randomUUID().slice(0, 8)}@example.test`;
    const { lead } = await createLead({
      lawFirmId: firm.id,
      userId: owner.uid,
      body: { name: 'Race Prospect', email },
    });
    await drainEvents();

    const url = `/api/lawfirms/${firm.id}/leads/${lead.id}/convert`;
    const body = { createMatter: false, clientType: 'person' };

    // Gate the same repository read `convertLead` uses for its (unlocked) guard
    // check, so both requests are proved to be inside the check-then-act window
    // at the same instant rather than merely hoped to interleave.
    gate = gateMethod(leadsRepo, 'getById');

    async function convertOnce() {
      return owner.api.post(url).send(body);
    }

    const pA = convertOnce();
    const pB = convertOnce();

    await gate.arrived(2);
    gate.open();

    const [resA, resB] = await Promise.all([pA, pB]);
    await drainEvents();

    const statuses = [resA.status, resB.status].sort();
    const succeeded = [resA, resB].filter((r) => r.status === 200);

    // The property conversion is supposed to guarantee: a lead can be converted
    // exactly once. One request wins with 200, the other gets a real rejection,
    // never a silent no-op and never a second 200.
    expect(succeeded.length).toBe(1);
    expect(statuses).toContain(200);
    const failing = resA.status === 200 ? resB : resA;
    expect(failing.status).toBe(400);
    expect(failing.body.error).toMatch(/already converted/i);

    // The row-level consequence: exactly one client was created for this lead,
    // not two. A duplicate client here is an orphan record nothing else ever
    // references, and a duplicate matter (on the other conversion path) is worse.
    expect(await clientCountByEmail(firm.id, email)).toBe(1);

    // The lead itself settles on the winning conversion's client id, and
    // `convertedAt` is set exactly once, not overwritten by a loser that should
    // never have been allowed to write at all.
    const { rows } = await testPool.query(
      `select converted_client_id, converted_at from leads where id = $1`,
      [lead.id],
    );
    expect(rows[0].converted_client_id).toBe(succeeded[0].body.clientId);
    expect(rows[0].converted_at).not.toBeNull();
  });

  it('two simultaneous matter-creating conversions of the same lead: only one matter is created', async () => {
    firm = await createFirm({ name: 'Conversion Race Firm (matter path)' });
    owner = await ownerOf(firm.id);

    const email = `race-matter-${randomUUID().slice(0, 8)}@example.test`;
    const { lead } = await createLead({
      lawFirmId: firm.id,
      userId: owner.uid,
      body: { name: 'Race Matter Prospect', email },
    });
    await drainEvents();

    const url = `/api/lawfirms/${firm.id}/leads/${lead.id}/convert`;
    const body = { createMatter: true, clientType: 'person', name: 'Race Matter Dispute' };

    // Same guard-read gate as the client-only case above, proving genuine
    // overlap of both requests at the pre-lock check, on the path that goes
    // through `createMatterWithMembersTx`'s `beforeInsert` claim instead of the
    // standalone transaction.
    gate = gateMethod(leadsRepo, 'getById');

    async function convertOnce() {
      return owner.api.post(url).send(body);
    }

    const pA = convertOnce();
    const pB = convertOnce();

    await gate.arrived(2);
    gate.open();

    const [resA, resB] = await Promise.all([pA, pB]);
    await drainEvents();

    const succeeded = [resA, resB].filter((r) => r.status === 200);
    const failing = resA.status === 200 ? resB : resA;

    expect(succeeded.length).toBe(1);
    expect(failing.status).toBe(400);
    expect(failing.body.error).toMatch(/already converted/i);

    // No half-created matter left behind by the loser: the count of matters
    // this lead's conversion could plausibly have created is exactly one.
    const { rows: matterRows } = await testPool.query(
      `select count(*)::int as n from matters where law_firm_id = $1 and name = $2`,
      [firm.id, 'Race Matter Dispute'],
    );
    expect(matterRows[0].n).toBe(1);

    const { rows: leadRows } = await testPool.query(
      `select converted_matter_id, converted_client_id, converted_at from leads where id = $1`,
      [lead.id],
    );
    expect(leadRows[0].converted_matter_id).toBe(succeeded[0].body.matterId);
    expect(leadRows[0].converted_client_id).toBe(succeeded[0].body.clientId);
    expect(leadRows[0].converted_at).not.toBeNull();
  });
});
