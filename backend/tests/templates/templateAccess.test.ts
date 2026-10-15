/**
 * Who may read, edit and delete a firm's document templates, and what the
 * document-backed endpoints refuse.
 *
 * `templates.service.ts` was at 7%. A template is the firm's reusable paperwork:
 * its engagement letter, its retainer, its fee agreement. Two failure modes here
 * cost real money. One firm reading or overwriting another firm's template is a
 * confidentiality breach with a client's terms inside it. A template silently
 * reassigned into a folder that belongs to somebody else is the same leak with a
 * quieter symptom, because nothing on either firm's screen looks wrong.
 *
 * Templates are seeded with SQL rather than created through the API, for the
 * reason `publicShareLinks.test.ts` gives: every creation path in this module
 * writes the body to GCS, and GCS is inert in this harness, so a fixture built
 * through the create route would fail at the fixture. Seeding also puts a
 * template into states the API cannot produce on demand -- a DOCX row whose
 * stored document has gone missing, an overlay row with no rendered PDF -- which
 * is exactly where the refusal paths below live.
 *
 * Nothing in this file touches the bucket. Every case is either a database read,
 * a database write, or a guard that returns before storage is reached. Where a
 * path does reach storage the case stops at the refusal that precedes it.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

interface SeedOptions {
  name?: string;
  type?: 'html' | 'docx' | 'overlay';
  fields?: string[];
  repeaters?: unknown;
  folderId?: string | null;
  htmlObjectPath?: string | null;
  docxObjectPath?: string | null;
  overlayPdfObjectPath?: string | null;
  overlaySourceObjectPath?: string | null;
  assets?: unknown;
}

/**
 * A template row, written straight into the table.
 *
 * The object-path columns default to NULL. That is not laziness: a row with a
 * path set sends the service to the bucket, and a row without one sends it to
 * the "this template has no document" guard. Every case states which of the two
 * it is exercising by what it passes here.
 */
async function seedTemplate(lawFirmId: string, options: SeedOptions = {}) {
  const id = randomUUID();
  await testPool.query(
    `insert into templates
       (id, law_firm_id, name, type, fields, repeaters, folder_id,
        html_object_path, docx_object_path, overlay_pdf_object_path,
        overlay_source_object_path, assets)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      lawFirmId,
      options.name ?? `Template ${id.slice(0, 8)}`,
      options.type ?? 'html',
      options.fields ?? [],
      JSON.stringify(options.repeaters ?? []),
      options.folderId ?? null,
      options.htmlObjectPath ?? null,
      options.docxObjectPath ?? null,
      options.overlayPdfObjectPath ?? null,
      options.overlaySourceObjectPath ?? null,
      JSON.stringify(options.assets ?? []),
    ],
  );
  return { id };
}

async function seedFolder(lawFirmId: string, name = 'Retainers') {
  const id = randomUUID();
  await testPool.query(
    'insert into template_folders (id, law_firm_id, name) values ($1, $2, $3)',
    [id, lawFirmId, name],
  );
  return { id };
}

const templateRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, type, folder_id, law_firm_id, fields from templates where id = $1',
    [id],
  );
  return rows[0];
};

const templateCount = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int n from templates where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('reading templates', () => {
  it('lists the firm templates', async () => {
    await seedTemplate(firm.id, { name: 'Engagement Letter' });

    const res = await owner.api.get(T(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.templates.map((t: any) => t.name)).toEqual(['Engagement Letter']);
    expect(res.body.totalTemplates).toBe(1);
  });

  it('does NOT list another firm templates', async () => {
    // Seeded on the OTHER firm, and this firm is given one of its own, so the
    // assertion cannot pass against an empty list that proves nothing.
    const otherFirm = await createFirm();
    await seedTemplate(otherFirm.id, { name: 'Confidential Fee Agreement' });
    await seedTemplate(firm.id, { name: 'Our Own Letter' });

    const res = await owner.api.get(T(firm.id));

    expect(res.body.templates.map((t: any) => t.name)).toEqual(['Our Own Letter']);
    expect(res.body.totalTemplates).toBe(1);
  });

  it('returns one template by id', async () => {
    const { id } = await seedTemplate(firm.id, { name: 'Retainer', fields: ['clientName'] });

    const res = await owner.api.get(`${T(firm.id)}/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('Retainer');
    expect(res.body.template.fields).toEqual(['clientName']);
  });

  it('refuses to read ANOTHER firm template by id', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { id } = await seedTemplate(firm.id, { name: 'Confidential Fee Agreement' });
    // Prove the id resolves for the firm that owns it, so the 404 below is the
    // tenant scope refusing and not a template that was never written.
    expect((await owner.api.get(`${T(firm.id)}/${id}`)).status).toBe(200);

    const res = await otherOwner.api.get(`${T(otherFirm.id)}/${id}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Fee Agreement');
  });

  it('answers not-found for a malformed template id rather than a database error', async () => {
    const res = await owner.api.get(`${T(firm.id)}/not-a-uuid`);

    // `id` is a uuid column. Handing Postgres a non-uuid raises a cast error,
    // which surfaces as a 500 and an alert. The repository's id guard is what
    // turns a mistyped or probed URL into an ordinary 404.
    expect(res.status).toBe(404);
  });

  it('routes /templates/folders to the folder list, not to a template lookup', async () => {
    await seedFolder(firm.id, 'Retainers');

    const res = await owner.api.get(`${T(firm.id)}/folders`);

    // The folders router is mounted ahead of the templates router on the same
    // path in app.ts. Swap the two and `folders` is read as a template id, so
    // the whole folder tree answers 404 and every template in the firm loses
    // its home in the sidebar.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Retainers');
  });
});

describe('permissions', () => {
  it('CHARACTERISATION: a member with an empty role can still READ templates', async () => {
    await seedTemplate(firm.id, { name: 'Engagement Letter' });
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.get(T(firm.id));

    // `templates.view` sits in DEFAULT_PERMISSIONS, the baseline no role can
    // remove. That is deliberate: the firm's own boilerplate is not confidential
    // from the firm, and withholding it produced a denial screen for anyone who
    // needed to generate a letter. Recorded here so the decision is visible, and
    // so moving `templates.view` out of the baseline is a change somebody has to
    // make on purpose.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Engagement Letter');
  });

  it('refuses a member with an empty role the right to CHANGE a template', async () => {
    const { id } = await seedTemplate(firm.id, { name: 'Engagement Letter' });
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.put(`${T(firm.id)}/${id}`).send({ name: 'Rewritten' });

    // The other half of the baseline: reading the firm's boilerplate is open,
    // editing it is not. `templates.manage` is what separates a paralegal
    // generating a letter from one rewriting the firm's engagement terms.
    expect(res.status).toBe(403);
    expect((await templateRow(id)).name).toBe('Engagement Letter');
  });

  it('lets a view-only member read but NOT delete', async () => {
    const { id } = await seedTemplate(firm.id);
    const viewer = await createFirmMember(firm.id, { isOwner: false, permissions: ['templates.view'] });
    const viewerApi = as(tokenFor({ uid: viewer.uid }));

    // Both halves, because a gate that refused everything would satisfy the
    // delete assertion on its own and quietly break the read-only role.
    expect((await viewerApi.get(`${T(firm.id)}/${id}`)).status).toBe(200);
    const res = await viewerApi.delete(`${T(firm.id)}/${id}`);

    expect(res.status).toBe(403);
    expect(await templateRow(id)).toBeDefined();
  });

  it('refuses a caller who belongs to no firm at all', async () => {
    const { id } = await seedTemplate(firm.id, { name: 'Engagement Letter' });
    const outsider = as(tokenFor({ uid: `outsider-${randomUUID().slice(0, 8)}` }));

    const res = await outsider.get(`${T(firm.id)}/${id}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain('Engagement Letter');
  });
});

describe('updating a template', () => {
  it('renames it', async () => {
    const { id } = await seedTemplate(firm.id, { name: 'Old Name' });

    const res = await owner.api.put(`${T(firm.id)}/${id}`).send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('New Name');
    // Asserted from the table as well as the response: the response is built by
    // merging the update over the row it read, so it can report a name the write
    // never persisted.
    expect((await templateRow(id)).name).toBe('New Name');
  });

  it('refuses to update ANOTHER firm template and leaves it untouched', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { id } = await seedTemplate(firm.id, { name: 'Engagement Letter' });

    const res = await otherOwner.api.put(`${T(otherFirm.id)}/${id}`).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await templateRow(id)).name).toBe('Engagement Letter');
  });

  it('files the template into one of the firm own folders', async () => {
    const { id } = await seedTemplate(firm.id);
    const folder = await seedFolder(firm.id);

    const res = await owner.api.put(`${T(firm.id)}/${id}`).send({ folderId: folder.id });

    expect(res.status).toBe(200);
    expect((await templateRow(id)).folder_id).toBe(folder.id);
  });

  it('refuses a folder that belongs to ANOTHER firm', async () => {
    const otherFirm = await createFirm();
    const foreignFolder = await seedFolder(otherFirm.id, 'Their Retainers');
    const { id } = await seedTemplate(firm.id);

    const res = await owner.api.put(`${T(firm.id)}/${id}`).send({ folderId: foreignFolder.id });

    // A folder id is a plain uuid in the body, so nothing but this check stops a
    // firm parking its template under another firm's folder. The folder row
    // carries the other firm's law_firm_id, and the template would then appear
    // in a tree neither firm can reconcile.
    expect(res.status).toBe(404);
    expect((await templateRow(id)).folder_id).toBeNull();
  });

  it('moves the template back to the root when the folder is cleared', async () => {
    const folder = await seedFolder(firm.id);
    const { id } = await seedTemplate(firm.id, { folderId: folder.id });

    const res = await owner.api.put(`${T(firm.id)}/${id}`).send({ folderId: null });

    // `folderId: null` has to mean "unfile it", not "leave it where it is". The
    // service distinguishes an explicit null from an absent key, and collapsing
    // the two would strand a template in a folder the user just removed it from.
    expect(res.status).toBe(200);
    expect((await templateRow(id)).folder_id).toBeNull();
  });

  it('leaves the folder alone when the update does not mention it', async () => {
    const folder = await seedFolder(firm.id);
    const { id } = await seedTemplate(firm.id, { folderId: folder.id });

    await owner.api.put(`${T(firm.id)}/${id}`).send({ name: 'Renamed Only' });

    // The other side of the case above. A rename that also unfiled the template
    // would empty a firm's folder tree one edit at a time.
    expect((await templateRow(id)).folder_id).toBe(folder.id);
  });

  it('refuses an empty name', async () => {
    const { id } = await seedTemplate(firm.id, { name: 'Engagement Letter' });

    const res = await owner.api.put(`${T(firm.id)}/${id}`).send({ name: '' });

    expect(res.status).toBe(400);
    expect((await templateRow(id)).name).toBe('Engagement Letter');
  });
});

describe('deleting a template', () => {
  it('removes the row', async () => {
    const { id } = await seedTemplate(firm.id);

    const res = await owner.api.delete(`${T(firm.id)}/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.templateId).toBe(id);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('refuses to delete ANOTHER firm template', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { id } = await seedTemplate(firm.id);

    const res = await otherOwner.api.delete(`${T(otherFirm.id)}/${id}`);

    expect(res.status).toBe(404);
    expect(await templateCount(firm.id)).toBe(1);
  });

  it('answers not-found for a template that is already gone', async () => {
    const res = await owner.api.delete(`${T(firm.id)}/${randomUUID()}`);

    expect(res.status).toBe(404);
  });
});

describe('filling a template', () => {
  const fill = (lawFirmId: string, templateId: string, body: Record<string, unknown> = {}) =>
    owner.api.post(`${T(lawFirmId)}/${templateId}/fill`).send(body);

  it('refuses to fill an HTML template', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'html' });

    const res = await fill(firm.id, id);

    // HTML templates are merged in the browser from HTML the client already
    // holds. Falling through to the DOCX branch here would download a null
    // object path and answer 500 on an ordinary user action.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/DOCX and Document Overlay/i);
  });

  it('refuses a DOCX template whose stored document is missing', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'docx', docxObjectPath: null });

    const res = await fill(firm.id, id);

    // The row can outlive its object: the upload is a separate write from the
    // row update, and the GC sweep deletes anything unreferenced. A 400 names
    // the problem; without the guard the download throws and the firm sees an
    // internal error on a document they are trying to send a client.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not found/i);
  });

  it('refuses an overlay template with no rendered PDF', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'overlay', overlayPdfObjectPath: null });

    const res = await fill(firm.id, id);

    // The overlay branch is guarded separately from the DOCX branch above, and
    // an overlay row genuinely reaches this state: creation writes the row
    // before the LibreOffice conversion that produces the PDF.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not found/i);
  });

  it('refuses an output format it cannot produce', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'docx', docxObjectPath: null });

    const res = await fill(firm.id, id, { format: 'exe' });

    // The format reaches the LibreOffice conversion as a target filter. It is
    // an enum for that reason, and it is checked before the template type, so
    // this stays a 400 even though the template above is otherwise unfillable.
    expect(res.status).toBe(400);
  });

  it('refuses to fill ANOTHER firm template', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { id } = await seedTemplate(firm.id, { type: 'docx', docxObjectPath: 'x/y.docx' });

    const res = await otherOwner.api.post(`${T(otherFirm.id)}/${id}/fill`).send({});

    // Filling is the one template action a view-only member may take, so it is
    // also the widest door into the module. It must still stop at the tenant
    // boundary.
    expect(res.status).toBe(404);
  });

  it('lets a view-only member fill', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'html' });
    const viewer = await createFirmMember(firm.id, { isOwner: false, permissions: ['templates.view'] });
    const viewerApi = as(tokenFor({ uid: viewer.uid }));

    const res = await viewerApi.post(`${T(firm.id)}/${id}/fill`).send({});

    // 400 from the service, not 403 from the gate: producing a document from a
    // template is a `templates.view` action, and a paralegal who cannot manage
    // templates still has to be able to generate paperwork from them.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/DOCX and Document Overlay/i);
  });
});

describe('previewing a template', () => {
  it('refuses to preview an HTML template', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'html' });

    const res = await owner.api.get(`${T(firm.id)}/${id}/preview`);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/document preview/i);
  });

  it('refuses to preview an overlay template with no document', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'overlay', overlayPdfObjectPath: null });

    const res = await owner.api.get(`${T(firm.id)}/${id}/preview`);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/no document to preview/i);
  });

  it('refuses to preview a DOCX template with no document', async () => {
    const { id } = await seedTemplate(firm.id, { type: 'docx', docxObjectPath: null });

    const res = await owner.api.get(`${T(firm.id)}/${id}/preview`);

    // Guarded separately from the overlay branch, and reachable the same way:
    // the row is written before the document upload that fills this column.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/no document to preview/i);
  });

  it('refuses to preview ANOTHER firm template', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { id } = await seedTemplate(firm.id, { type: 'overlay', overlayPdfObjectPath: 'x/y.pdf' });

    const res = await otherOwner.api.get(`${T(otherFirm.id)}/${id}/preview`);

    // Preview streams the stored document itself. A leak here hands over the
    // whole file, not a name in a list.
    expect(res.status).toBe(404);
  });
});
