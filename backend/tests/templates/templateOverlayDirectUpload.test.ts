/**
 * Overlay templates take their PDF through a storage session, not multer.
 *
 * The old route buffered the document before it created the template row. This
 * drives both new JSON endpoints through the real app, lands bytes as storage
 * would, and proves the temporary upload is removed after its exact generation
 * is copied into the template prefix.
 */
import { objects, landUpload, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import { createFirm, ownerOf, type Actor, type Firm } from '../support/setupInProcess';
import { randomUUID } from 'crypto';
const PizZip = require('pizzip');

installInMemoryBucket();

let firm: Firm;
let owner: Actor;

const templatesBase = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

function minimalDocx(fieldName = 'clientName') {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>{${fieldName}}</w:t></w:r></w:p></w:body>
</w:document>`);
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Overlay Direct LLP' });
  owner = await ownerOf(firm.id);
});

it('creates an overlay from a direct PDF upload and removes the temporary object', async () => {
  const init = await owner.api.post(`${templatesBase(firm.id)}/upload-overlay-init`).send({
    fileName: 'court-form.pdf', contentType: 'application/pdf', size: minimalPdfBytes().length,
  });

  expect(init.status).toBe(200);
  expect(init.body.objectPath).toMatch(new RegExp(`^template-uploads/${firm.id}/${owner.uid}/`));
  landUpload(init.body.objectPath, { body: minimalPdfBytes() });

  const finalized = await owner.api.post(`${templatesBase(firm.id)}/upload-overlay-finalize`).send({
    objectPath: init.body.objectPath,
    fileName: 'court-form.pdf',
    name: 'Court Form',
  });

  expect(finalized.status).toBe(201);
  expect(finalized.body.template.type).toBe('overlay');
  expect(finalized.body.templateId).toBeTruthy();
  expect(objects.has(init.body.objectPath)).toBe(false);
  expect(objects.get(finalized.body.template.overlayPdfObjectPath)?.body).toEqual(minimalPdfBytes());
});

it('does not let a different firm finalize the temporary object', async () => {
  const init = await owner.api.post(`${templatesBase(firm.id)}/upload-overlay-init`).send({
    fileName: 'court-form.pdf', contentType: 'application/pdf', size: minimalPdfBytes().length,
  });
  landUpload(init.body.objectPath, { body: minimalPdfBytes() });

  const otherFirm = await createFirm({ name: 'Other Overlay LLP' });
  const otherOwner = await ownerOf(otherFirm.id);
  const response = await otherOwner.api.post(`${templatesBase(otherFirm.id)}/upload-overlay-finalize`).send({
    objectPath: init.body.objectPath,
    fileName: 'court-form.pdf',
  });

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.body.templateId).toBeUndefined();
});

it('uploads a DOCX to storage before parsing its placeholders', async () => {
  const document = minimalDocx();
  const init = await owner.api.post(`${templatesBase(firm.id)}/upload-docx-init`).send({
    fileName: 'retainer.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: document.length,
  });
  expect(init.status).toBe(200);
  landUpload(init.body.objectPath, { body: document });

  const finalized = await owner.api.post(`${templatesBase(firm.id)}/upload-docx-finalize`).send({
    objectPath: init.body.objectPath,
    fileName: 'retainer.docx',
    name: 'Retainer',
  });

  expect(finalized.status).toBe(201);
  expect(finalized.body.template.type).toBe('docx');
  expect(finalized.body.template.fields).toContain('clientName');
  expect(objects.has(init.body.objectPath)).toBe(false);
});

it('replaces a DOCX from a storage session before parsing its new placeholders', async () => {
  const firstDocument = minimalDocx();
  const created = await owner.api.post(`${templatesBase(firm.id)}/upload-docx-init`).send({
    fileName: 'retainer.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: firstDocument.length,
  });
  landUpload(created.body.objectPath, { body: firstDocument });
  const firstTemplate = await owner.api.post(`${templatesBase(firm.id)}/upload-docx-finalize`).send({
    objectPath: created.body.objectPath, fileName: 'retainer.docx', name: 'Retainer',
  });

  const replacement = minimalDocx('matterNumber');
  const init = await owner.api.post(`${templatesBase(firm.id)}/${firstTemplate.body.templateId}/upload-docx-init`).send({
    fileName: 'revised-retainer.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: replacement.length,
  });
  expect(init.status).toBe(200);
  landUpload(init.body.objectPath, { body: replacement });
  const finalized = await owner.api.post(`${templatesBase(firm.id)}/${firstTemplate.body.templateId}/upload-docx-finalize`).send({
    objectPath: init.body.objectPath, fileName: 'revised-retainer.docx', name: 'Revised Retainer',
  });

  expect(finalized.status).toBe(200);
  expect(finalized.body.template.name).toBe('Revised Retainer');
  expect(finalized.body.template.fields).toContain('matterNumber');
  expect(finalized.body.template.fields).not.toContain('clientName');
  expect(objects.has(init.body.objectPath)).toBe(false);
});

it('copies a placement image from storage into the template tree', async () => {
  const overlayInit = await owner.api.post(`${templatesBase(firm.id)}/upload-overlay-init`).send({
    fileName: 'court-form.pdf', contentType: 'application/pdf', size: minimalPdfBytes().length,
  });
  landUpload(overlayInit.body.objectPath, { body: minimalPdfBytes() });
  const overlay = await owner.api.post(`${templatesBase(firm.id)}/upload-overlay-finalize`).send({
    objectPath: overlayInit.body.objectPath, fileName: 'court-form.pdf', name: 'Court Form',
  });

  const init = await owner.api.post(`${templatesBase(firm.id)}/${overlay.body.templateId}/placement-images-init`).send({
    fileName: 'seal.png', contentType: 'image/png', size: 4,
  });
  expect(init.status).toBe(200);
  landUpload(init.body.objectPath, { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const finalized = await owner.api.post(`${templatesBase(firm.id)}/${overlay.body.templateId}/placement-images-finalize`).send({
    objectPath: init.body.objectPath, fileName: 'seal.png',
  });

  expect(finalized.status).toBe(200);
  expect(finalized.body.imageObjectPath).toMatch(new RegExp(`templates/${overlay.body.templateId}/placement-images/`));
  expect(objects.get(finalized.body.imageObjectPath)?.body).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(objects.has(init.body.objectPath)).toBe(false);
});

it('does not expose the superseded multipart upload endpoints', async () => {
  const templateId = randomUUID();
  const responses = await Promise.all([
    owner.api.post(`${templatesBase(firm.id)}/upload-docx`).send({}),
    owner.api.post(`${templatesBase(firm.id)}/upload-overlay`).send({}),
    owner.api.post(`${templatesBase(firm.id)}/${templateId}/placement-images`).send({}),
    owner.api.put(`${templatesBase(firm.id)}/${templateId}/upload-docx`).send({}),
  ]);

  expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
});
