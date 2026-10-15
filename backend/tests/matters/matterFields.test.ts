/**
 * Custom matter field definitions.
 *
 * `matterFields.service.ts` was at 16%. A definition is only half the data: the
 * VALUES a matter carries live in `matters.custom_fields` (jsonb) keyed by the
 * definition's id, and nothing joins them. That asymmetry is what makes the
 * cases below worth having:
 *
 *   DELETE IS AN ARCHIVE. Hard-deleting a definition would orphan every value
 *   already stored under its id and lose the label and type needed to render
 *   them. The endpoint answers "deleted successfully" either way, so only the
 *   row itself can tell the difference. The delete case asserts the row SURVIVES
 *   with archived = true, and that it drops out of the default list.
 *
 *   OPTION NORMALIZATION. A select field is unusable without options, and the
 *   caller may send plain strings or { label, value } objects. Blanks are
 *   dropped and duplicates collapse by value. A select that ends up with zero
 *   options renders as an empty dropdown rather than an error, so the service
 *   refuses it up front.
 *
 *   SCOPE. A definition with a practice area applies only to matters in it, and
 *   that practice area must belong to the firm. Every read and write resolves
 *   rows by id, so each one gets its own cross-firm case here.
 *
 * Fixtures are plain SQL through the test pool, so a broken repository cannot
 * produce both the row and the expectation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A

const DEFS = () => `/api/lawfirms/${firmA.id}/matter-field-defs`;

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into practice_areas (id, law_firm_id, name) values ($1,$2,$3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

interface DefSeed {
  label: string;
  fieldType?: string;
  practiceAreaId?: string | null;
  sortOrder?: number;
  archived?: boolean;
  options?: unknown[];
}

async function seedDef(lawFirmId: string, seed: DefSeed): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_field_defs
       (id, law_firm_id, practice_area_id, label, field_type, options, sort_order, archived)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) returning id`,
    [
      id, lawFirmId, seed.practiceAreaId ?? null, seed.label,
      seed.fieldType ?? 'text', JSON.stringify(seed.options ?? []),
      seed.sortOrder ?? 0, seed.archived === true,
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function defRow(id: string) {
  const { rows } = await testPool.query(
    `select label, field_type, options, sort_order, archived, practice_area_id, law_firm_id
       from matter_field_defs where id = $1`,
    [id],
  );
  return rows[0];
}

async function defCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from matter_field_defs where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
});

describe('creating a field definition', () => {
  it('stores a firm-wide text field', async () => {
    const res = await alice.api.post(DEFS()).send({ label: 'Opposing Counsel' });

    expect(res.status).toBe(201);
    const row = await defRow(res.body.fieldDefId);
    expect(row.label).toBe('Opposing Counsel');
    expect(row.field_type).toBe('text');
    expect(row.practice_area_id).toBeNull();
    expect(row.archived).toBe(false);
  });

  it('normalizes options to { label, value }, dropping blanks and duplicates', async () => {
    const res = await alice.api.post(DEFS()).send({
      label: 'Venue',
      fieldType: 'select',
      options: ['  State  ', { label: 'Federal', value: 'fed' }, '', 'State'],
    });

    expect(res.status).toBe(201);
    expect(res.body.fieldDef.options).toEqual([
      { label: 'State', value: 'State' },
      { label: 'Federal', value: 'fed' },
    ]);
    expect((await defRow(res.body.fieldDefId)).options).toEqual([
      { label: 'State', value: 'State' },
      { label: 'Federal', value: 'fed' },
    ]);
  });

  it('refuses a select field whose options are all blank', async () => {
    const refused = await alice.api.post(DEFS())
      .send({ label: 'Venue', fieldType: 'select', options: ['', '   '] });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/at least one option/i);
    expect(await defCount(firmA.id)).toBe(0);

    // The same field with a usable option is accepted, so the refusal above was
    // the options check rather than a rejection of the request shape.
    const accepted = await alice.api.post(DEFS())
      .send({ label: 'Venue', fieldType: 'select', options: ['State'] });
    expect(accepted.status).toBe(201);
  });

  it('refuses a practice area belonging to another firm, then accepts its own', async () => {
    const foreign = await seedPracticeArea(firmB.id, 'Family Law');

    const refused = await alice.api.post(DEFS())
      .send({ label: 'Filing County', practiceAreaId: foreign });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/practiceAreaId/i);
    expect(await defCount(firmA.id)).toBe(0);

    const own = await seedPracticeArea(firmA.id, 'Family Law');
    const accepted = await alice.api.post(DEFS())
      .send({ label: 'Filing County', practiceAreaId: own });
    expect(accepted.status).toBe(201);
    expect((await defRow(accepted.body.fieldDefId)).practice_area_id).toBe(own);
  });

  it('refuses a field type the matters table cannot store', async () => {
    const res = await alice.api.post(DEFS()).send({ label: 'Venue', fieldType: 'rich_text' });

    expect(res.status).toBe(400);
    expect(await defCount(firmA.id)).toBe(0);
  });
});

describe('listing field definitions', () => {
  it('returns this firm\'s definitions in sortOrder, and none of the other firm\'s', async () => {
    // Inserted last-first, with names that collide across firms.
    await seedDef(firmA.id, { label: 'Venue', sortOrder: 2 });
    await seedDef(firmA.id, { label: 'Opposing Counsel', sortOrder: 0 });
    await seedDef(firmA.id, { label: 'Filing County', sortOrder: 1 });
    await seedDef(firmB.id, { label: 'Venue', sortOrder: 0 });

    const res = await alice.api.get(DEFS());

    expect(res.status).toBe(200);
    expect(res.body.fieldDefs.map((d: any) => d.label))
      .toEqual(['Opposing Counsel', 'Filing County', 'Venue']);
  });

  it('hides archived definitions unless includeArchived is asked for', async () => {
    await seedDef(firmA.id, { label: 'Live Field', sortOrder: 0 });
    await seedDef(firmA.id, { label: 'Retired Field', sortOrder: 1, archived: true });

    const plain = await alice.api.get(DEFS());
    expect(plain.status).toBe(200);
    expect(plain.body.fieldDefs.map((d: any) => d.label)).toEqual(['Live Field']);

    const withArchived = await alice.api.get(`${DEFS()}?includeArchived=true`);
    expect(withArchived.status).toBe(200);
    expect(withArchived.body.fieldDefs.map((d: any) => d.label))
      .toEqual(['Live Field', 'Retired Field']);
  });

  it('hides archived definitions from a service caller that does not say either way', async () => {
    // The route always passes a boolean (`includeArchived === 'true'`), so the
    // case above never reaches the service's own default. Any other caller that
    // omits the option relies on it, and a default of `true` would put retired
    // fields back on every matter form that reads through it.
    const { listFieldDefs } = require('../../src/modules/matters/fields/matterFields.service');
    await seedDef(firmA.id, { label: 'Live Field', sortOrder: 0 });
    await seedDef(firmA.id, { label: 'Retired Field', sortOrder: 1, archived: true });

    const { fieldDefs } = await listFieldDefs({ lawFirmId: firmA.id, userId: alice.uid });

    expect(fieldDefs.map((d: any) => d.label)).toEqual(['Live Field']);
  });

  it('withholds the definitions from a member of a different firm', async () => {
    await seedDef(firmA.id, { label: 'Opposing Counsel' });
    const outsider = await ownerOf(firmB.id);

    const refused = await outsider.api.get(DEFS());

    expect(JSON.stringify(refused.body)).not.toContain('Opposing Counsel');
    expect(refused.status).toBe(403);

    // The definition is really there for a caller who may read it.
    const allowed = await alice.api.get(DEFS());
    expect(allowed.body.fieldDefs.map((d: any) => d.label)).toEqual(['Opposing Counsel']);
  });
});

describe('updating a field definition', () => {
  it('relabels it', async () => {
    const def = await seedDef(firmA.id, { label: 'Oposing Counsel' });

    const res = await alice.api.put(`${DEFS()}/${def}`).send({ label: 'Opposing Counsel' });

    expect(res.status).toBe(200);
    expect((await defRow(def)).label).toBe('Opposing Counsel');
  });

  it('normalizes replacement options', async () => {
    const def = await seedDef(firmA.id, {
      label: 'Venue', fieldType: 'select', options: [{ label: 'State', value: 'State' }],
    });

    const res = await alice.api.put(`${DEFS()}/${def}`)
      .send({ options: ['Federal', { label: 'Tribal' }] });

    expect(res.status).toBe(200);
    expect((await defRow(def)).options).toEqual([
      { label: 'Federal', value: 'Federal' },
      { label: 'Tribal', value: 'Tribal' },
    ]);
  });

  it('refuses to strip the last option from a select field', async () => {
    const def = await seedDef(firmA.id, {
      label: 'Venue', fieldType: 'select', options: [{ label: 'State', value: 'State' }],
    });

    const res = await alice.api.put(`${DEFS()}/${def}`).send({ options: [] });

    expect(res.status).toBe(400);
    expect((await defRow(def)).options).toEqual([{ label: 'State', value: 'State' }]);
  });

  it('refuses to convert a text field to a select with no options', async () => {
    const def = await seedDef(firmA.id, { label: 'Venue' });

    const res = await alice.api.put(`${DEFS()}/${def}`).send({ fieldType: 'select' });

    expect(res.status).toBe(400);
    expect((await defRow(def)).field_type).toBe('text');
  });

  it('cannot relabel another firm\'s definition', async () => {
    const theirs = await seedDef(firmB.id, { label: 'Their Field' });

    const res = await alice.api.put(`${DEFS()}/${theirs}`).send({ label: 'Renamed By A' });

    expect(res.status).toBe(404);
    expect((await defRow(theirs)).label).toBe('Their Field');
  });

  it('cannot archive another firm\'s definition through the update path', async () => {
    const theirs = await seedDef(firmB.id, { label: 'Their Field' });

    const res = await alice.api.put(`${DEFS()}/${theirs}`).send({ archived: true });

    expect(res.status).toBe(404);
    expect((await defRow(theirs)).archived).toBe(false);
  });
});

describe('deleting a field definition', () => {
  it('archives the row instead of dropping it', async () => {
    const def = await seedDef(firmA.id, { label: 'Opposing Counsel' });

    const res = await alice.api.delete(`${DEFS()}/${def}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Custom field deleted successfully', fieldDefId: def });
    // The row must survive: matters still carry values keyed by this id, and the
    // label and type here are the only way to render them.
    const row = await defRow(def);
    expect(row.label).toBe('Opposing Counsel');
    expect(row.archived).toBe(true);

    const list = await alice.api.get(DEFS());
    expect(list.body.fieldDefs).toEqual([]);
  });

  it('cannot archive another firm\'s definition', async () => {
    const theirs = await seedDef(firmB.id, { label: 'Their Field' });

    const res = await alice.api.delete(`${DEFS()}/${theirs}`);

    expect(res.status).toBe(404);
    expect((await defRow(theirs)).archived).toBe(false);
  });

  it('answers 404 for an id that names nothing', async () => {
    const res = await alice.api.delete(`${DEFS()}/${randomUUID()}`);

    expect(res.status).toBe(404);
  });
});

describe('permissions', () => {
  it('lets a matters member read definitions but not create one', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    await seedDef(firmA.id, { label: 'Opposing Counsel' });

    const read = await viewer.api.get(DEFS());
    expect(read.status).toBe(200);
    expect(read.body.fieldDefs.map((d: any) => d.label)).toEqual(['Opposing Counsel']);

    const body = { label: 'Filing County' };
    const refused = await viewer.api.post(DEFS()).send(body);
    expect(refused.status).toBe(403);
    expect(await defCount(firmA.id)).toBe(1);

    // The identical body from the owner succeeds, so the 403 was about the
    // caller and not about the payload.
    const accepted = await alice.api.post(DEFS()).send(body);
    expect(accepted.status).toBe(201);
  });

  it('refuses a delete from a member without settings.manageFirm', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const def = await seedDef(firmA.id, { label: 'Opposing Counsel' });

    const refused = await viewer.api.delete(`${DEFS()}/${def}`);

    expect(refused.status).toBe(403);
    expect((await defRow(def)).archived).toBe(false);

    // Real data, and a permitted caller can act on it.
    const accepted = await alice.api.delete(`${DEFS()}/${def}`);
    expect(accepted.status).toBe(200);
    expect((await defRow(def)).archived).toBe(true);
  });
});
