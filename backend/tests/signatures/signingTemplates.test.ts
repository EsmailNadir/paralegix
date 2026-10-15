/**
 * Signing templates: the reusable field layouts a firm saves and re-uses.
 *
 * `signingTemplates.routes.ts` is the whole module. There is no service and no
 * dedicated repository file: the router calls five functions at the bottom of
 * `signatures.repository.ts` (`listTemplates`, `getTemplate`, `createTemplate`,
 * `updateTemplate`, `deleteTemplate`) and shapes the row itself. Those five
 * queries carry the tenant predicate INLINE, one per query, so each read path
 * can lose its scope independently of the others. That is why every case below
 * asserts cross-firm refusal separately for list, get, update and delete rather
 * than testing the list and assuming the rest.
 *
 * A template is not inert configuration. It carries `source_object_path`, which
 * the firm can later stream back through `GET /api/signing/preview`, so the
 * create/update path is a way to name a document and have the server copy it
 * into the caller's own tenant folder. `persistTemplateSource` is the gate on
 * that, and it is checked here from all three directions it can be attacked:
 * another firm's prefix, another user's transient upload, and a matter the
 * caller does not belong to.
 *
 * PERMISSION DESIGN, pinned deliberately: `signatures.view` is in
 * `DEFAULT_PERMISSIONS` (permissions.ts), the baseline every member holds and no
 * role can remove. So "a member without signatures.view is refused the list" is
 * not the design and is not asserted. The real boundary is baseline read,
 * `signatures.send` write, and that is what the cases below pin from both sides.
 *
 * THE GCS MOCK IS OVERRIDDEN HERE, with the shared in-memory bucket (through
 * `installRichBucket`, for its copy-fault seam). The harness bucket is inert by
 * design (every operation throws under its own name). This module resolves
 * `admin.storage().bucket(...)` ONCE at module load and hands that single handle
 * to every route, so the replacement is installed at module scope, before the
 * app is ever required. The shared double pins generations on reads and copies,
 * which is what saving a template relies on. It matters more than it looks: `persistTemplateSource`
 * wraps its copy in a try/catch and FALLS BACK to the original path on failure,
 * so against the inert bucket every "the source was copied somewhere durable"
 * assertion would quietly test the failure branch instead.
 *
 * Response envelopes here are domain-specific and older than the conventions in
 * AGENTS.md: `{ templates }`, `{ template }`, `{ success: true }`.
 * `frontend/src/services/signatures.service.ts` types all three, so they are
 * pinned as they are rather than corrected.
 */
import { randomUUID } from 'crypto';
import { minimalPdfBytes } from '../support/minimalPdf';

import {
  testPool,
  createFirm,
  ensureUser,
  ownerOf,
  memberWith,
  stranger,
  request,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

import { objects as storedObjects, putObject as landObject } from '../support/inMemoryBucket';
import {
  installRichBucket, resetRichBucket, failCopyFrom, richBucket,
} from '../files/richBucket';

installRichBucket();

/** What a save answers when its copy of the source cannot be made. */
const COPY_FAILED_STATUS = 500;

/** The five template functions the router calls. Driven directly at the end. */
const repo = require('../../src/modules/signatures/signatures.repository');

/** Put bytes at a path without going through any route. */
function putObject(path: string, custom: Record<string, string> = {}, body?: Buffer): void {
  landObject(path, { body: body ?? minimalPdfBytes(), custom });
}

/**
 * The template DELETE fires its storage cleanup without awaiting it, so an
 * assertion on the bucket immediately after the response races the delete.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** `expect(x).toStartWith(...)` is jest-extended, which this suite does not use. */
function expectStartsWith(actual: string, prefix: string): void {
  expect(actual.slice(0, prefix.length)).toBe(prefix);
}

// ── fixtures ───────────────────────────────────────────────────────────────

let firm: Firm;
let owner: Actor;
/** Holds `signatures.send` on top of the baseline: the write role. */
let sender: Actor;
/** Holds nothing but the baseline, which includes `signatures.view`. */
let viewer: Actor;
/** A firm with no connection to anything seeded here. */
let rival: Firm;
let rivalOwner: Actor;

const url = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/signing-templates`;

/** One well-formed signature field. */
function field(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sig_1',
    page: 1,
    xPercent: 10,
    yPercent: 20,
    widthPercent: 25,
    heightPercent: 5,
    fieldType: 'signature',
    signerId: 'role:1',
    ...overrides,
  };
}

const ROLE_ONE = { roleLabel: 'Client', order: 1, deliveryMethod: 'email' };

/** A body the create schema accepts, so a case can vary exactly one thing. */
function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Engagement Agreement',
    description: 'Standard retainer',
    fields: [field()],
    signerRoles: [ROLE_ONE],
    ...overrides,
  };
}

/**
 * A template row, seeded with SQL.
 *
 * Never through the route: a fixture built by the code under test cannot expose
 * that code. `updated_at` is settable because the list orders by it.
 */
async function seedTemplate(options: {
  lawFirmId?: string;
  name?: string;
  description?: string | null;
  fields?: unknown;
  signerRoles?: unknown;
  sourceFileName?: string | null;
  sourceObjectPath?: string | null;
  routingMode?: string | null;
  createdBy?: string | null;
  updatedAt?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  await ensureUser(options.createdBy);
  const inserted = await testPool.query(
    `insert into signature_templates
       (id, law_firm_id, name, description, fields, signer_roles, source_file_name,
        source_object_path, routing_mode, created_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11::timestamptz, now()))`,
    [
      id,
      options.lawFirmId ?? firm.id,
      options.name ?? 'Seeded Template',
      options.description === undefined ? 'Seeded description' : options.description,
      JSON.stringify(options.fields ?? [field()]),
      JSON.stringify(options.signerRoles ?? [ROLE_ONE]),
      options.sourceFileName === undefined ? 'seed.pdf' : options.sourceFileName,
      options.sourceObjectPath === undefined ? null : options.sourceObjectPath,
      options.routingMode === undefined ? 'sequential' : options.routingMode,
      options.createdBy === undefined ? null : options.createdBy,
      options.updatedAt ?? null,
    ],
  );
  expect(inserted.rowCount).toBe(1);
  return id;
}

/** The raw row, read with SQL so an assertion never depends on the route. */
async function templateRow(id: string) {
  const { rows } = await testPool.query(
    `select id, law_firm_id, name, description, fields, signer_roles, source_file_name,
            source_object_path, source_id, routing_mode, created_by
       from signature_templates where id = $1`,
    [id],
  );
  return rows[0] || null;
}

const templateCount = async (lawFirmId: string): Promise<number> => {
  const { rows } = await testPool.query(
    `select count(*)::int as n from signature_templates where law_firm_id = $1`,
    [lawFirmId],
  );
  return rows[0].n;
};

/** A matter, and optionally one member of it. */
async function seedMatter(lawFirmId: string, memberUid?: string): Promise<string> {
  const id = randomUUID();
  const created = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1,$2,$3,$4)`,
    [id, lawFirmId, 'Hollis v. Denton', `REF-${id.slice(0, 8)}`],
  );
  expect(created.rowCount).toBe(1);
  if (memberUid) {
    const joined = await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
       values ($1,$2,$3,'lead', now())`,
      [id, memberUid, lawFirmId],
    );
    expect(joined.rowCount).toBe(1);
  }
  return id;
}

beforeEach(async () => {
  storedObjects.clear();
  resetRichBucket();

  firm = await createFirm({ name: 'Denton & Associates' });
  owner = await ownerOf(firm.id);
  sender = await memberWith(firm.id, ['signatures.send']);
  viewer = await memberWith(firm.id, []);

  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);
});

// ───────────────────────────────────────────────────────────────────────────
// The plan gate. `requireFeature('documentSigning')` is mounted in app.ts, not
// in the router, so removing it from the mount would leave every route below
// working and every other case in this file green.
// ───────────────────────────────────────────────────────────────────────────
describe('the documentSigning plan gate', () => {
  it('withholds the template list from a starter-plan firm that HAS templates', async () => {
    const starter = await createFirm({ name: 'Solo Practice', planId: 'starter' });
    const starterOwner = await ownerOf(starter.id);
    await seedTemplate({ lawFirmId: starter.id, name: 'Retainer' });

    const denied = await starterOwner.api.get(url(starter.id));
    expect(denied.status).toBe(403);
    // Withheld, not absent: the row the firm cannot read is still there.
    expect(await templateCount(starter.id)).toBe(1);

    // ... and the same request on a plan that includes the feature answers it.
    await seedTemplate({ name: 'Retainer' });
    const allowed = await owner.api.get(url(firm.id));
    expect(allowed.status).toBe(200);
    expect(allowed.body.templates).toHaveLength(1);
  });

  it('refuses a starter-plan firm the individual read, and creates nothing on write', async () => {
    const starter = await createFirm({ name: 'Solo Practice', planId: 'starter' });
    const starterOwner = await ownerOf(starter.id);
    const templateId = await seedTemplate({ lawFirmId: starter.id });

    const read = await starterOwner.api.get(`${url(starter.id)}/${templateId}`);
    expect(read.status).toBe(403);

    const created = await starterOwner.api.post(url(starter.id)).send(createBody());
    expect(created.status).toBe(403);
    expect(await templateCount(starter.id)).toBe(1);

    const deleted = await starterOwner.api.delete(`${url(starter.id)}/${templateId}`);
    expect(deleted.status).toBe(403);
    expect(await templateRow(templateId)).not.toBeNull();
  });

  it('lets a professional-plan firm through: the gate is the feature, not the tier name', async () => {
    const pro = await createFirm({ name: 'Mid Firm', planId: 'professional' });
    const proOwner = await ownerOf(pro.id);
    await seedTemplate({ lawFirmId: pro.id, name: 'Retainer' });

    const res = await proOwner.api.get(url(pro.id));
    expect(res.status).toBe(200);
    expect(res.body.templates.map((t: any) => t.name)).toEqual(['Retainer']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Who may do what. `signatures.view` is baseline; `signatures.send` is not.
// ───────────────────────────────────────────────────────────────────────────
describe('permissions', () => {
  it('rejects an unauthenticated caller before it reaches the plan gate', async () => {
    await seedTemplate();
    const res = await request().get(url(firm.id));
    expect(res.status).toBe(401);
  });

  it('lets a member holding NO role permissions read: signatures.view is baseline', async () => {
    const templateId = await seedTemplate({ name: 'Engagement Agreement' });

    const list = await viewer.api.get(url(firm.id));
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t: any) => t.templateId)).toEqual([templateId]);

    const one = await viewer.api.get(`${url(firm.id)}/${templateId}`);
    expect(one.status).toBe(200);
    expect(one.body.template.name).toBe('Engagement Agreement');
  });

  it('refuses that same baseline member every write, and nothing lands', async () => {
    const templateId = await seedTemplate({ name: 'Engagement Agreement' });

    const created = await viewer.api.post(url(firm.id)).send(createBody({ name: 'Sneaked In' }));
    expect(created.status).toBe(403);
    expect(await templateCount(firm.id)).toBe(1);

    const updated = await viewer.api.put(`${url(firm.id)}/${templateId}`).send({ name: 'Renamed' });
    expect(updated.status).toBe(403);
    expect((await templateRow(templateId)).name).toBe('Engagement Agreement');

    const removed = await viewer.api.delete(`${url(firm.id)}/${templateId}`);
    expect(removed.status).toBe(403);
    expect(await templateRow(templateId)).not.toBeNull();
  });

  it('lets a member holding signatures.send create, update and delete', async () => {
    const created = await sender.api.post(url(firm.id)).send(createBody({ name: 'Send Role' }));
    expect(created.status).toBe(201);
    const templateId = created.body.template.templateId;

    const updated = await sender.api.put(`${url(firm.id)}/${templateId}`).send({ name: 'Renamed' });
    expect(updated.status).toBe(200);
    expect((await templateRow(templateId)).name).toBe('Renamed');

    const removed = await sender.api.delete(`${url(firm.id)}/${templateId}`);
    expect(removed.status).toBe(200);
    expect(await templateRow(templateId)).toBeNull();
  });

  it('refuses a signed-in caller who is a member of no firm at all', async () => {
    const templateId = await seedTemplate();
    const outsider = stranger();

    expect((await outsider.api.get(url(firm.id))).status).toBe(403);
    expect((await outsider.api.get(`${url(firm.id)}/${templateId}`)).status).toBe(403);
    expect(await templateRow(templateId)).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tenant isolation, asserted once PER QUERY. The five repository functions each
// carry their own `law_firm_id` predicate; dropping any one of them leaves the
// other four correct.
// ───────────────────────────────────────────────────────────────────────────
describe('tenant isolation', () => {
  let mine: string;
  let theirs: string;

  beforeEach(async () => {
    mine = await seedTemplate({ name: 'Mine' });
    theirs = await seedTemplate({ lawFirmId: rival.id, name: 'Theirs' });
  });

  it('lists only this firm, and the other firm still sees its own', async () => {
    const res = await owner.api.get(url(firm.id));
    expect(res.status).toBe(200);
    const ids = res.body.templates.map((t: any) => t.templateId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);

    // Present for its owner: the exclusion above is scoping, not an empty table.
    const other = await rivalOwner.api.get(url(rival.id));
    expect(other.body.templates.map((t: any) => t.templateId)).toEqual([theirs]);
  });

  it('answers 404 for another firm\'s template id on the individual read', async () => {
    const res = await owner.api.get(`${url(firm.id)}/${theirs}`);
    expect(res.status).toBe(404);
    expect(res.body.template).toBeUndefined();

    // The same id, under its own firm, is readable. The 404 is the scope.
    const owned = await rivalOwner.api.get(`${url(rival.id)}/${theirs}`);
    expect(owned.status).toBe(200);
    expect(owned.body.template.name).toBe('Theirs');
  });

  it('refuses a cross-firm update and writes nothing into the other firm\'s row', async () => {
    const res = await owner.api
      .put(`${url(firm.id)}/${theirs}`)
      .send({ name: 'Hijacked', fields: [field({ id: 'planted' })] });
    expect(res.status).toBe(404);

    const row = await templateRow(theirs);
    expect(row.name).toBe('Theirs');
    expect(row.fields.map((f: any) => f.id)).toEqual(['sig_1']);
  });

  it('refuses a cross-firm delete and leaves the row in place', async () => {
    const res = await owner.api.delete(`${url(firm.id)}/${theirs}`);
    expect(res.status).toBe(404);
    expect(await templateRow(theirs)).not.toBeNull();

    // Deleting the caller's OWN template on the same request shape works, so the
    // 404 above is about ownership rather than a broken delete.
    const own = await owner.api.delete(`${url(firm.id)}/${mine}`);
    expect(own.status).toBe(200);
    expect(await templateRow(mine)).toBeNull();
  });

  it('does not let a create under one firm land in another', async () => {
    const res = await owner.api.post(url(firm.id)).send(createBody({ name: 'Local Only' }));
    expect(res.status).toBe(201);

    const row = await templateRow(res.body.template.templateId);
    expect(row.law_firm_id).toBe(firm.id);
    expect(await templateCount(rival.id)).toBe(1); // still just `theirs`
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Field placements. They are the substance of a template: coordinates on a
// page and which signer role owns each one.
// ───────────────────────────────────────────────────────────────────────────
describe('field placements', () => {
  it('stores placements with the template and returns them intact', async () => {
    const fields = [
      field({ id: 'sig_client', page: 2, xPercent: 12.5, yPercent: 80, fieldType: 'signature', signerId: 'role:1' }),
      field({ id: 'date_client', page: 2, xPercent: 60, yPercent: 80, fieldType: 'date', label: 'Date', required: true, signerId: 'role:1' }),
    ];
    const res = await owner.api.post(url(firm.id)).send(createBody({ fields }));
    expect(res.status).toBe(201);

    const read = await owner.api.get(`${url(firm.id)}/${res.body.template.templateId}`);
    expect(read.status).toBe(200);
    expect(read.body.template.fields).toEqual([
      expect.objectContaining({ id: 'sig_client', page: 2, xPercent: 12.5, fieldType: 'signature', signerId: 'role:1' }),
      expect.objectContaining({ id: 'date_client', page: 2, fieldType: 'date', label: 'Date', required: true }),
    ]);
  });

  it('replaces the placements of the named template only', async () => {
    const target = await seedTemplate({ name: 'Target', fields: [field({ id: 'old_a' })] });
    const bystander = await seedTemplate({ name: 'Bystander', fields: [field({ id: 'keep_me' })] });

    const res = await owner.api
      .put(`${url(firm.id)}/${target}`)
      .send({ fields: [field({ id: 'new_a' }), field({ id: 'new_b', page: 3 })], signerRoles: [ROLE_ONE] });
    expect(res.status).toBe(200);
    expect(res.body.template.fields.map((f: any) => f.id)).toEqual(['new_a', 'new_b']);

    expect((await templateRow(target)).fields.map((f: any) => f.id)).toEqual(['new_a', 'new_b']);
    expect((await templateRow(bystander)).fields.map((f: any) => f.id)).toEqual(['keep_me']);
  });

  it('de-duplicates placement ids stored by an older writer on the way out', async () => {
    // Seeded directly because the create schema now rejects duplicate ids; rows
    // written before that rule still exist, and `normalizeSignatureFields` is
    // what stops the editor silently collapsing them into one.
    const templateId = await seedTemplate({
      fields: [field({ id: 'sig_1' }), field({ id: 'sig_1', page: 2 })],
    });

    const res = await owner.api.get(`${url(firm.id)}/${templateId}`);
    expect(res.status).toBe(200);
    expect(res.body.template.fields.map((f: any) => f.id)).toEqual(['sig_1', 'sig_1__2']);
  });

  it('keeps signer roles alongside the placements that reference them', async () => {
    const roles = [
      { roleLabel: 'Client', order: 1, deliveryMethod: 'portal' },
      { roleLabel: 'Attorney', order: 2, deliveryMethod: 'internal_dashboard' },
    ];
    const res = await owner.api.post(url(firm.id)).send(createBody({
      signerRoles: roles,
      fields: [field({ id: 'a', signerId: 'role:1' }), field({ id: 'b', signerId: 'role:2' })],
    }));
    expect(res.status).toBe(201);
    expect(res.body.template.signerRoles).toEqual(roles);
    expect((await templateRow(res.body.template.templateId)).signer_roles).toEqual(roles);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The serialized shape, and the list's ordering.
// ───────────────────────────────────────────────────────────────────────────
describe('serialization and ordering', () => {
  it('fills the defaults a create omitted and records the caller as author', async () => {
    const res = await owner.api.post(url(firm.id)).send({
      name: 'Bare Minimum',
      fields: [field()],
      signerRoles: [ROLE_ONE],
    });
    expect(res.status).toBe(201);

    expect(res.body.template).toEqual(expect.objectContaining({
      name: 'Bare Minimum',
      description: '',
      routingMode: 'sequential',
      sourceFileName: null,
      sourceObjectPath: null,
      createdBy: owner.uid,
    }));
    expect(res.body.template.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((await templateRow(res.body.template.templateId)).created_by).toBe(owner.uid);
  });

  it('keeps an explicit parallel routing mode', async () => {
    const res = await owner.api.post(url(firm.id)).send(createBody({ routingMode: 'parallel' }));
    expect(res.status).toBe(201);
    expect(res.body.template.routingMode).toBe('parallel');
    expect((await templateRow(res.body.template.templateId)).routing_mode).toBe('parallel');
  });

  it('substitutes sequential for a row that never recorded a routing mode', async () => {
    const templateId = await seedTemplate({ routingMode: null, description: null });
    const res = await owner.api.get(`${url(firm.id)}/${templateId}`);
    expect(res.body.template.routingMode).toBe('sequential');
    expect(res.body.template.description).toBe('');
  });

  it('orders the list by most recently updated', async () => {
    const oldest = await seedTemplate({ name: 'Oldest', updatedAt: '2026-01-01T00:00:00Z' });
    const newest = await seedTemplate({ name: 'Newest', updatedAt: '2026-06-01T00:00:00Z' });
    const middle = await seedTemplate({ name: 'Middle', updatedAt: '2026-03-01T00:00:00Z' });

    const res = await owner.api.get(url(firm.id));
    expect(res.body.templates.map((t: any) => t.templateId)).toEqual([newest, middle, oldest]);

    // An update moves its template to the front, via the table's touch trigger.
    const bumped = await owner.api.put(`${url(firm.id)}/${oldest}`).send({ name: 'Oldest, edited' });
    expect(bumped.status).toBe(200);

    const after = await owner.api.get(url(firm.id));
    expect(after.body.templates.map((t: any) => t.templateId)).toEqual([oldest, newest, middle]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Validation. Every rejection also asserts that nothing was written, because a
// 400 with a row behind it is the failure mode that matters.
// ───────────────────────────────────────────────────────────────────────────
describe('validation', () => {
  it.each([
    ['a create with no name', { name: '' }],
    ['an out-of-range placement coordinate', { fields: [field({ xPercent: 140 })] }],
    ['a field type the signing engine cannot render', { fields: [field({ fieldType: 'barcode' })] }],
  ])('rejects %s', async (_label, overrides) => {
    const res = await owner.api.post(url(firm.id)).send(createBody(overrides));
    expect(res.status).toBe(400);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects a name longer than the column is meant to hold', async () => {
    const res = await owner.api.post(url(firm.id)).send(createBody({ name: 'x'.repeat(201) }));
    expect(res.status).toBe(400);
    expect(await templateCount(firm.id)).toBe(0);

    const accepted = await owner.api.post(url(firm.id)).send(createBody({ name: 'x'.repeat(200) }));
    expect(accepted.status).toBe(201);
  });

  it('rejects a template with no fields and one with no signer roles', async () => {
    expect((await owner.api.post(url(firm.id)).send(createBody({ fields: [] }))).status).toBe(400);
    expect((await owner.api.post(url(firm.id)).send(createBody({ signerRoles: [] }))).status).toBe(400);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects duplicate field ids within one template', async () => {
    const res = await owner.api.post(url(firm.id)).send(createBody({
      fields: [field({ id: 'sig_1' }), field({ id: 'sig_1', page: 2 })],
    }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unique/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects a field assigned to a signer role that does not exist', async () => {
    const res = await owner.api.post(url(firm.id)).send(createBody({
      signerRoles: [{ roleLabel: 'Client', order: 1 }],
      fields: [field({ id: 'orphan', signerId: 'role:7' })],
    }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/existing signer role/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('applies the same dangling-role rule to an update', async () => {
    const templateId = await seedTemplate({ name: 'Intact' });
    const res = await owner.api.put(`${url(firm.id)}/${templateId}`).send({
      signerRoles: [{ roleLabel: 'Client', order: 1 }],
      fields: [field({ id: 'orphan', signerId: 'role:4' })],
    });
    expect(res.status).toBe(400);
    expect((await templateRow(templateId)).fields.map((f: any) => f.id)).toEqual(['sig_1']);
  });

  it('rejects an update that asks for nothing', async () => {
    const templateId = await seedTemplate({ name: 'Intact' });
    const res = await owner.api.put(`${url(firm.id)}/${templateId}`).send({});
    expect(res.status).toBe(400);
    expect((await templateRow(templateId)).name).toBe('Intact');
  });

  it('ignores an unknown column name rather than writing it', async () => {
    const templateId = await seedTemplate({ name: 'Intact' });
    const res = await owner.api
      .put(`${url(firm.id)}/${templateId}`)
      .send({ name: 'Renamed', lawFirmId: rival.id, createdBy: 'someone-else' });
    expect(res.status).toBe(200);

    const row = await templateRow(templateId);
    expect(row.name).toBe('Renamed');
    expect(row.law_firm_id).toBe(firm.id);
    expect(row.created_by).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Ids that name nothing. A malformed uuid must be answered the same way a
// well-formed id for a template that does not exist is answered, because it can
// never name a real template; reaching Postgres with it is a 500.
// ───────────────────────────────────────────────────────────────────────────
describe('ids that name nothing', () => {
  // A malformed id can never name a real template, so it is answered exactly as
  // a well-formed id nothing carries is, not with the 500 a uuid cast raises.
  it.each([
    ['a well-formed id no template carries', randomUUID()],
    ['a template id that is not a uuid', 'not-a-uuid'],
  ])('answers 404 for %s', async (_label, id) => {
    expect((await owner.api.get(`${url(firm.id)}/${id}`)).status).toBe(404);
    expect((await owner.api.put(`${url(firm.id)}/${id}`).send({ name: 'x' })).status).toBe(404);
    expect((await owner.api.delete(`${url(firm.id)}/${id}`)).status).toBe(404);
  });

  // A malformed LAW FIRM id is deliberately not asserted here. It answers 500,
  // and the cause is outside this module: `requireFeature` calls
  // `loadResolvedMember` (requirePermission.ts) before `requirePermission` gets
  // to run its own `isUuid` guard, so the malformed id reaches the
  // members-by-firm query as a uuid cast error. That is shared middleware on
  // every plan-gated router (trust, templates, file-share-links, messaging,
  // flat-fees, analytics, signature-links), so it belongs in a change that
  // covers all of them rather than being pinned from one module's spec.
});

// ───────────────────────────────────────────────────────────────────────────
// The source document. `persistTemplateSource` decides whether the caller may
// name a path at all, and copies it into a tenant-owned folder the template
// keeps. That copy is later streamable through GET /api/signing/preview, so an
// unchecked path here is a cross-tenant read.
// ───────────────────────────────────────────────────────────────────────────
describe('the source document a template is built from', () => {
  const durablePrefix = (lawFirmId: string) => `lawfirmids/${lawFirmId}/signing-templates/`;

  it('copies a firm-general document into a durable tenant-owned path', async () => {
    const source = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(source);

    const res = await owner.api.post(url(firm.id)).send(createBody({
      sourceObjectPath: source,
      sourceFileName: 'Engagement Agreement.pdf',
    }));
    expect(res.status).toBe(201);

    const stored = res.body.template.sourceObjectPath;
    expectStartsWith(stored, durablePrefix(firm.id));
    expect(stored.endsWith('/Engagement_Agreement.pdf')).toBe(true);
    expect(storedObjects.has(stored)).toBe(true);
    // The original is left where it was; this is a copy, not a move.
    expect(storedObjects.has(source)).toBe(true);
    expect((await templateRow(res.body.template.templateId)).source_object_path).toBe(stored);
  });

  it('inspects the document once, not once before the copy and again after it', async () => {
    // The route inspects the original so an unsignable PDF is refused before
    // anything is copied. The copy is pinned to that same generation, so its
    // bytes are the ones already inspected; admission inspecting it again was
    // a second structural walk of the same document inside the request.
    const reader = require('../../src/modules/signatures/pdf/reader');
    const walk = jest.spyOn(reader, 'readDocumentIndex');
    const source = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(source);

    try {
      const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
      expect(res.status).toBe(201);
      const durable = res.body.template.sourceObjectPath;
      const on = (path: string) => walk.mock.calls.filter(([pdf]: any[]) => pdf?.ref?.objectPath === path).length;
      // The original is walked once. The copy is walked only by preparation.
      expect({ original: on(source), copy: on(durable) }).toEqual({ original: 1, copy: 1 });
    } finally {
      walk.mockRestore();
    }
  });

  it('pins the copy to the version it inspected', async () => {
    // Between the check and the copy the firm can replace the object. An
    // unpinned copy takes the new bytes under a check that passed for the old
    // ones, and the template then holds a document nobody approved. The
    // replacement lands at the last moment it can: as the copy is issued.
    const source = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(source);
    const replacement = minimalPdfBytes({ pages: 2 });
    const realFile = richBucket.file;
    const fileSpy = jest.spyOn(richBucket, 'file').mockImplementation((path: string, options?: any) => {
      const handle = realFile(path, options) as any;
      if (path !== source) return handle;
      return {
        ...handle,
        copy: async (destination: { name: string }, copyOptions?: any) => {
          putObject(source, {}, replacement);
          return handle.copy(destination, copyOptions);
        },
      };
    });

    let res;
    try {
      res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    } finally {
      fileSpy.mockRestore();
    }

    // The replacement really happened, so a save that succeeded would have
    // copied bytes nobody inspected.
    expect(storedObjects.get(source)!.body).toEqual(replacement);
    expect(res.status).toBe(COPY_FAILED_STATUS);
    expect(await templateCount(firm.id)).toBe(0);
    expect([...storedObjects.keys()].some((k) => k.startsWith(durablePrefix(firm.id)))).toBe(false);
  });

  it('admits the copy as a source and records it on the template', async () => {
    const source = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(source);

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    expect(res.status).toBe(201);

    // Without this the template records a PATH and nothing else, so applying it
    // re-inspects the document every time and re-does the flatten and the hash
    // that sealing needs, per session, over the same bytes.
    const row = await templateRow(res.body.template.templateId);
    expect(row.source_id).toEqual(expect.any(String));

    const { rows } = await testPool.query(
      'select object_path, status from signature_sources where law_firm_id = $1 and id = $2',
      [firm.id, row.source_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].object_path).toBe(row.source_object_path);
    // Prepared inline: the source a session uses is the PREPARED copy, and a
    // template saved with a pending source cannot be applied until it is ready.
    expect(rows[0].status).toBe('ready');
  });

  it('reuses the source when an update does not change the document', async () => {
    const source = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(source);
    const created = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    const before = await templateRow(created.body.template.templateId);

    const updated = await owner.api.put(`${url(firm.id)}/${created.body.template.templateId}`)
      .send({ name: 'Renamed', sourceObjectPath: before.source_object_path });
    expect(updated.status).toBe(200);

    // Re-admitting the same bytes would flatten and re-hash a document that is
    // already prepared, and leave a second source row nothing points at.
    const after = await templateRow(created.body.template.templateId);
    expect(after.source_id).toBe(before.source_id);
    // Scoped to the template's own prefix: `createFirm` seeds a placeholder
    // source so a SQL-seeded session has one to name, and counting every source
    // in the firm would count that one too.
    const { rows } = await testPool.query(
      `select count(*)::int as n from signature_sources
        where law_firm_id = $1 and object_path like $2`,
      [firm.id, `lawfirmids/${firm.id}/signing-templates/%`],
    );
    expect(rows[0].n).toBe(1);
  });

  it('records no source for a template with no document', async () => {
    const res = await owner.api.post(url(firm.id)).send(createBody());

    expect(res.status).toBe(201);
    // An HTML-only template names no document, and a source row for nothing
    // would be a row the readiness check later refuses to apply.
    const row = await templateRow(res.body.template.templateId);
    expect(row.source_id).toBeNull();
    expect(row.source_object_path).toBeNull();
  });

  it('REFUSES an encrypted PDF at save, not at send', async () => {
    // The template routes used to check nothing, so a template built on a
    // document that cannot be signed failed much later: at the point a signer
    // had already been invited and emailed.
    const source = `lawfirmids/${firm.id}/general/locked.pdf`;
    putObject(source, {}, minimalPdfBytes({ encrypted: true }));

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PDF_ENCRYPTED');
    expect(await templateCount(firm.id)).toBe(0);
    expect([...storedObjects.keys()].some((k) => k.startsWith(durablePrefix(firm.id)))).toBe(false);
  });

  it('REFUSES a document that already carries a signature', async () => {
    const source = `lawfirmids/${firm.id}/general/signed.pdf`;
    putObject(source, {}, minimalPdfBytes({ acroForm: true, sigFlags: 3 }));

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PDF_EXISTING_SIGNATURE');
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('REFUSES the save when the copy fails, rather than keeping the original path', async () => {
    // Keeping the original looks like a graceful fallback and is not one. That
    // original is a transient upload the ten-day sweep deletes, or a firm
    // document the firm can delete, so the template would look saved and be
    // broken the first time anyone used it.
    const source = `signing-uploads/${firm.id}/${randomUUID()}/upload.pdf`;
    putObject(source, { uploadedBy: owner.uid });
    failCopyFrom.add(source);

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));

    expect(res.status).toBe(COPY_FAILED_STATUS);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('refuses a path inside another firm and creates nothing', async () => {
    const source = `lawfirmids/${rival.id}/general/secret.pdf`;
    putObject(source);

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/within this law firm/i);
    expect(await templateCount(firm.id)).toBe(0);
    // Nothing was copied into the caller's tenant folder.
    expect([...storedObjects.keys()].some((k) => k.startsWith(durablePrefix(firm.id)))).toBe(false);
  });

  it('refuses a bare path outside the lawfirmids tree', async () => {
    putObject('some-other-bucket-prefix/secret.pdf');
    const res = await owner.api
      .post(url(firm.id))
      .send(createBody({ sourceObjectPath: 'some-other-bucket-prefix/secret.pdf' }));
    expect(res.status).toBe(403);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('refuses a transient upload belonging to a different user', async () => {
    const source = `signing-uploads/${sender.uid}/draft.pdf`;
    putObject(source, { uploadedBy: sender.uid });

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access to this uploaded document/i);
    expect(await templateCount(firm.id)).toBe(0);

    // Same object, its own uploader: accepted. The refusal above is ownership.
    const mine = await sender.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    expect(mine.status).toBe(201);
    expectStartsWith(mine.body.template.sourceObjectPath, durablePrefix(firm.id));
  });

  it('refuses a transient upload carrying no uploader at all', async () => {
    const source = 'signing-uploads/orphaned/draft.pdf';
    putObject(source);

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    expect(res.status).toBe(403);
    expect(await templateCount(firm.id)).toBe(0);
  });

  /** A real document in a matter's tree: a row, and the bytes behind it. */
  async function matterDocument(
    matterId: string,
    { name = 'pleading.pdf', custom = {} as Record<string, string> } = {},
  ) {
    // Required lazily: this spec installs its own bucket at module scope, and
    // the files module resolves its bucket handle when it is first loaded.
    const filesRepo = require('../../src/modules/files/files.repository');
    const root = await filesRepo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const row = await filesRepo.createFile(firm.id, {
      parentId: root, name, mimeType: 'application/pdf',
    });
    await filesRepo.finalize(firm.id, row.id, { sizeBytes: 1024, mimeType: 'application/pdf' });
    putObject(row.objectPath, custom);
    return row.objectPath;
  }

  it('refuses a matter document the caller is not on the matter for, owner included', async () => {
    const matterId = await seedMatter(firm.id); // nobody added
    // A real ROW, because that is where the matter now lives. This gate used to
    // read the matter out of the object path, and an object path says nothing
    // about the tree any more.
    const source = await matterDocument(matterId);

    const res = await owner.api.post(url(firm.id)).send(createBody({ sourceObjectPath: source }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member of this matter/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('accepts a matter document from someone on that matter', async () => {
    const matterId = await seedMatter(firm.id, sender.uid);
    const source = await matterDocument(matterId, { custom: { note: 'original' } });

    const res = await sender.api.post(url(firm.id)).send(createBody({
      sourceObjectPath: source,
      sourceFileName: 'pleading.pdf',
    }));
    expect(res.status).toBe(201);
    expectStartsWith(res.body.template.sourceObjectPath, durablePrefix(firm.id));
    expect(storedObjects.get(res.body.template.sourceObjectPath)!.custom.note).toBe('original');
  });

  it('leaves an already tenant-owned template path alone instead of re-copying it', async () => {
    const durable = `${durablePrefix(firm.id)}abc123/Engagement_Agreement.pdf`;
    putObject(durable);
    const templateId = await seedTemplate({ sourceObjectPath: durable });

    const res = await owner.api
      .put(`${url(firm.id)}/${templateId}`)
      .send({ sourceObjectPath: durable, name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.template.sourceObjectPath).toBe(durable);
    // No second copy was made under the template prefix.
    expect([...storedObjects.keys()].filter((k) => k.startsWith(durablePrefix(firm.id)))).toEqual([durable]);
  });

  it('applies the same path rules to an update, leaving the template untouched on refusal', async () => {
    const templateId = await seedTemplate({ name: 'Intact', sourceObjectPath: null });
    const source = `lawfirmids/${rival.id}/general/secret.pdf`;
    putObject(source);

    const res = await owner.api
      .put(`${url(firm.id)}/${templateId}`)
      .send({ name: 'Renamed', sourceObjectPath: source });
    expect(res.status).toBe(403);

    const row = await templateRow(templateId);
    expect(row.name).toBe('Intact');
    expect(row.source_object_path).toBeNull();
  });

  it('cannot be walked out of the template folder by a hostile file name', async () => {
    const source = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(source);

    const res = await owner.api.post(url(firm.id)).send(createBody({
      sourceObjectPath: source,
      sourceFileName: '../../../lawfirmids/evil/escape hatch.pdf',
    }));
    expect(res.status).toBe(201);

    const stored: string = res.body.template.sourceObjectPath;
    expectStartsWith(stored, durablePrefix(firm.id));
    // The separators are what make traversal possible, and they are gone: the
    // name survives as exactly ONE path segment under the random folder. The
    // dots themselves are harmless once no `/` remains, so this asserts the
    // shape rather than the absence of '..'.
    const tail = stored.slice(durablePrefix(firm.id).length).split('/');
    expect(tail).toHaveLength(2);
    expect(tail[1]).toBe('.._.._.._lawfirmids_evil_escape_hatch.pdf');
    expect(storedObjects.has(stored)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Delete, and what it takes with it.
// ───────────────────────────────────────────────────────────────────────────
describe('delete', () => {
  const durablePrefix = (lawFirmId: string) => `lawfirmids/${lawFirmId}/signing-templates/`;

  it('removes the row and the durable copy it owned', async () => {
    const durable = `${durablePrefix(firm.id)}abc123/Agreement.pdf`;
    putObject(durable);
    const templateId = await seedTemplate({ sourceObjectPath: durable });

    const res = await owner.api.delete(`${url(firm.id)}/${templateId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(await templateRow(templateId)).toBeNull();

    await settle();
    expect(storedObjects.has(durable)).toBe(false);

    expect((await owner.api.get(`${url(firm.id)}/${templateId}`)).status).toBe(404);
  });

  it('leaves a shared firm document alone: only a template-owned copy is deleted', async () => {
    const shared = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(shared);
    const templateId = await seedTemplate({ sourceObjectPath: shared });

    expect((await owner.api.delete(`${url(firm.id)}/${templateId}`)).status).toBe(200);
    await settle();
    expect(storedObjects.has(shared)).toBe(true);
  });

  it('is unconditional: a signing session over the same document survives it', async () => {
    // Templates and sessions are not linked. A session copies the placements at
    // send time and never references the template again, so deleting one does
    // not touch a signature in flight. If a "template in use" guard is ever
    // added, this is the case that has to change deliberately.
    const shared = `lawfirmids/${firm.id}/general/original.pdf`;
    putObject(shared);
    const templateId = await seedTemplate({ sourceObjectPath: shared });

    const token = `sess-${randomUUID().slice(0, 12)}`;
    const seeded = await testPool.query(
      `insert into signature_sessions
         (token, law_firm_id, source_id, created_by, status, file_name, object_path,
          expires_at)
       values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'in_progress', 'Agreement.pdf', $4, now() + interval '7 days')`,
      [token, firm.id, owner.uid, shared],
    );
    expect(seeded.rowCount).toBe(1);

    expect((await owner.api.delete(`${url(firm.id)}/${templateId}`)).status).toBe(200);

    const { rows } = await testPool.query(
      `select status from signature_sessions where token = $1`,
      [token],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_progress');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The two write queries, driven directly.
//
// Across firms these are unreachable through the router: every write handler
// calls `getTemplate` first and answers 404 on its null, so the cross-firm
// route cases above prove the BOUNDARY holds while proving nothing about the
// `law_firm_id` predicate `updateTemplate` and `deleteTemplate` carry
// themselves. That predicate is the second line if the first is ever
// refactored away, and calling the functions is the only way to see it.
// ───────────────────────────────────────────────────────────────────────────
describe('the template write queries, called directly', () => {
  it('will not update a template under a firm that does not own it', async () => {
    const theirs = await seedTemplate({ lawFirmId: rival.id, name: 'Theirs' });

    expect(await repo.updateTemplate(theirs, firm.id, { name: 'Hijacked' })).toBeNull();
    expect((await templateRow(theirs)).name).toBe('Theirs');

    // The same call under the owning firm lands, so the null above is the
    // scope rather than a broken update.
    const owned = await repo.updateTemplate(theirs, rival.id, { name: 'Renamed' });
    expect(owned.name).toBe('Renamed');
  });

  it('will not delete a template under a firm that does not own it', async () => {
    const theirs = await seedTemplate({ lawFirmId: rival.id, name: 'Theirs' });

    expect(await repo.deleteTemplate(theirs, firm.id)).toBe(false);
    expect(await templateRow(theirs)).not.toBeNull();

    expect(await repo.deleteTemplate(theirs, rival.id)).toBe(true);
    expect(await templateRow(theirs)).toBeNull();
  });
});
