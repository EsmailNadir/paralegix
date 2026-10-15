/**
 * The Word-first upload pipeline through its real routes: open a direct upload,
 * scan it for blanks (detect), store the reviewed result (commit), the editor's
 * no-review import (upload-docx) and Re-upload (replace-source).
 *
 * The scan reads the firm's own records to recognise values, and the
 * leftover-client-text guard reads every client of the firm. Both are the
 * places one firm's client names could surface in another firm's template, so
 * each has a cross-firm case.
 *
 *   npx jest tests/wordTemplates/wordTemplatesUpload.test.ts
 */
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  WT,
  buildDocx,
  docxOf,
  docxText,
  para,
  pdfForm,
  pdfFieldValues,
  run,
  stored,
  upload,
  wordTemplateCount,
  wordTemplateRow,
} from './helpers';

installInMemoryBucket();

let firmA: Firm;
let firmB: Firm;
let ownerA: Actor;
let ownerB: Actor;

beforeEach(async () => {
  objects.clear();
  firmA = await createFirm();
  firmB = await createFirm();
  ownerA = await ownerOf(firmA.id);
  ownerB = await ownerOf(firmB.id);
});

const detect = async (actor: Actor, lawFirmId: string, body: Buffer, fileName = 'agreement.docx') => {
  const objectPath = await upload(actor, lawFirmId, body, fileName);
  const res = await actor.api.post(`${WT(lawFirmId)}/detect`).send({ objectPath, fileName });
  return { res, objectPath };
};

const commit = (actor: Actor, lawFirmId: string, body: Record<string, unknown>) =>
  actor.api.post(`${WT(lawFirmId)}/commit`).send(body);

function tagsByLiteral(proposals: any[]): Record<string, string> {
  return Object.fromEntries(proposals.flatMap((p) => (p.kind === 'literal' ? [[p.literal, p.suggestedTag]] : [])));
}

describe('opening an upload', () => {
  it('opens a direct upload under the caller\'s own firm prefix', async () => {
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-init`).send({
      fileName: 'agreement.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100, purpose: 'source',
    });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toEqual(expect.any(String));
    expect(res.body.objectPath).toMatch(new RegExp(`^word-template-uploads/${firmA.id}/${ownerA.uid}/`));
  });

  it('refuses a file that is neither a .docx nor a .pdf', async () => {
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-init`).send({
      fileName: 'notes.txt', contentType: 'text/plain', size: 10, purpose: 'source',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only .docx and .pdf files are accepted.');
  });

  it('refuses a file over 50 MB before any byte is sent', async () => {
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-init`).send({
      fileName: 'big.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 50 * 1024 * 1024 + 1, purpose: 'source',
    });
    expect(res.status).toBe(413);
  });

  it('refuses a member without templates.manage', async () => {
    const reader = await memberWith(firmA.id, []);
    const res = await reader.api.post(`${WT(firmA.id)}/upload-init`).send({
      fileName: 'a.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10, purpose: 'source',
    });
    expect(res.status).toBe(403);
  });
});

describe('detect: scanning a .docx', () => {
  it('proposes highlighted spans and value shapes, and stores nothing', async () => {
    const body = buildDocx(
      para(run('Dear '), run('Corwin Thistlewood', 'yellow'), run(','))
      + para(run('Your payment of $2,500.00 is due on March 1, 2026.')),
    );
    const { res, objectPath } = await detect(ownerA, firmA.id, body);

    expect(res.status).toBe(200);
    const literals = res.body.proposals.filter((p: any) => p.kind === 'literal').map((p: any) => p.literal);
    expect(literals).toEqual(expect.arrayContaining(['Corwin Thistlewood', '$2,500.00', 'March 1, 2026']));
    expect(await wordTemplateCount(firmA.id)).toBe(0);
    // The upload stays for the commit that follows.
    expect(objects.has(objectPath)).toBe(true);
  });

  it('names fee terms after their labels so the agreement auto-fills', async () => {
    const { res } = await detect(ownerA, firmA.id, docxOf(
      'The client agrees to pay a flat fee of $2,500.00 and an initial payment of $500.00 due on March 1, 2026.',
    ));
    expect(tagsByLiteral(res.body.proposals)).toEqual({
      '$2,500.00': 'flat_fee_amount',
      '$500.00': 'initial_payment_amount',
      'March 1, 2026': 'initial_payment_date',
    });
  });

  it('keeps a letterhead phone and a second flat fee generic', async () => {
    const { res } = await detect(ownerA, firmA.id, docxOf(
      'Phone: (614) 555-0100',
      'The client agrees to pay a flat fee of $2,500.00.',
      'A flat fee of $3,000.00 applies on appeal.',
    ));
    expect(tagsByLiteral(res.body.proposals)).toEqual({
      '(614) 555-0100': 'phone_1',
      '$2,500.00': 'flat_fee_amount',
      '$3,000.00': 'amount_1',
    });
  });

  it('recognises the firm\'s own letterhead as firm fields', async () => {
    await testPool.query(
      "update law_firms set name = 'Wayfield Defense Group', email = 'office@wayfield.test', phone = '(614) 555-0182' where id = $1",
      [firmA.id],
    );
    const { res } = await detect(ownerA, firmA.id, docxOf(
      'Wayfield Defense Group',
      'office@wayfield.test | (614) 555-0182',
    ));
    expect(tagsByLiteral(res.body.proposals)).toMatchObject({
      'Wayfield Defense Group': 'firm_name',
      'office@wayfield.test': 'firm_email',
      '(614) 555-0182': 'firm_phone',
    });
  });

  it('recognises a client of the caller\'s firm, and never one of another firm', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    await createPersonClient(firmB.id, { name: 'Bartholomew Okonkwo-Lindqvist' });

    const { res } = await detect(ownerA, firmA.id, docxOf(
      'Client: Marisol Quintanilla-Reyes',
      'Witness: Bartholomew Okonkwo-Lindqvist',
    ));

    const tags = tagsByLiteral(res.body.proposals);
    expect(tags['Marisol Quintanilla-Reyes']).toBe('client_name');
    expect(Object.entries(tags).filter(([, tag]) => tag === 'client_name').map(([literal]) => literal))
      .toEqual(['Marisol Quintanilla-Reyes']);
  });

  it('refuses a file that is not a Word document', async () => {
    const { res } = await detect(ownerA, firmA.id, Buffer.from('not a zip'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Not a valid Word document.');
  });

  it('refuses an upload opened by another firm', async () => {
    const objectPath = await upload(ownerB, firmB.id, docxOf('secret'), 'a.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/detect`).send({ objectPath, fileName: 'a.docx' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That upload does not belong to this template.');
  });

  it('refuses a member without templates.manage', async () => {
    const reader = await memberWith(firmA.id, []);
    const res = await reader.api.post(`${WT(firmA.id)}/detect`).send({ objectPath: 'x', fileName: 'a.docx' });
    expect(res.status).toBe(403);
  });
});

describe('detect: scanning a fillable PDF', () => {
  it('proposes a name per form field', async () => {
    const { res } = await detect(ownerA, firmA.id, await pdfForm([{ name: 'Plaintiff Full Name' }, { name: 'Case Number' }]), 'form.pdf');
    expect(res.status).toBe(200);
    expect(res.body.proposals).toEqual([
      expect.objectContaining({ kind: 'pdfField', pdfName: 'Plaintiff Full Name' }),
      expect.objectContaining({ kind: 'pdfField', pdfName: 'Case Number', suggestedTag: 'case_number' }),
    ]);
  });

  it('refuses a PDF with no form fields', async () => {
    const { res } = await detect(ownerA, firmA.id, await pdfForm([]), 'flat.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'This PDF has no fillable form fields, so there is nothing to name. Rebuild it as a Word document and upload that instead.',
    );
  });
});

describe('commit: storing a reviewed .docx', () => {
  it('brackets the accepted literals and stores the rewritten file', async () => {
    const body = docxOf('Pay $2,500.00 by March 1, 2026.');
    const { objectPath } = await detect(ownerA, firmA.id, body);

    const res = await commit(ownerA, firmA.id, {
      objectPath,
      fileName: 'Fee Letter.docx',
      name: 'Fee Letter',
      edits: [
        { kind: 'literal', find: '$2,500.00', tag: 'flat_fee_amount' },
        { kind: 'literal', find: 'March 1, 2026', tag: 'initial_payment_date' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Template created successfully');
    const row = await wordTemplateRow(res.body.templateId);
    expect(row).toMatchObject({
      law_firm_id: firmA.id,
      type: 'docx',
      name: 'Fee Letter',
      original_file_name: 'Fee Letter.docx',
      fields: ['flat_fee_amount', 'initial_payment_date'],
      html_object_path: null,
      created_by: ownerA.uid,
    });
    expect(row.source_object_path).toMatch(new RegExp(`^lawfirmids/${firmA.id}/word-templates/${row.id}`));
    expect(docxText(stored(row.source_object_path)!)).toBe('Pay {flat_fee_amount} by {initial_payment_date}.');
    expect(objects.has(objectPath)).toBe(false);
  });

  it('stores the file unchanged with no edits, named after the file', async () => {
    const body = docxOf('A plain letter.');
    const objectPath = await upload(ownerA, firmA.id, body, 'Plain Letter.docx');
    const res = await commit(ownerA, firmA.id, { objectPath, fileName: 'Plain Letter.docx', edits: [] });
    expect(res.status).toBe(201);
    const row = await wordTemplateRow(res.body.templateId);
    expect(row.name).toBe('Plain Letter');
    expect(Buffer.compare(stored(row.source_object_path)!, body)).toBe(0);
  });

  it('refuses a literal that is not in the document, storing nothing', async () => {
    const objectPath = await upload(ownerA, firmA.id, docxOf('Pay $2,500.00.'), 'a.docx');
    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'a.docx', name: 'A', edits: [{ kind: 'literal', find: '$9.99', tag: 'amount_1' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Couldn\'t bracket "$9.99": the text wasn\'t found as a standalone value, or it sat inside a form field you also replaced. Edit the document or deselect it.',
    );
    expect(await wordTemplateCount(firmA.id)).toBe(0);
  });

  it('refuses an invalid field name', async () => {
    const objectPath = await upload(ownerA, firmA.id, docxOf('Pay $2,500.00.'), 'a.docx');
    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'a.docx', name: 'A', edits: [{ kind: 'literal', find: '$2,500.00', tag: 'bad name' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid field name: "bad name".');
  });

  it('refuses the same text bracketed twice', async () => {
    const objectPath = await upload(ownerA, firmA.id, docxOf('Pay $2,500.00.'), 'a.docx');
    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'a.docx', name: 'A',
      edits: [{ kind: 'literal', find: '$2,500.00', tag: 'a' }, { kind: 'literal', find: '$2,500.00', tag: 'b' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The same text was bracketed twice: "$2,500.00".');
  });

  it('turns a repeating schedule into a loop', async () => {
    const lines = ['Schedule:', 'March 1, 2026 $500.00', 'April 1, 2026 $500.00', 'May 1, 2026 $500.00'];
    const { res: scan, objectPath } = await detect(ownerA, firmA.id, docxOf(...lines));
    const repeater = scan.body.proposals.find((p: any) => p.kind === 'repeater');
    expect(repeater).toBeDefined();

    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'Plan.docx', name: 'Plan',
      edits: [{ kind: 'repeater', index: repeater.index, name: 'payments', fields: ['payment_date', 'payment_amount'] }],
    });

    expect(res.status).toBe(201);
    const row = await wordTemplateRow(res.body.templateId);
    expect(row.repeaters).toEqual([{ name: 'payments', fields: ['payment_date', 'payment_amount'] }]);
    expect(row.fields).toEqual(['payments.payment_date', 'payments.payment_amount']);
  });
});

describe('the leftover client-text guard', () => {
  it('refuses to store a firm client\'s name unless it is acknowledged', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    const objectPath = await upload(ownerA, firmA.id, docxOf('Dear Marisol Quintanilla-Reyes,'), 'Letter.docx');

    const refused = await commit(ownerA, firmA.id, { objectPath, fileName: 'Letter.docx', name: 'Letter', edits: [] });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TEMPLATE_CLIENT_TEXT');
    expect(refused.body.error).toBe('Client details would stay in this template. Review them before saving.');
    expect(refused.body.details.clientTextRefused).toBe(true);
    expect(refused.body.details.leftovers).toEqual([
      expect.objectContaining({ literal: 'Marisol Quintanilla-Reyes', canonicalId: 'client_name', parts: ['body'] }),
    ]);
    expect(await wordTemplateCount(firmA.id)).toBe(0);
    expect(objects.has(objectPath)).toBe(true);

    const saved = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'Letter.docx', name: 'Letter', edits: [],
      acknowledgedLeftovers: ['Marisol Quintanilla-Reyes'],
    });
    expect(saved.status).toBe(201);
  });

  it('passes once the name is bracketed out', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    const objectPath = await upload(ownerA, firmA.id, docxOf('Dear Marisol Quintanilla-Reyes,'), 'Letter.docx');
    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'Letter.docx', name: 'Letter',
      edits: [{ kind: 'literal', find: 'Marisol Quintanilla-Reyes', tag: 'client_name' }],
    });
    expect(res.status).toBe(201);
  });

  it('finds a client name in a header part', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    const body = buildDocx(para(run('Body text.')), {
      'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Re: Marisol Quintanilla-Reyes</w:t></w:r></w:p></w:hdr>',
    });
    const objectPath = await upload(ownerA, firmA.id, body, 'Letter.docx');
    const res = await commit(ownerA, firmA.id, { objectPath, fileName: 'Letter.docx', name: 'Letter', edits: [] });
    expect(res.status).toBe(409);
    expect(res.body.details.leftovers[0].parts).toEqual(['header']);
  });

  it('does not hold firm A\'s template to firm B\'s clients', async () => {
    await createPersonClient(firmB.id, { name: 'Bartholomew Okonkwo-Lindqvist' });
    const objectPath = await upload(ownerA, firmA.id, docxOf('Witness: Bartholomew Okonkwo-Lindqvist'), 'Letter.docx');
    const res = await commit(ownerA, firmA.id, { objectPath, fileName: 'Letter.docx', name: 'Letter', edits: [] });
    expect(res.status).toBe(201);
  });

  it('checks a fillable PDF\'s stored field values too', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    const objectPath = await upload(ownerA, firmA.id, await pdfForm([{ name: 'Plaintiff', value: 'Marisol Quintanilla-Reyes' }]), 'Form.pdf');
    const res = await commit(ownerA, firmA.id, { objectPath, fileName: 'Form.pdf', name: 'Form', edits: [] });
    expect(res.status).toBe(409);
    expect(res.body.details.leftovers[0].literal).toBe('Marisol Quintanilla-Reyes');
  });
});

describe('same-name uploads', () => {
  async function commitPlain(actor: Actor, lawFirmId: string, name: string, body = docxOf('A letter.'), extra: Record<string, unknown> = {}) {
    const objectPath = await upload(actor, lawFirmId, body, `${name}.docx`);
    return commit(actor, lawFirmId, { objectPath, fileName: `${name}.docx`, name, edits: [], ...extra });
  }

  it('offers Replace / Save as a copy for a name already taken, ignoring case', async () => {
    const first = await commitPlain(ownerA, firmA.id, 'Retainer Letter');
    expect(first.status).toBe(201);

    const second = await commitPlain(ownerA, firmA.id, 'retainer letter');

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TEMPLATE_DUPLICATE');
    expect(second.body.error).toBe('A template named “retainer letter” already exists.');
    expect(second.body.details.duplicate).toEqual({ id: first.body.templateId, name: 'retainer letter' });
    expect(await wordTemplateCount(firmA.id)).toBe(1);
  });

  it('saves a copy under the first free copy name', async () => {
    await commitPlain(ownerA, firmA.id, 'Retainer Letter');
    const copy = await commitPlain(ownerA, firmA.id, 'Retainer Letter', docxOf('B'), { duplicateStrategy: 'copy' });
    expect(copy.status).toBe(201);
    expect((await wordTemplateRow(copy.body.templateId)).name).toBe('Retainer Letter (copy)');
    const copy2 = await commitPlain(ownerA, firmA.id, 'Retainer Letter', docxOf('C'), { duplicateStrategy: 'copy' });
    expect((await wordTemplateRow(copy2.body.templateId)).name).toBe('Retainer Letter (copy 2)');
  });

  it('replaces the existing template\'s source, deleting the old file', async () => {
    const first = await commitPlain(ownerA, firmA.id, 'Retainer Letter', docxOf('Old {a}'));
    const oldPath = (await wordTemplateRow(first.body.templateId)).source_object_path;

    const replaced = await commitPlain(ownerA, firmA.id, 'Retainer Letter', docxOf('New {b}'), { duplicateStrategy: 'replace' });

    expect(replaced.status).toBe(200);
    expect(replaced.body.templateId).toBe(first.body.templateId);
    const row = await wordTemplateRow(first.body.templateId);
    expect(row.fields).toEqual(['b']);
    expect(row.source_object_path).not.toBe(oldPath);
    expect(docxText(stored(row.source_object_path)!)).toBe('New {b}');
    expect(objects.has(oldPath)).toBe(false);
    expect(await wordTemplateCount(firmA.id)).toBe(1);
  });

  it('does not count another firm\'s template of the same name', async () => {
    await commitPlain(ownerB, firmB.id, 'Retainer Letter');
    const res = await commitPlain(ownerA, firmA.id, 'Retainer Letter');
    expect(res.status).toBe(201);
  });

  it('does not count an html template of the same name', async () => {
    await ownerA.api.post(WT(firmA.id)).send({ name: 'Retainer Letter', html: '<p>x</p>' }).expect(201);
    const res = await commitPlain(ownerA, firmA.id, 'Retainer Letter');
    expect(res.status).toBe(201);
  });

  it('applies the same check to the editor\'s no-review import', async () => {
    await commitPlain(ownerA, firmA.id, 'Retainer Letter');
    const objectPath = await upload(ownerA, firmA.id, docxOf('x'), 'Retainer Letter.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-docx`).send({ objectPath, fileName: 'Retainer Letter.docx' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEMPLATE_DUPLICATE');
  });
});

describe('commit: storing a fillable PDF', () => {
  it('renames the accepted fields inside the stored PDF', async () => {
    const { objectPath } = await detect(ownerA, firmA.id, await pdfForm([{ name: 'Plaintiff Full Name' }, { name: 'Case No' }]), 'Complaint.pdf');

    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'Complaint.pdf', name: 'Complaint',
      edits: [{ kind: 'pdfField', pdfName: 'Plaintiff Full Name', tag: 'client_name' }],
    });

    expect(res.status).toBe(201);
    const row = await wordTemplateRow(res.body.templateId);
    expect(row).toMatchObject({ type: 'pdf-form', fields: ['client_name', 'Case No'], repeaters: [] });
    expect(Object.keys(await pdfFieldValues(stored(row.source_object_path)!))).toEqual(['client_name', 'Case No']);
  });

  it('refuses two fields given one name', async () => {
    const objectPath = await upload(ownerA, firmA.id, await pdfForm([{ name: 'A' }, { name: 'B' }]), 'f.pdf');
    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'f.pdf', name: 'F',
      edits: [{ kind: 'pdfField', pdfName: 'A', tag: 'x' }, { kind: 'pdfField', pdfName: 'B', tag: 'x' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Two fields would both be named "x". Give each its own name.');
  });

  it('refuses a field the PDF does not have', async () => {
    const objectPath = await upload(ownerA, firmA.id, await pdfForm([{ name: 'A' }]), 'f.pdf');
    const res = await commit(ownerA, firmA.id, {
      objectPath, fileName: 'f.pdf', name: 'F', edits: [{ kind: 'pdfField', pdfName: 'Gone', tag: 'x' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This PDF changed since it was scanned: upload it again.');
  });

  it('checks for a same-named PDF form, offering a copy name among PDF forms', async () => {
    const first = await upload(ownerA, firmA.id, await pdfForm([{ name: 'A' }]), 'Form.pdf');
    await commit(ownerA, firmA.id, { objectPath: first, fileName: 'Form.pdf', name: 'Form', edits: [] }).expect(201);
    // A Word template already holds "Form (copy)": the PDF copy must not skip past it.
    const word = await upload(ownerA, firmA.id, docxOf('w'), 'Form (copy).docx');
    await commit(ownerA, firmA.id, { objectPath: word, fileName: 'Form (copy).docx', name: 'Form (copy)', edits: [] }).expect(201);

    const second = await upload(ownerA, firmA.id, await pdfForm([{ name: 'A' }]), 'Form.pdf');
    const dup = await commit(ownerA, firmA.id, { objectPath: second, fileName: 'Form.pdf', name: 'Form', edits: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('A PDF template named "Form" already exists.');

    const copy = await commit(ownerA, firmA.id, { objectPath: second, fileName: 'Form.pdf', name: 'Form', edits: [], duplicateStrategy: 'copy' });
    expect(copy.status).toBe(201);
    expect((await wordTemplateRow(copy.body.templateId)).name).toBe('Form (copy)');
  });
});

describe('upload-docx: the editor\'s import without review', () => {
  it('stores the file as-is with its fields', async () => {
    const body = docxOf('Dear {client_name}');
    const objectPath = await upload(ownerA, firmA.id, body, 'Imported.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-docx`).send({ objectPath, fileName: 'Imported.docx' });
    expect(res.status).toBe(201);
    const row = await wordTemplateRow(res.body.templateId);
    expect(row).toMatchObject({ name: 'Imported', type: 'docx', fields: ['client_name'] });
    expect(Buffer.compare(stored(row.source_object_path)!, body)).toBe(0);
  });

  it('runs the leftover client-text guard', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    const objectPath = await upload(ownerA, firmA.id, docxOf('Dear Marisol Quintanilla-Reyes'), 'Imported.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-docx`).send({ objectPath, fileName: 'Imported.docx' });
    expect(res.status).toBe(409);
    expect(res.body.details.clientTextRefused).toBe(true);
  });

  it('refuses a .docx with a malformed tag', async () => {
    const objectPath = await upload(ownerA, firmA.id, docxOf('Dear {client_name'), 'Broken.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-docx`).send({ objectPath, fileName: 'Broken.docx' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Failed to read DOCX: /);
    expect(await wordTemplateCount(firmA.id)).toBe(0);
  });
});

describe('replace-source: Re-upload', () => {
  async function docxTemplate(body = docxOf('Old {a}')) {
    const objectPath = await upload(ownerA, firmA.id, body, 'Letter.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-docx`).send({ objectPath, fileName: 'Letter.docx' });
    return res.body.templateId as string;
  }

  it('writes a new versioned file, repoints the row, then deletes the old file', async () => {
    const id = await docxTemplate();
    const oldPath = (await wordTemplateRow(id)).source_object_path;
    const objectPath = await upload(ownerA, firmA.id, docxOf('New {b}'), 'Letter v2.docx');

    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/replace-source`).send({ objectPath, fileName: 'Letter v2.docx' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Template updated successfully');
    const row = await wordTemplateRow(id);
    expect(row).toMatchObject({ fields: ['b'], original_file_name: 'Letter v2.docx' });
    expect(row.source_object_path).not.toBe(oldPath);
    expect(row.source_object_path).toMatch(new RegExp(`^lawfirmids/${firmA.id}/word-templates/${id}-`));
    expect(docxText(stored(row.source_object_path)!)).toBe('New {b}');
    expect(objects.has(oldPath)).toBe(false);
    expect(objects.has(objectPath)).toBe(false);
  });

  it('keeps the old file when the new one is refused', async () => {
    await createPersonClient(firmA.id, { name: 'Marisol Quintanilla-Reyes' });
    const id = await docxTemplate();
    const before = await wordTemplateRow(id);
    const objectPath = await upload(ownerA, firmA.id, docxOf('Dear Marisol Quintanilla-Reyes'), 'v2.docx');

    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/replace-source`).send({ objectPath, fileName: 'v2.docx' });

    expect(res.status).toBe(409);
    const after = await wordTemplateRow(id);
    expect(after.source_object_path).toBe(before.source_object_path);
    expect(stored(before.source_object_path)).toBeDefined();
  });

  it('refuses to re-upload an html template', async () => {
    const created = await ownerA.api.post(WT(firmA.id)).send({ name: 'H', html: '<p>x</p>' });
    const objectPath = await upload(ownerA, firmA.id, docxOf('x'), 'x.docx');
    const res = await ownerA.api.post(`${WT(firmA.id)}/${created.body.templateId}/replace-source`).send({ objectPath, fileName: 'x.docx' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only DOCX templates can be re-uploaded.');
  });

  it('replaces a fillable PDF\'s file with another PDF', async () => {
    const first = await upload(ownerA, firmA.id, await pdfForm([{ name: 'a' }]), 'Form.pdf');
    const created = await commit(ownerA, firmA.id, { objectPath: first, fileName: 'Form.pdf', name: 'Form', edits: [] });
    const objectPath = await upload(ownerA, firmA.id, await pdfForm([{ name: 'b' }, { name: 'c' }]), 'Form v2.pdf');

    const res = await ownerA.api.post(`${WT(firmA.id)}/${created.body.templateId}/replace-source`).send({ objectPath, fileName: 'Form v2.pdf' });

    expect(res.status).toBe(200);
    expect((await wordTemplateRow(created.body.templateId)).fields).toEqual(['b', 'c']);
  });

  it('answers another firm with not found and leaves the template alone', async () => {
    const id = await docxTemplate();
    const before = await wordTemplateRow(id);
    const objectPath = await upload(ownerB, firmB.id, docxOf('Hijack {x}'), 'x.docx');
    const res = await ownerB.api.post(`${WT(firmB.id)}/${id}/replace-source`).send({ objectPath, fileName: 'x.docx' });
    expect(res.status).toBe(404);
    expect((await wordTemplateRow(id)).source_object_path).toBe(before.source_object_path);
  });
});
