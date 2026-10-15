/**
 * `templates.routes.ts` builds its service-call object as
 * `{ lawFirmId: req.params.lawFirmId, ...req.body }` (create) and
 * `{ lawFirmId: req.params.lawFirmId, templateId: req.params.templateId, ...req.body }`
 * (update) -- the trusted URL-derived fields spread BEFORE the body, so a
 * same-named key in the body wins the object-literal merge.
 *
 * That is the same shape already fixed in tasks.routes.ts and matters.routes.ts
 * (see the "server-owned fields cannot be widened from the body" block in
 * tests/tasks/tasks.test.ts), but worse here: templatesService.createTemplate
 * and .updateTemplate never call assertLawFirmMembership or any other
 * membership check, so neither route's handler nor its service ever checks
 * that the caller belongs to the firm named in the body. A caller only needs
 * `templates.manage` in their OWN firm to plant or overwrite a template in a
 * firm they have never even joined.
 *
 * Templates are the firm's reusable paperwork -- engagement letters,
 * retainers, fee agreements (see templateAccess.test.ts) -- so a cross-tenant
 * create/overwrite here is a confidentiality and integrity breach with no
 * shared-membership precondition at all.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket } from '../support/inMemoryBucket';

// createTemplate always writes the body to storage (html is required by
// createTemplateSchema), and the harness's default GCS double throws by name.
// This is the swap the mock itself tells a spec to make when the object IS
// the thing under test -- see templateHtmlStorage.test.ts.
installInMemoryBucket();

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

async function seedTemplate(lawFirmId: string, name: string) {
  const id = randomUUID();
  await testPool.query(
    `insert into templates
       (id, law_firm_id, name, type, fields, repeaters, folder_id,
        html_object_path, docx_object_path, overlay_pdf_object_path,
        overlay_source_object_path, assets)
     values ($1, $2, $3, 'html', $4, $5, null, null, null, null, null, $6)`,
    [id, lawFirmId, name, [], JSON.stringify([]), JSON.stringify([])],
  );
  return id;
}

const templateRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select id, law_firm_id, name from templates where id = $1',
    [id],
  );
  return rows[0];
};

const templatesNamed = async (lawFirmId: string, name: string) => {
  const { rows } = await testPool.query(
    'select id, law_firm_id, name from templates where law_firm_id = $1 and name = $2',
    [lawFirmId, name],
  );
  return rows;
};

let firmA: Firm;
let firmB: Firm;
let attacker: Actor;

beforeEach(async () => {
  firmA = await createFirm();
  firmB = await createFirm();
  // The attacker holds templates.manage in firm A only -- NOT a member of
  // firm B at all, unlike the shared-membership tasks/matters case.
  const member = await createFirmMember(firmA.id, { isOwner: false, permissions: ['templates.manage'] });
  attacker = { uid: member.uid, api: as(tokenFor({ uid: member.uid })) };
});

describe('templates create/update cannot be redirected to another firm via the body', () => {
  it('ignores a lawFirmId in the create body and scopes the template to the URL firm', async () => {
    const res = await attacker.api.post(T(firmA.id)).send({
      name: 'Cross-Tenant Plant',
      html: '<p>hijacked content</p>',
      fields: [],
      lawFirmId: firmB.id,
    });

    expect(res.status).toBe(201);

    const underFirmB = await templatesNamed(firmB.id, 'Cross-Tenant Plant');
    expect(underFirmB).toHaveLength(0);

    const underFirmA = await templatesNamed(firmA.id, 'Cross-Tenant Plant');
    expect(underFirmA).toHaveLength(1);
  });

  it('ignores a templateId/lawFirmId in the update body and never reaches another firm template', async () => {
    const victimId = await seedTemplate(firmB.id, 'Firm B Engagement Letter');
    const ownId = await seedTemplate(firmA.id, 'My Own Template');

    // The URL names the template and firm being edited. A body that could
    // override them with lawFirmId/templateId would let a caller with
    // templates.manage in ANY firm overwrite a template belonging to a
    // completely unrelated firm they were never a member of, simply by
    // naming it in the payload of an update they are otherwise entitled to
    // make on their own template. No html in the body, so this never
    // touches storage.
    const res = await attacker.api.put(`${T(firmA.id)}/${ownId}`).send({
      name: 'HIJACKED',
      lawFirmId: firmB.id,
      templateId: victimId,
    });

    expect(res.status).toBe(200);
    expect((await templateRow(ownId)).name).toBe('HIJACKED');
    expect((await templateRow(victimId)).name).toBe('Firm B Engagement Letter');
  });
});
