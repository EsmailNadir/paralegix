/**
 * Document request presets, driven through the real routes.
 *
 * `documentRequestTemplates.service.ts` sat at 14% with nothing behind it. It
 * is small, but it is firm-level configuration that every document request in
 * the firm is built from, and it has the two properties that make an untested
 * module dangerous: it is keyed by `(law_firm_id, id)`, and its delete is not a
 * delete.
 *
 * What is pinned here:
 *
 *   - The scope. Every read and write goes through `tenantQuery` / `scopedWrite`
 *     with the firm id, so a dropped predicate would let one firm rename or
 *     archive another firm's presets while answering 200. Each cross-firm case
 *     re-reads the neighbour's ROW afterwards.
 *   - `DELETE` archives rather than removes. A route that hard-deleted would
 *     still answer 200 and still disappear from the list, so status and list
 *     absence alone cannot tell the two apart.
 *   - `cleanItems`, which silently drops blank labels. That is the difference
 *     between a preset with three checklist items and one with five.
 *
 * Fixtures for the neighbouring firm are plain SQL, never this module's own
 * create route: a broken scope must not be able to produce both the data and
 * the expectation.
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

let firm: Firm;
let owner: Actor;

const path = (suffix = '') => `/api/lawfirms/${firm.id}/document-request-templates${suffix}`;

/** A preset seeded straight into the table. */
async function seedTemplate(
  lawFirmId: string,
  overrides: { name?: string; archived?: boolean; items?: unknown[] } = {},
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = overrides.name ?? `Preset ${id.slice(0, 8)}`;
  const res = await testPool.query(
    `insert into document_request_templates
       (id, law_firm_id, name, default_title, default_note, items, archived)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      id,
      lawFirmId,
      name,
      `${name} title`,
      null,
      JSON.stringify(overrides.items ?? [{ label: 'Passport', description: null }]),
      overrides.archived ?? false,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, name };
}

const names = (body: any): string[] => (body.templates || []).map((t: any) => t.name);

async function rowById(id: string) {
  const { rows } = await testPool.query(
    'select name, default_title, archived, items from document_request_templates where id = $1',
    [id],
  );
  return rows[0] || null;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('creating a preset', () => {
  it('returns the created preset and lists it', async () => {
    const created = await owner.api.post(path()).send({
      name: 'New client onboarding',
      defaultTitle: 'Please send your onboarding documents',
      defaultNote: 'We need these before your first appointment.',
      items: [{ label: 'Photo ID' }, { label: 'Proof of address', description: 'Dated within 3 months' }],
    });

    expect(created.status).toBe(201);
    expect(created.body.template.name).toBe('New client onboarding');
    expect(created.body.templateId).toBe(created.body.template.id);

    const list = await owner.api.get(path());
    expect(names(list.body)).toContain('New client onboarding');
  });

  it('stores each checklist item with its description', async () => {
    const created = await owner.api.post(path()).send({
      name: 'Two item preset',
      defaultTitle: 'Send these',
      items: [{ label: 'Photo ID' }, { label: 'Proof of address', description: 'Dated within 3 months' }],
    });

    expect(created.body.template.items).toEqual([
      { label: 'Photo ID', description: null },
      { label: 'Proof of address', description: 'Dated within 3 months' },
    ]);
  });

  it('drops an item whose label is only whitespace', async () => {
    const created = await owner.api.post(path()).send({
      name: 'Preset with a stray row',
      defaultTitle: 'Send these',
      items: [{ label: 'Photo ID' }, { label: '   ' }, { label: 'Bank statement' }],
    });

    expect(created.status).toBe(201);
    // The blank row is what the compose form leaves behind when someone adds a
    // line and does not fill it in. Kept, it renders as an unfulfillable
    // checklist item on the client's portal.
    expect(created.body.template.items.map((i: any) => i.label)).toEqual(['Photo ID', 'Bank statement']);
  });

  it('rejects a preset with no name', async () => {
    const res = await owner.api.post(path()).send({ name: '', defaultTitle: 'Send these' });

    expect(res.status).toBe(400);
  });

  it('rejects a preset with no default title', async () => {
    const res = await owner.api.post(path()).send({ name: 'Nameless title' });

    expect(res.status).toBe(400);
  });
});

describe('listing presets', () => {
  it('hides archived presets by default', async () => {
    await seedTemplate(firm.id, { name: 'Still in use' });
    await seedTemplate(firm.id, { name: 'Retired preset', archived: true });

    const res = await owner.api.get(path());

    expect(res.status).toBe(200);
    expect(names(res.body)).toContain('Still in use');
    expect(names(res.body)).not.toContain('Retired preset');
  });

  it('includes them when asked', async () => {
    await seedTemplate(firm.id, { name: 'Retired preset', archived: true });

    const res = await owner.api.get(path('?includeArchived=true'));

    // Paired with the case above: same row, and the only difference is the
    // query parameter.
    expect(names(res.body)).toContain('Retired preset');
  });

});

describe('updating a preset', () => {
  it('renames one', async () => {
    const template = await seedTemplate(firm.id, { name: 'Old name' });

    const res = await owner.api.put(path(`/${template.id}`)).send({ name: 'New name' });

    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('New name');
    expect((await rowById(template.id)).name).toBe('New name');
  });

  it('replaces the whole item list rather than appending to it', async () => {
    const template = await seedTemplate(firm.id, {
      items: [{ label: 'Passport' }, { label: 'Proof of address' }],
    });

    const res = await owner.api.put(path(`/${template.id}`)).send({ items: [{ label: 'Driving licence' }] });

    expect(res.status).toBe(200);
    expect(res.body.template.items.map((i: any) => i.label)).toEqual(['Driving licence']);
  });

  it('rejects a blank name rather than storing it', async () => {
    const template = await seedTemplate(firm.id, { name: 'Has a name' });

    const res = await owner.api.put(path(`/${template.id}`)).send({ name: '   ' });

    expect(res.status).toBe(400);
    expect((await rowById(template.id)).name).toBe('Has a name');
  });

  it('answers 404 for a preset that does not exist', async () => {
    const res = await owner.api
      .put(path('/00000000-0000-0000-0000-000000000000'))
      .send({ name: 'Nothing to rename' });

    expect(res.status).toBe(404);
  });
});

describe('deleting a preset', () => {
  it('archives the row instead of removing it', async () => {
    const template = await seedTemplate(firm.id, { name: 'Retire me' });

    const res = await owner.api.delete(path(`/${template.id}`));

    expect(res.status).toBe(200);
    // The row must survive: document requests already created from it keep
    // their audit trail only while the preset it came from still exists.
    const row = await rowById(template.id);
    expect(row).not.toBeNull();
    expect(row.archived).toBe(true);
  });

  it('answers 404 for a preset that does not exist', async () => {
    const res = await owner.api.delete(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });
});

describe('tenancy', () => {
  let otherFirm: Firm;
  let otherOwner: Actor;
  let theirTemplate: { id: string; name: string };

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    otherOwner = await ownerOf(otherFirm.id);
    theirTemplate = await seedTemplate(otherFirm.id, { name: 'Neighbour Preset' });
  });

  it('does not list another firm presets', async () => {
    const mine = await owner.api.get(path());
    const theirs = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/document-request-templates`);

    // The neighbour's own read proves the preset exists and is reachable, so
    // the absence below is a refusal rather than a missing fixture.
    expect(names(theirs.body)).toContain('Neighbour Preset');
    expect(names(mine.body)).not.toContain('Neighbour Preset');
  });

  it('does not list them even with includeArchived', async () => {
    const res = await owner.api.get(path('?includeArchived=true'));

    expect(res.status).toBe(200);
    expect(names(res.body)).not.toContain('Neighbour Preset');
  });

  it('refuses to rename another firm preset and leaves it untouched', async () => {
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/document-request-templates/${theirTemplate.id}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await rowById(theirTemplate.id)).name).toBe('Neighbour Preset');
  });

  it('refuses to archive another firm preset and leaves it active', async () => {
    const res = await owner.api
      .delete(`/api/lawfirms/${firm.id}/document-request-templates/${theirTemplate.id}`);

    expect(res.status).toBe(404);
    expect((await rowById(theirTemplate.id)).archived).toBe(false);
  });
});

describe('permissions', () => {
  it('lets a baseline member read the presets', async () => {
    await seedTemplate(firm.id, { name: 'Readable preset' });
    // `settings.viewFirm` is in DEFAULT_PERMISSIONS, so an empty role reads.
    // Asserted first so the write refusals below cannot pass on a member who
    // is simply locked out of the module.
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.get(path());

    expect(res.status).toBe(200);
    expect(names(res.body)).toContain('Readable preset');
  });

  it('refuses a member without settings.manageFirm a create', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path()).send({ name: 'Nope', defaultTitle: 'Nope' });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select id from document_request_templates where law_firm_id = $1', [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses that member a rename, and the name survives', async () => {
    const template = await seedTemplate(firm.id, { name: 'Protected preset' });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.put(path(`/${template.id}`)).send({ name: 'Edited by a reader' });

    expect(res.status).toBe(403);
    expect((await rowById(template.id)).name).toBe('Protected preset');
  });

  it('refuses that member an archive, and the preset stays active', async () => {
    const template = await seedTemplate(firm.id);
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.delete(path(`/${template.id}`));

    expect(res.status).toBe(403);
    expect((await rowById(template.id)).archived).toBe(false);
  });

  it('lets a member holding settings.manageFirm create one', async () => {
    const manager = await memberWith(firm.id, ['settings.manageFirm']);

    const res = await manager.api.post(path()).send({ name: 'Allowed', defaultTitle: 'Allowed title' });

    // Paired with the refusals above so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(201);
  });
});
