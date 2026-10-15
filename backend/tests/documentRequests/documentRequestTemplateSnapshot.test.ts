/**
 * B09.3: template instance snapshot stability.
 *
 * `document_request_templates` has no runtime link to the `document_requests`
 * it seeds - no `template_id` column anywhere in `document_requests` or
 * `document_request_items` (db/schema.sql). "Applying" a template is a
 * frontend-only act: `CreateDocumentRequestModal.tsx`'s `applyTemplate` reads
 * the template's `defaultTitle`/`defaultNote`/`items` once and copies them
 * into the create-request form fields, which are then POSTed like any other
 * manually-typed request. This test proves that through the REAL routes
 * end-to-end, rather than relying on that frontend read as documentation.
 *
 * A meaningful version of this test needs a positive control: it must show
 * the template's own update mechanism actually works (a request created
 * AFTER the edit reflects the new items), so that the main assertion - a
 * request created BEFORE the edit stays on its original items - is proof of
 * snapshotting and not just an inert wiring path. If a future change resolved
 * a request's items from its template at READ time instead of copying them at
 * CREATE time, this is the test that would go red.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let matterId: string;

const templatesPath = (suffix = '') => `/api/lawfirms/${firm.id}/document-request-templates${suffix}`;
const requestsPath = (suffix = '') => `/api/lawfirms/${firm.id}/document-requests${suffix}`;

async function seedMatter(): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Template Snapshot Matter', $3)`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [id, client.id, firm.id],
  );
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role) values ($1, $2, $3, 'lead')`,
    [id, owner.uid, firm.id],
  );
  return id;
}

/** Mirrors CreateDocumentRequestModal.applyTemplate + its submit: read the
 * template's current fields once and POST them as a normal create-request
 * payload. Nothing about the created request refers back to the template.
 * `note: template.defaultNote || ""` matches the modal exactly - the create
 * route's own schema accepts an omitted note but not an explicit null, and
 * the frontend already guards against that with the same fallback. */
async function createRequestFromTemplate(template: any) {
  return owner.api.post(requestsPath()).send({
    matterId,
    clientId: client.id,
    title: template.defaultTitle,
    note: template.defaultNote || '',
    items: template.items.map((i: any) => ({ label: i.label, description: i.description })),
  });
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Template Snapshot Client' });
  matterId = await seedMatter();
});

describe('a request created from a template keeps its own items after the template changes', () => {
  it('is unaffected by a later template edit, while a fresh request from the same template picks up the edit', async () => {
    const created = await owner.api.post(templatesPath()).send({
      name: 'Onboarding preset',
      defaultTitle: 'Onboarding Documents',
      defaultNote: 'Please provide these before your first appointment.',
      items: [
        { label: 'Passport' },
        { label: 'Proof of Address', description: 'Dated within 3 months' },
      ],
    });
    expect(created.status).toBe(201);
    const template = created.body.template;

    // Apply the template to create the "before" request.
    const before = await createRequestFromTemplate(template);
    expect(before.status).toBe(201);
    await drainEvents();
    const beforeRequestId = before.body.request.id as string;

    const snapshotBefore = before.body.request.items.map((i: any) => ({
      label: i.label, description: i.description,
    }));
    expect(snapshotBefore).toEqual([
      { label: 'Passport', description: '' },
      { label: 'Proof of Address', description: 'Dated within 3 months' },
    ]);
    expect(before.body.request.title).toBe('Onboarding Documents');

    // Edit the template: rename it, change the title/note, and replace the
    // item list outright (not append - documentRequestTemplates.service.ts's
    // `updateTemplate` always sets the whole array).
    const updated = await owner.api.put(templatesPath(`/${template.id}`)).send({
      name: 'Onboarding preset (revised)',
      defaultTitle: 'Revised Onboarding Documents',
      defaultNote: 'Updated instructions.',
      items: [{ label: 'Driving Licence' }, { label: 'Utility Bill' }, { label: 'Bank Statement' }],
    });
    expect(updated.status).toBe(200);
    const revisedTemplate = updated.body.template;

    // Positive control: applying the REVISED template produces a request with
    // the NEW items. This proves the edit actually took effect and that
    // "apply" is a live read of the template at the moment of creation - the
    // mechanism under test genuinely does something.
    const after = await createRequestFromTemplate(revisedTemplate);
    expect(after.status).toBe(201);
    await drainEvents();
    expect(after.body.request.title).toBe('Revised Onboarding Documents');
    expect(after.body.request.items.map((i: any) => i.label)).toEqual([
      'Driving Licence', 'Utility Bill', 'Bank Statement',
    ]);

    // The main assertion: re-fetching the BEFORE request shows its original
    // title, note and items, byte-for-byte, untouched by the template edit.
    const refetched = await owner.api.get(requestsPath(`/${beforeRequestId}`));
    expect(refetched.status).toBe(200);
    expect(refetched.body.request.title).toBe('Onboarding Documents');
    expect(refetched.body.request.note).toBe('Please provide these before your first appointment.');
    expect(refetched.body.request.items.map((i: any) => ({ label: i.label, description: i.description }))).toEqual([
      { label: 'Passport', description: '' },
      { label: 'Proof of Address', description: 'Dated within 3 months' },
    ]);

    // Confirmed against the database too, not just the read route's shaping.
    const { rows } = await testPool.query(
      `select label, description from document_request_items
        where request_id = $1 order by sort_order`,
      [beforeRequestId],
    );
    expect(rows).toEqual([
      { label: 'Passport', description: null },
      { label: 'Proof of Address', description: 'Dated within 3 months' },
    ]);
  });

  it('keeps working normally (item updates, rollup) after its source template is archived', async () => {
    const created = await owner.api.post(templatesPath()).send({
      name: 'Soon-archived preset',
      defaultTitle: 'Send us this',
      items: [{ label: 'W-2 Form' }],
    });
    const template = created.body.template;

    const request = await createRequestFromTemplate(template);
    expect(request.status).toBe(201);
    await drainEvents();
    const requestId = request.body.request.id as string;
    const itemId = request.body.request.items[0].id as string;

    // "Delete" a template archives it (documentRequestTemplates.service.ts) -
    // the row survives so a request's audit trail can still name where it
    // came from, but it is no longer offered in the compose modal.
    const archived = await owner.api.delete(templatesPath(`/${template.id}`));
    expect(archived.status).toBe(200);

    // The already-created request's own lifecycle is entirely independent of
    // the template row's archived state: the firm can still mark its item
    // received and the rollup still completes.
    const markReceived = await owner.api
      .patch(requestsPath(`/${requestId}/items/${itemId}`))
      .send({ status: 'received' });
    expect(markReceived.status).toBe(200);
    expect(markReceived.body.request.status).toBe('completed');
    expect(markReceived.body.request.items[0].label).toBe('W-2 Form');
  });
});
