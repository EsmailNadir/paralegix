/**
 * Charge codes: the firm's billing code list, and who may change it.
 *
 * Two things make this worth its own file.
 *
 *   THE READ IS BASELINE, THE WRITE IS NOT. `billing.viewRates` sits in
 *   DEFAULT_PERMISSIONS, so every member of the firm can read the list; writing
 *   needs `billing.manageRates`. A test that expected a
 *   denial on read would be asserting a denial screen this product deliberately
 *   does not have.
 *
 *   A CODE IS A KEY. It is unique per firm, it is what a time entry points at,
 *   and a duplicate or a stolen one silently re-prices work. So every uniqueness
 *   case is checked against the ROWS, and every cross-firm case seeds the other
 *   firm first, so a refusal is provably a refusal rather than an empty world.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  request,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
/** A member holding the baseline and nothing else: cannot read rates, cannot write. */
let baseline: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const P = (lawFirmId: string, suffix = '') =>
  `/api/lawfirms/${lawFirmId}/billing/charge-codes${suffix}`;

async function seedChargeCode(
  lawFirmId: string,
  options: {
    code?: string;
    name?: string;
    isActive?: boolean;
    order?: number;
    defaultRate?: number | null;
    memberRates?: Record<string, number>;
  } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into billing_codes (
       id, law_firm_id, kind, code, name, is_active, sort_order, default_rate, member_rates
     ) values ($1, $2, 'charge', $3, $4, $5, $6, $7, $8)`,
    [
      id,
      lawFirmId,
      options.code ?? `CC${id.slice(0, 4).toUpperCase()}`,
      options.name ?? `Charge Code ${id.slice(0, 8)}`,
      options.isActive ?? true,
      options.order ?? 1,
      options.defaultRate ?? 250.0,
      JSON.stringify(options.memberRates ?? {}),
    ],
  );
  return { id };
}

/**
 * A time entry pointing at a charge code.
 *
 * Three schema rules shape this insert, and getting any of them wrong makes the
 * seed fail rather than the assertion: `entry_date` is the day-only column (not
 * `date`), `amount_cents` is `generated always` and may not be written, and
 * `time_entries_check` demands exactly one of `matter_id` or `client_id`.
 */
async function seedTimeEntryWithChargeCode(lawFirmId: string, chargeCodeId: string) {
  const matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Hollis v. Denton', $3)`,
    [matterId, lawFirmId, `REF-${matterId.slice(0, 8)}`],
  );
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, 
       id, law_firm_id, matter_id, description, hours, rate_cents, activity_date, billing_code_id
     ) values ('time', $1, $2, $3, 'Research legal precedence', 2.0, 25000, '2026-08-10', $4)`,
    [id, lawFirmId, matterId, chargeCodeId],
  );
  return { id };
}

/** Every charge-code row a firm holds, newest ordering irrelevant. */
async function codeRows(lawFirmId: string) {
  const { rows } = await testPool.query(
    "select * from billing_codes where law_firm_id = $1 and kind = 'charge' order by sort_order, code",
    [lawFirmId],
  );
  return rows;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Charge Code Firm' });
  owner = await ownerOf(firm.id);
  baseline = await memberWith(firm.id, []);

  otherFirm = await createFirm({ name: 'Other Firm' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('who may read and who may write', () => {
  it('refuses an unauthenticated read and an unauthenticated write', async () => {
    // `request()` is the anonymous agent. Clearing the header on an authenticated
    // one does not work: `as()` re-sets it on every call.
    expect((await request().get(P(firm.id))).status).toBe(401);
    expect((await request().post(P(firm.id)).send({ code: 'ADM01', name: 'Admin' })).status)
      .toBe(401);
  });

  it('refuses a member of another firm, and writes nothing', async () => {
    const read = await otherOwner.api.get(P(firm.id));
    const write = await otherOwner.api.post(P(firm.id)).send({ code: 'ADM01', name: 'Admin' });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    // The refusal has to be a refusal, not a 403 that arrived after the insert.
    expect(await codeRows(firm.id)).toHaveLength(0);
  });

  it('refuses a member whose role grants nothing the rate list', async () => {
    // `billing.viewRates` is not in DEFAULT_PERMISSIONS, so reading rates needs
    // an explicit grant. Seeded first, so a 403 cannot be mistaken for an empty
    // list.
    await seedChargeCode(firm.id, { code: 'VIS01', name: 'Visible To All' });

    const res = await baseline.api.get(P(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('VIS01');
  });

  it('refuses a baseline member every WRITE, and leaves the list alone', async () => {
    const { id } = await seedChargeCode(firm.id, { code: 'KEEP1', name: 'Keep' });

    const create = await baseline.api.post(P(firm.id)).send({ code: 'NEW01', name: 'New' });
    const update = await baseline.api.put(P(firm.id, `/${id}`)).send({ name: 'Renamed' });
    const remove = await baseline.api.delete(P(firm.id, `/${id}`));
    const reorder = await baseline.api.put(P(firm.id, '/reorder')).send({ chargeCodeIds: [id] });

    expect([create.status, update.status, remove.status, reorder.status])
      .toEqual([403, 403, 403, 403]);
    // The list is the assertion. Each of those four routes fails differently if
    // its gate is dropped, and only the rows show all four at once.
    const rows = await codeRows(firm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, code: 'KEEP1', name: 'Keep' });
  });

  it('lets a member holding only billing.manageRates write', async () => {
    // Testing only the owner would pass against a gate that asked for nothing,
    // since an owner holds every permission.
    const manager = await memberWith(firm.id, ['billing.manageRates']);

    const res = await manager.api.post(P(firm.id)).send({ code: 'MGR01', name: 'By Manager' });

    expect(res.status).toBe(201);
    expect((await codeRows(firm.id)).map((r: any) => r.code)).toEqual(['MGR01']);
  });
});

describe('creating a charge code', () => {
  it('stores the code, the name and the rate, and activates it', async () => {
    const res = await owner.api.post(P(firm.id)).send({
      code: 'CRT01',
      name: 'Court Appearance',
      defaultRate: 350.0,
      memberRates: { 'user-1': 400.0 },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: 'Charge code created successfully',
      chargeCodeId: expect.any(String),
    });

    const { rows } = await testPool.query(
      'select * from billing_codes where id = $1', [res.body.chargeCodeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: 'CRT01', name: 'Court Appearance', is_active: true, sort_order: 1,
    });
    // Numeric, and the per-member override that a rate lookup reads before the
    // default. A create that dropped `member_rates` would bill everyone the
    // default and look completely normal.
    expect(Number(rows[0].default_rate)).toBe(350.0);
    expect(rows[0].member_rates).toEqual({ 'user-1': 400.0 });
  });

  it('numbers each new code after the last one', async () => {
    await owner.api.post(P(firm.id)).send({ code: 'AAA01', name: 'First' });
    await owner.api.post(P(firm.id)).send({ code: 'BBB01', name: 'Second' });

    // The order column drives the list the UI renders, so two codes sharing a
    // position make the list order arbitrary.
    expect((await codeRows(firm.id)).map((r: any) => r.sort_order)).toEqual([1, 2]);
  });

  it('refuses a code the firm already holds, and adds nothing', async () => {
    await seedChargeCode(firm.id, { code: 'DUP01', name: 'First' });

    const res = await owner.api.post(P(firm.id)).send({ code: 'DUP01', name: 'Second' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Charge code already exists');
    expect(await codeRows(firm.id)).toHaveLength(1);
  });

  it('lets a different firm hold the same code', async () => {
    await seedChargeCode(firm.id, { code: 'SHR01', name: 'Firm A Shared' });

    const res = await otherOwner.api.post(P(otherFirm.id))
      .send({ code: 'SHR01', name: 'Firm B Shared' });

    // The uniqueness rule is per firm. A global one would make one firm's code
    // list depend on every other firm's, which is a cross-tenant leak in the
    // form of a validation error.
    expect(res.status).toBe(201);
    expect((await codeRows(otherFirm.id)).map((r: any) => r.code)).toEqual(['SHR01']);
    expect((await codeRows(firm.id)).map((r: any) => r.code)).toEqual(['SHR01']);
  });

  it('CHARACTERISATION: rejects a lowercase code rather than upper-casing it', async () => {
    const res = await owner.api.post(P(firm.id)).send({ code: 'crt01', name: 'Court' });

    // `createChargeCode` calls `code.toUpperCase()`, but the Zod pattern is
    // `^[A-Z0-9]{3,10}$` and runs first, so that normalization is unreachable
    // through the API and a lowercase code is a 400. Pinned rather than asserted
    // away: whichever side is changed, this case says what the other one does.
    expect(res.status).toBe(400);
    expect(await codeRows(firm.id)).toHaveLength(0);
  });

  it('refuses a malformed code or an empty name', async () => {
    const tooShort = await owner.api.post(P(firm.id)).send({ code: 'AB', name: 'Too Short' });
    const tooLong = await owner.api.post(P(firm.id)).send({ code: 'ABCDEFGHIJK', name: 'Too Long' });
    const symbols = await owner.api.post(P(firm.id)).send({ code: 'AB-CD', name: 'Invalid Symbol' });
    const noName = await owner.api.post(P(firm.id)).send({ code: 'VALID1', name: '' });
    const negative = await owner.api.post(P(firm.id))
      .send({ code: 'VALID1', name: 'Valid', defaultRate: -50 });

    expect([tooShort.status, tooLong.status, symbols.status, noName.status, negative.status])
      .toEqual([400, 400, 400, 400, 400]);
    expect(await codeRows(firm.id)).toHaveLength(0);
  });

  it('refuses a negative member rate', async () => {
    const res = await owner.api.post(P(firm.id))
      .send({ code: 'NEG01', name: 'Negative Member Rate', memberRates: { 'user-1': -25 } });

    expect(res.status).toBe(400);
    expect(await codeRows(firm.id)).toHaveLength(0);
  });
});

describe('listing charge codes', () => {
  it('orders by position, then by code, and hides the inactive ones', async () => {
    await seedChargeCode(firm.id, { code: 'ZZZ01', order: 1, isActive: true });
    await seedChargeCode(firm.id, { code: 'AAA01', order: 1, isActive: true });
    await seedChargeCode(firm.id, { code: 'MID01', order: 2, isActive: true });
    await seedChargeCode(firm.id, { code: 'INA01', order: 1, isActive: false });

    const res = await owner.api.get(P(firm.id));

    // Two codes share position 1, so this also pins the tie-break. Without it the
    // order of the first two rows is whatever the planner returns.
    expect(res.status).toBe(200);
    expect(res.body.chargeCodes.map((c: any) => c.code)).toEqual(['AAA01', 'ZZZ01', 'MID01']);
  });

  it('includes the inactive ones when asked', async () => {
    await seedChargeCode(firm.id, { code: 'ACT01', isActive: true });
    await seedChargeCode(firm.id, { code: 'INA01', isActive: false });

    const res = await owner.api.get(P(firm.id, '?includeInactive=true'));

    expect(res.body.chargeCodes.map((c: any) => c.code).sort()).toEqual(['ACT01', 'INA01']);
  });

  it('never lists another firm codes', async () => {
    await seedChargeCode(firm.id, { code: 'MINE1', name: 'Mine' });
    await seedChargeCode(otherFirm.id, { code: 'THRS1', name: 'Theirs' });

    const mine = await owner.api.get(P(firm.id));
    const theirs = await otherOwner.api.get(P(otherFirm.id));

    // Both directions, so an empty result cannot pass as isolation.
    expect(mine.body.chargeCodes.map((c: any) => c.code)).toEqual(['MINE1']);
    expect(theirs.body.chargeCodes.map((c: any) => c.code)).toEqual(['THRS1']);
  });
});

describe('reading one charge code', () => {
  it('serves the rate as a number, not a string', async () => {
    const { id } = await seedChargeCode(firm.id, {
      code: 'SNG01', name: 'Single Read', defaultRate: 275.5,
    });

    const res = await owner.api.get(P(firm.id, `/${id}`));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, code: 'SNG01', defaultRate: 275.5 });
    // `numeric` comes back from node-pg as a STRING. A rate that reaches the
    // frontend as '275.50' concatenates instead of adding wherever it is summed.
    expect(typeof res.body.defaultRate).toBe('number');
  });

  it('does not serve another firm code by its id', async () => {
    const { id } = await seedChargeCode(otherFirm.id, { code: 'OTH01', name: 'Theirs' });

    const res = await owner.api.get(P(firm.id, `/${id}`));

    // A real, existing id: the 404 is the tenant scope refusing it, not a
    // missing row.
    expect(res.status).toBe(404);
  });

  it('answers 404 for an id that exists nowhere', async () => {
    expect((await owner.api.get(P(firm.id, `/${randomUUID()}`))).status).toBe(404);
  });
});

describe('updating a charge code', () => {
  it('writes the code, name, rate and active flag', async () => {
    const { id } = await seedChargeCode(firm.id, {
      code: 'OLD01', name: 'Old Name', isActive: true, defaultRate: 100,
    });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({
      code: 'NEW01', name: 'New Name', isActive: false, defaultRate: 200,
    });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select * from billing_codes where id = $1', [id]);
    expect(rows[0]).toMatchObject({ code: 'NEW01', name: 'New Name', is_active: false });
    expect(Number(rows[0].default_rate)).toBe(200);
  });

  it('leaves unmentioned fields alone', async () => {
    const { id } = await seedChargeCode(firm.id, {
      code: 'PAR01', name: 'Partial', defaultRate: 175, memberRates: { 'user-1': 300 },
    });

    await owner.api.put(P(firm.id, `/${id}`)).send({ name: 'Renamed Only' });

    // A whole-row write instead of a patch would blank the rate and the member
    // overrides, and the only visible symptom would be a later invoice priced
    // at zero.
    const { rows } = await testPool.query('select * from billing_codes where id = $1', [id]);
    expect(rows[0]).toMatchObject({ code: 'PAR01', name: 'Renamed Only', is_active: true });
    expect(Number(rows[0].default_rate)).toBe(175);
    expect(rows[0].member_rates).toEqual({ 'user-1': 300 });
  });

  it('clears a previously set rate when null is sent explicitly', async () => {
    // The counterpart to "leaves unmentioned fields alone" above: omitting
    // `defaultRate` must preserve it, and sending `null` must clear it. Both
    // have to work, or a rate can never be unset once configured.
    const { id } = await seedChargeCode(firm.id, { code: 'CLR01', name: 'Clearable', defaultRate: 150 });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({ defaultRate: null });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select default_rate from billing_codes where id = $1', [id]);
    expect(rows[0].default_rate).toBeNull();
  });

  it('refuses a code another charge code in the firm already holds', async () => {
    await seedChargeCode(firm.id, { code: 'EXI01' });
    const { id } = await seedChargeCode(firm.id, { code: 'TAR01', name: 'Target' });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({ code: 'EXI01' });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select code from billing_codes where id = $1', [id]);
    expect(rows[0].code).toBe('TAR01');
  });

  it('allows a code to keep its own code while something else changes', async () => {
    const { id } = await seedChargeCode(firm.id, { code: 'SELF1', name: 'Before' });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({ code: 'SELF1', name: 'After' });

    // The uniqueness check has to exclude the row being updated. Without that
    // exclusion, renaming a code while re-sending its own code is refused, which
    // is exactly what the edit form submits.
    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select name from billing_codes where id = $1', [id]);
    expect(rows[0].name).toBe('After');
  });

  it('does not update another firm charge code', async () => {
    const { id } = await seedChargeCode(otherFirm.id, { code: 'OTH01', name: 'Theirs' });

    const res = await owner.api.put(P(firm.id, `/${id}`)).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select name from billing_codes where id = $1', [id]);
    expect(rows[0].name).toBe('Theirs');
  });
});

describe('reordering', () => {
  it('renumbers positions to match the order given', async () => {
    const { id: id1 } = await seedChargeCode(firm.id, { code: 'RND01', order: 1 });
    const { id: id2 } = await seedChargeCode(firm.id, { code: 'RND02', order: 2 });
    const { id: id3 } = await seedChargeCode(firm.id, { code: 'RND03', order: 3 });

    const res = await owner.api.put(P(firm.id, '/reorder'))
      .send({ chargeCodeIds: [id3, id1, id2] });

    expect(res.status).toBe(200);
    const rows = await codeRows(firm.id);
    expect(rows.map((r: any) => r.id)).toEqual([id3, id1, id2]);
    expect(rows.map((r: any) => r.sort_order)).toEqual([1, 2, 3]);
  });

  it('does not renumber another firm codes', async () => {
    const { id: mine } = await seedChargeCode(firm.id, { code: 'MIN01', order: 1 });
    const { id: theirs } = await seedChargeCode(otherFirm.id, { code: 'THR01', order: 7 });

    await owner.api.put(P(firm.id, '/reorder')).send({ chargeCodeIds: [theirs, mine] });

    // Naming a foreign id in the array must not move it. A reorder that wrote by
    // id alone would silently renumber another firm's list.
    const { rows } = await testPool.query(
      'select sort_order from billing_codes where id = $1', [theirs],
    );
    expect(rows[0].sort_order).toBe(7);
  });

  it('rejects an empty array', async () => {
    expect((await owner.api.put(P(firm.id, '/reorder')).send({ chargeCodeIds: [] })).status)
      .toBe(400);
  });
});

describe('deleting a charge code', () => {
  it('removes one nothing points at', async () => {
    const { id } = await seedChargeCode(firm.id, { code: 'DEL01' });

    const res = await owner.api.delete(P(firm.id, `/${id}`));

    expect(res.status).toBe(200);
    expect(await codeRows(firm.id)).toHaveLength(0);
  });

  it('refuses to delete one a time entry points at', async () => {
    const { id } = await seedChargeCode(firm.id, { code: 'USE01' });
    await seedTimeEntryWithChargeCode(firm.id, id);

    const res = await owner.api.delete(P(firm.id, `/${id}`));

    // The alternative is a time entry whose charge code has vanished, which
    // re-prices billed work with no record of what it used to be.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('It is being used in time entries');
    expect(await codeRows(firm.id)).toHaveLength(1);
  });

  it('does not delete another firm charge code', async () => {
    const { id } = await seedChargeCode(otherFirm.id, { code: 'OTH01' });

    const res = await owner.api.delete(P(firm.id, `/${id}`));

    expect(res.status).toBe(404);
    expect(await codeRows(otherFirm.id)).toHaveLength(1);
  });

  it('answers 404 for an id that exists nowhere', async () => {
    expect((await owner.api.delete(P(firm.id, `/${randomUUID()}`))).status).toBe(404);
  });
});
