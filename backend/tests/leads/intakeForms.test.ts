/**
 * Intake form templates, driven through the real routes.
 *
 * `intakeForms.service.ts` sat at 12% with nothing behind it. Two things it
 * does are worth pinning, and neither is visible on a screen.
 *
 * THE ACCESS CODE. A form can be gated by a code, and only its SHA-256 hash is
 * stored. The service is the only place that decides whether a submitted code
 * becomes a hash, stays a plaintext column, or is echoed back. A route that
 * returned `accessCodeHash` (or worse, the code) on the read path would hand
 * every firm member the gate to a public URL, and the screen would look
 * identical because it renders `hasAccessCode`, not the value.
 *
 * THE PUBLIC TOKEN. `public_token` is the whole authentication of the public
 * form page: anyone holding it can open the form. Regenerating it is how a firm
 * revokes a leaked link, so a regenerate that returned the same token would be
 * a revocation that silently did nothing.
 *
 * On top of that the usual `(law_firm_id, id)` scope: every cross-firm case
 * below re-reads the neighbour's ROW, because a 404 alone does not prove the
 * write was refused rather than applied and then reported missing.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  request,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const path = (suffix = '') => `/api/lawfirms/${firm.id}/intake-forms${suffix}`;

/** A template seeded straight into the table, never through the create route. */
async function seedTemplate(
  lawFirmId: string,
  overrides: { name?: string; isActive?: boolean; accessCodeHash?: string | null } = {},
): Promise<{ id: string; name: string; publicToken: string }> {
  const id = randomUUID();
  const name = overrides.name ?? `Form ${id.slice(0, 8)}`;
  const publicToken = `token-${randomUUID()}`;
  const res = await testPool.query(
    `insert into intake_form_templates
       (id, law_firm_id, name, public_token, fields, access_code_hash, is_active)
     values ($1, $2, $3, $4, '[]'::jsonb, $5, $6)`,
    [id, lawFirmId, name, publicToken, overrides.accessCodeHash ?? null, overrides.isActive ?? true],
  );
  expect(res.rowCount).toBe(1);
  return { id, name, publicToken };
}

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    'insert into practice_areas (id, law_firm_id, name) values ($1, $2, $3)',
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

const names = (body: any): string[] => (body.templates || []).map((t: any) => t.name);

async function rowById(id: string) {
  const { rows } = await testPool.query(
    'select name, public_token, access_code_hash, is_active, fields from intake_form_templates where id = $1',
    [id],
  );
  return rows[0] || null;
}

async function templateCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from intake_form_templates where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('the lazily seeded default form', () => {
  it('seeds one on the first read of a firm that has none', async () => {
    expect(await templateCount(firm.id)).toBe(0);

    const res = await owner.api.get(path());

    expect(res.status).toBe(200);
    expect(names(res.body)).toContain('General Intake');
    expect(await templateCount(firm.id)).toBe(1);
  });

  it('does not seed a second copy on the next read', async () => {
    await owner.api.get(path());
    await owner.api.get(path());

    // The seed is conditional on the list being empty. A seed that ran
    // unconditionally would grow the firm's form list by one per page load,
    // which reads as a UI bug rather than a service one.
    expect(await templateCount(firm.id)).toBe(1);
  });

  it('does not seed one for a firm that already has a form', async () => {
    await seedTemplate(firm.id, { name: 'Personal Injury Intake' });

    const res = await owner.api.get(path());

    expect(names(res.body)).toEqual(['Personal Injury Intake']);
    expect(await templateCount(firm.id)).toBe(1);
  });
});

describe('creating a form', () => {
  it('mints a public token the caller did not supply', async () => {
    const res = await owner.api.post(path()).send({ name: 'Estate Planning Intake' });

    expect(res.status).toBe(201);
    expect(typeof res.body.template.publicToken).toBe('string');
    expect(res.body.template.publicToken.length).toBeGreaterThan(20);
  });

  it('derives a field key from the label when none is given', async () => {
    const res = await owner.api.post(path()).send({
      name: 'Keyed form',
      fields: [{ label: 'Full name', type: 'text' }, { label: 'Email address', type: 'email' }],
    });

    // The key is what a submitted value is stored under, so a form whose keys
    // shift between saves loses the answers already collected against it.
    expect(res.body.template.fields.map((f: any) => f.key)).toEqual(['full_name', 'email_address']);
  });

  it('treats an empty or blank key as absent and derives one from the label', async () => {
    // The settings editor sends `key: ""` for a field added in the browser. A
    // schema that refused the empty string made any form with a new field
    // unsaveable, and a blank key that survived would store answers under "".
    const res = await owner.api.post(path()).send({
      name: 'Editor form',
      fields: [
        { key: '', label: 'Date of birth', type: 'text' },
        { key: '   ', label: 'Home phone', type: 'phone' },
        { key: 'kept_key', label: 'Anything', type: 'text' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.template.fields.map((f: any) => f.key)).toEqual([
      'date_of_birth',
      'home_phone',
      'kept_key',
    ]);
  });

  it('accepts an empty key on UPDATE too, deriving it from the label', async () => {
    const template = await seedTemplate(firm.id);

    const res = await owner.api
      .put(path(`/${template.id}`))
      .send({ fields: [{ key: '', label: 'Case summary', type: 'textarea' }] });

    expect(res.status).toBe(200);
    expect((await rowById(template.id)).fields.map((f: any) => f.key)).toEqual(['case_summary']);
  });

  it('disambiguates two fields that would slugify to the same key', async () => {
    const res = await owner.api.post(path()).send({
      name: 'Duplicate labels',
      fields: [{ label: 'Phone', type: 'phone' }, { label: 'Phone', type: 'phone' }],
    });

    const keys = res.body.template.fields.map((f: any) => f.key);
    // Two identical keys would make the second answer overwrite the first in
    // the submission's `field_values` object.
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe('phone');
  });

  it('rejects a name that is only whitespace', async () => {
    const res = await owner.api.post(path()).send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects a practice area belonging to another firm', async () => {
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    const theirArea = await seedPracticeArea(otherFirm.id, 'Their Family Law');

    const res = await owner.api.post(path()).send({ name: 'Cross firm', practiceAreaId: theirArea });

    expect(res.status).toBe(400);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('accepts a practice area belonging to this firm', async () => {
    const myArea = await seedPracticeArea(firm.id, 'My Family Law');

    const res = await owner.api.post(path()).send({ name: 'Same firm', practiceAreaId: myArea });

    // Paired with the refusal above, so that one cannot pass against a route
    // that rejects every practice area.
    expect(res.status).toBe(201);
    expect(res.body.template.practiceAreaId).toBe(myArea);
  });
});

describe('the access code', () => {
  it('stores a hash and never returns the code or the hash', async () => {
    const res = await owner.api.post(path()).send({ name: 'Gated form', accessCode: 'swordfish' });

    expect(res.status).toBe(201);
    expect(res.body.template.hasAccessCode).toBe(true);
    // The public form page is reachable by anyone holding the token; the code
    // is the only thing standing in front of it.
    expect(JSON.stringify(res.body)).not.toContain('swordfish');
    expect(res.body.template.accessCodeHash).toBeUndefined();

    const row = await rowById(res.body.template.id);
    expect(row.access_code_hash).not.toBe('swordfish');
    expect(row.access_code_hash).toHaveLength(64);
  });

  it('refuses a code shorter than eight characters', async () => {
    const res = await owner.api.post(path()).send({ name: 'Weak gate', accessCode: '1234567' });

    // The code is FIRM-TYPED, not generated, so its entropy is whatever someone
    // chose in a hurry. The old floor of four made `1234` a legal barrier on a
    // public URL, and no rate limit a real prospect will tolerate defends four
    // digits. The floor is the only place this can be fixed.
    expect(res.status).toBe(400);
    // The message is what the settings screen renders, so it has to name the
    // rule rather than say "invalid".
    expect(res.body.error).toMatch(/at least 8 characters/i);
    // Asserting the status alone would pass against a route that had merely
    // stopped creating templates, so re-read the table.
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('accepts a code of exactly eight characters', async () => {
    const res = await owner.api.post(path()).send({ name: 'Sound gate', accessCode: 'sw0rdfsh' });

    // Paired with the refusal above, so that one cannot pass against a route
    // that rejects every access code.
    expect(res.status).toBe(201);
    expect(res.body.template.hasAccessCode).toBe(true);
  });

  it('refuses a short code on UPDATE too, without disturbing the stored one', async () => {
    const created = await owner.api.post(path()).send({ name: 'Gated form', accessCode: 'swordfish' });
    const templateId = created.body.template.id;
    const before = (await rowById(templateId)).access_code_hash;

    const res = await owner.api.put(path(`/${templateId}`)).send({ accessCode: 'short' });

    // Both call sites carry the floor. Raising it on create alone would let a
    // firm set a sound code and then weaken it to `1234` from the same screen.
    expect(res.status).toBe(400);
    expect((await rowById(templateId)).access_code_hash).toBe(before);
  });

  it('still lets an update CLEAR the code, which is not a short string', async () => {
    const created = await owner.api.post(path()).send({ name: 'Gated form', accessCode: 'swordfish' });

    const res = await owner.api.put(path(`/${created.body.template.id}`)).send({ accessCode: null });

    // A minimum written as a plain `.min(8)` on a non-nullable string would take
    // the firm's only way to make a form fully public with it.
    expect(res.status).toBe(200);
    expect(res.body.template.hasAccessCode).toBe(false);
  });

  it('reports no access code when none was set', async () => {
    const res = await owner.api.post(path()).send({ name: 'Open form' });

    expect(res.body.template.hasAccessCode).toBe(false);
  });

  it('clears the code when the update sends null', async () => {
    const created = await owner.api.post(path()).send({ name: 'Gated form', accessCode: 'swordfish' });
    const templateId = created.body.template.id;

    const res = await owner.api.put(path(`/${templateId}`)).send({ accessCode: null });

    expect(res.status).toBe(200);
    expect(res.body.template.hasAccessCode).toBe(false);
    expect((await rowById(templateId)).access_code_hash).toBeNull();
  });

  it('leaves the code alone when the update omits the field', async () => {
    const created = await owner.api.post(path()).send({ name: 'Gated form', accessCode: 'swordfish' });
    const templateId = created.body.template.id;
    const before = (await rowById(templateId)).access_code_hash;

    const res = await owner.api.put(path(`/${templateId}`)).send({ name: 'Renamed but still gated' });

    // Paired with the clear above: omitting the key and sending null must not
    // mean the same thing, or renaming a form silently unlocks it.
    expect(res.body.template.hasAccessCode).toBe(true);
    expect((await rowById(templateId)).access_code_hash).toBe(before);
  });
});

describe('regenerating the public token', () => {
  it('replaces the token so the old link stops resolving', async () => {
    const template = await seedTemplate(firm.id, { name: 'Leaked form' });

    const res = await owner.api.post(path(`/${template.id}/regenerate-token`));

    expect(res.status).toBe(200);
    expect(res.body.template.publicToken).not.toBe(template.publicToken);
    expect((await rowById(template.id)).public_token).not.toBe(template.publicToken);
  });

  // B02.2 A14: the case above only proved the DB column changed. Regeneration
  // is a REVOCATION -- the whole point of the feature is that a leaked link
  // stops working -- so it has to be proven through the actual public route
  // an anonymous holder of the old link would hit, not just the stored value.
  it('the OLD token is refused on the real public route once regenerated', async () => {
    const template = await seedTemplate(firm.id, { name: 'Leaked form' });

    const before = await request().get(`/api/intake/${template.publicToken}`);
    expect(before.status).toBe(200);

    const regen = await owner.api.post(path(`/${template.id}/regenerate-token`));
    expect(regen.status).toBe(200);

    const after = await request().get(`/api/intake/${template.publicToken}`);
    expect(after.status).toBe(404);

    // The genuine control: the NEW token from the same response resolves fine,
    // so this is a revocation of the old link, not the route breaking outright.
    const withNewToken = await request().get(`/api/intake/${regen.body.template.publicToken}`);
    expect(withNewToken.status).toBe(200);
  });

  it('answers 404 for a form that does not exist', async () => {
    const res = await owner.api.post(path('/00000000-0000-0000-0000-000000000000/regenerate-token'));

    expect(res.status).toBe(404);
  });
});

describe('reading, updating and deleting', () => {
  it('reads one back by id', async () => {
    const template = await seedTemplate(firm.id, { name: 'Readable form' });

    const res = await owner.api.get(path(`/${template.id}`));

    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('Readable form');
  });

  it('answers 404 for one that does not exist', async () => {
    const res = await owner.api.get(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });

  it('deactivates a form without deleting it', async () => {
    const template = await seedTemplate(firm.id);

    const res = await owner.api.put(path(`/${template.id}`)).send({ isActive: false });

    expect(res.status).toBe(200);
    expect((await rowById(template.id)).is_active).toBe(false);
  });

  it('replaces the field list rather than appending to it', async () => {
    const created = await owner.api.post(path()).send({
      name: 'Two fields',
      fields: [{ label: 'Full name', type: 'text' }, { label: 'Email', type: 'email' }],
    });

    const res = await owner.api
      .put(path(`/${created.body.template.id}`))
      .send({ fields: [{ label: 'Phone', type: 'phone' }] });

    expect(res.body.template.fields.map((f: any) => f.label)).toEqual(['Phone']);
  });

  it('deletes one', async () => {
    const template = await seedTemplate(firm.id);

    const res = await owner.api.delete(path(`/${template.id}`));

    expect(res.status).toBe(200);
    expect(await rowById(template.id)).toBeNull();
  });

  it('answers 404 deleting one that does not exist', async () => {
    const res = await owner.api.delete(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });
});

describe('tenancy', () => {
  let otherFirm: Firm;
  let otherOwner: Actor;
  let theirTemplate: { id: string; name: string; publicToken: string };

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    otherOwner = await ownerOf(otherFirm.id);
    theirTemplate = await seedTemplate(otherFirm.id, { name: 'Neighbour Intake' });
  });

  it('does not list another firm forms', async () => {
    const mine = await owner.api.get(path());
    const theirs = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/intake-forms`);

    // The neighbour's own read proves the form exists and is reachable.
    expect(names(theirs.body)).toContain('Neighbour Intake');
    expect(names(mine.body)).not.toContain('Neighbour Intake');
  });

  it('refuses to read another firm form by id', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/intake-forms/${theirTemplate.id}`);

    expect(res.status).toBe(404);
  });

  it('refuses to rename another firm form and leaves it untouched', async () => {
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/intake-forms/${theirTemplate.id}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await rowById(theirTemplate.id)).name).toBe('Neighbour Intake');
  });

  it('refuses to delete another firm form and leaves the row in place', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/intake-forms/${theirTemplate.id}`);

    expect(res.status).toBe(404);
    expect(await rowById(theirTemplate.id)).not.toBeNull();
  });

  it('refuses to regenerate another firm token, so their public link keeps working', async () => {
    const res = await owner.api
      .post(`/api/lawfirms/${firm.id}/intake-forms/${theirTemplate.id}/regenerate-token`);

    expect(res.status).toBe(404);
    expect((await rowById(theirTemplate.id)).public_token).toBe(theirTemplate.publicToken);
  });
});

describe('permissions', () => {
  it('lets a baseline member read the forms', async () => {
    await seedTemplate(firm.id, { name: 'Readable form' });
    // `leads.view` is in DEFAULT_PERMISSIONS, so an empty role reads. Asserted
    // first so the write refusals below cannot pass on a member who is simply
    // locked out of the module.
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.get(path());

    expect(res.status).toBe(200);
    expect(names(res.body)).toContain('Readable form');
  });

  it('refuses a member without leads.manage a create', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path()).send({ name: 'Nope' });

    expect(res.status).toBe(403);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('refuses that member a rename, and the name survives', async () => {
    const template = await seedTemplate(firm.id, { name: 'Protected form' });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.put(path(`/${template.id}`)).send({ name: 'Edited by a reader' });

    expect(res.status).toBe(403);
    expect((await rowById(template.id)).name).toBe('Protected form');
  });

  it('refuses that member a token regeneration, so they cannot revoke a live link', async () => {
    const template = await seedTemplate(firm.id);
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path(`/${template.id}/regenerate-token`));

    expect(res.status).toBe(403);
    expect((await rowById(template.id)).public_token).toBe(template.publicToken);
  });

  it('refuses that member a delete, and the row survives', async () => {
    const template = await seedTemplate(firm.id);
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.delete(path(`/${template.id}`));

    expect(res.status).toBe(403);
    expect(await rowById(template.id)).not.toBeNull();
  });

  it('lets a member holding leads.manage create one', async () => {
    const manager = await memberWith(firm.id, ['leads.manage']);

    const res = await manager.api.post(path()).send({ name: 'Allowed' });

    // Paired with the refusals above so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(201);
  });
});
