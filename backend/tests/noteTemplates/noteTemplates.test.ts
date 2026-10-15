/**
 * Firm-custom note templates: the saved drafts the note composer offers on top
 * of its built-in list.
 *
 * Two endpoints, and both of them matter more than their size suggests. The
 * stored `content_html` is rendered into every viewer's browser when the
 * template is applied, so this route is a stored-XSS surface: the editor
 * sanitises on the way in, but the editor is not the boundary, and anything that
 * reaches the API directly has to be sanitised here. And the list is firm-wide
 * rather than per-author, so a scope that leaked would put one firm's drafted
 * language in another firm's composer.
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
let otherFirm: Firm;
let otherOwner: Actor;

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/note-templates`;

async function seedNoteTemplate(
  lawFirmId: string,
  options: { label?: string; noteType?: string; subject?: string; contentHtml?: string } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into note_templates (id, law_firm_id, label, note_type, subject, content_html)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      lawFirmId,
      options.label ?? `Template ${id.slice(0, 8)}`,
      options.noteType ?? 'general',
      options.subject ?? '',
      options.contentHtml ?? '',
    ],
  );
  return { id };
}

const templateRows = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select label, note_type, subject, content_html, created_by
       from note_templates where law_firm_id = $1 order by label`,
    [lawFirmId],
  );
  return rows;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
});

describe('creating a note template', () => {
  it('writes it into the caller firm and nowhere else', async () => {
    const res = await owner.api.post(T(firm.id)).send({
      label: 'Client Call Notes',
      noteType: 'phone-call',
      subject: 'Call with client',
      contentHtml: '<p>Discussed: </p>',
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Note template created successfully');
    expect(res.body.noteTemplate).toMatchObject({
      label: 'Client Call Notes',
      noteType: 'phone-call',
      subject: 'Call with client',
      contentHtml: '<p>Discussed: </p>',
    });
    expect(await templateRows(firm.id)).toEqual([
      expect.objectContaining({
        label: 'Client Call Notes',
        note_type: 'phone-call',
        subject: 'Call with client',
        content_html: '<p>Discussed: </p>',
      }),
    ]);
    expect(await templateRows(otherFirm.id)).toEqual([]);
  });

  it('records the author', async () => {
    await owner.api.post(T(firm.id)).send({ label: 'Client Call Notes' });

    // `created_by` is what the settings list shows beside a shared template, so
    // a firm can tell who added the language it is about to send a client.
    expect((await templateRows(firm.id))[0].created_by).toBe(owner.uid);
  });

  it('defaults the note type, subject and body when only a label is sent', async () => {
    const res = await owner.api.post(T(firm.id)).send({ label: 'Bare Template' });

    // All three columns are NOT NULL with defaults, and the service supplies
    // them rather than relying on the column defaults. Passing undefined through
    // would be a not-null violation and a 500 on the ordinary "save this draft"
    // action.
    expect(res.status).toBe(201);
    expect(await templateRows(firm.id)).toEqual([
      expect.objectContaining({ note_type: 'general', subject: '', content_html: '' }),
    ]);
  });

  it('trims the label', async () => {
    const res = await owner.api.post(T(firm.id)).send({ label: '  Client Call Notes  ' });

    expect(res.body.noteTemplate.label).toBe('Client Call Notes');
  });

  it('strips a script tag out of the stored body', async () => {
    const res = await owner.api.post(T(firm.id)).send({
      label: 'Poisoned Template',
      contentHtml: '<p>Hello</p><script>alert(1)</script>',
    });

    // The stored value IS the boundary: the composer sanitises, but a client can
    // reach this route directly, and the template body is rendered into every
    // colleague's browser when the template is applied. Stored XSS, firm-wide.
    expect(res.status).toBe(201);
    const stored = (await templateRows(firm.id))[0].content_html;
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('alert(1)');
    expect(stored).toContain('<p>Hello</p>');
  });

  it('strips an inline event handler off an allowed tag', async () => {
    await owner.api.post(T(firm.id)).send({
      label: 'Poisoned Template',
      contentHtml: '<img src="https://example.test/x.png" onerror="alert(1)">',
    });

    // The image survives because templates legitimately carry logos; the handler
    // must not. An allow-list of TAGS alone would let this through.
    const stored = (await templateRows(firm.id))[0].content_html;
    expect(stored).toContain('img');
    expect(stored).not.toContain('onerror');
  });

  it('strips a javascript: link', async () => {
    await owner.api.post(T(firm.id)).send({
      label: 'Poisoned Template',
      contentHtml: '<a href="javascript:alert(1)">click</a>',
    });

    expect((await templateRows(firm.id))[0].content_html).not.toContain('javascript:');
  });

  it('refuses an empty label and writes nothing', async () => {
    const res = await owner.api.post(T(firm.id)).send({ label: '' });

    expect(res.status).toBe(400);
    expect(await templateRows(firm.id)).toEqual([]);
  });

  it('refuses a body past the length ceiling and writes nothing', async () => {
    const res = await owner.api.post(T(firm.id)).send({
      label: 'Huge Template',
      contentHtml: 'x'.repeat(50_001),
    });

    // The bound is what stops one template from being an unbounded write. Every
    // note composer load reads the whole list, so an unbounded body is a
    // firm-wide slowdown as well as a storage problem.
    expect(res.status).toBe(400);
    expect(await templateRows(firm.id)).toEqual([]);
  });

  it('CHARACTERISATION: accepts a second template with the same label', async () => {
    await owner.api.post(T(firm.id)).send({ label: 'Client Call Notes' });

    const res = await owner.api.post(T(firm.id)).send({ label: 'Client Call Notes' });

    // Unlike note TYPES, which reuse an existing row on a matching label, note
    // templates have no de-duplication and no unique index, so the composer
    // menu can show the same name twice with different bodies behind it.
    // Recorded so adding de-duplication is a deliberate change.
    expect(res.status).toBe(201);
    expect(await templateRows(firm.id)).toHaveLength(2);
  });

  it('refuses a member with an empty role and writes nothing', async () => {
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.post(T(firm.id)).send({ label: 'Client Call Notes' });

    // The baseline carries `noteTemplates.view`, not `noteTemplates.manage`: a
    // member uses the firm's saved language without being able to change what
    // the whole firm sends.
    expect(res.status).toBe(403);
    expect(await templateRows(firm.id)).toEqual([]);
  });

  it('refuses a member of another firm creating under this firm', async () => {
    const res = await otherOwner.api.post(T(firm.id)).send({ label: 'Client Call Notes' });

    expect(res.status).toBe(403);
    expect(await templateRows(firm.id)).toEqual([]);
  });
});

describe('listing note templates', () => {
  it('lists the firm templates ordered by label', async () => {
    await seedNoteTemplate(firm.id, { label: 'Zebra Template' });
    await seedNoteTemplate(firm.id, { label: 'Apple Template' });

    const res = await owner.api.get(T(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.noteTemplates.map((row: any) => row.label))
      .toEqual(['Apple Template', 'Zebra Template']);
  });

  it('returns the stored body so the composer can apply it', async () => {
    await seedNoteTemplate(firm.id, {
      label: 'Client Call Notes',
      subject: 'Call with client',
      contentHtml: '<p>Discussed: </p>',
    });

    const res = await owner.api.get(T(firm.id));

    // The list IS the delivery mechanism: there is no per-template read route,
    // so a list that returned labels alone would leave the composer with nothing
    // to insert.
    expect(res.body.noteTemplates[0]).toMatchObject({
      subject: 'Call with client',
      contentHtml: '<p>Discussed: </p>',
    });
  });

  it('does NOT list another firm templates', async () => {
    await seedNoteTemplate(otherFirm.id, {
      label: 'Confidential Template',
      contentHtml: '<p>Their privileged language</p>',
    });
    await seedNoteTemplate(firm.id, { label: 'Our Own Template' });

    const res = await owner.api.get(T(firm.id));

    expect(res.body.noteTemplates.map((row: any) => row.label)).toEqual(['Our Own Template']);
    expect(JSON.stringify(res.body)).not.toContain('privileged language');
  });

  it('CHARACTERISATION: a member with an empty role can still read the list', async () => {
    await seedNoteTemplate(firm.id, { label: 'Our Own Template' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(T(firm.id));

    // `noteTemplates.view` is in DEFAULT_PERMISSIONS. The templates are the
    // firm's own boilerplate, not confidential from the firm, and withholding
    // them left the composer's template menu permanently empty.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Our Own Template');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedNoteTemplate(firm.id, { label: 'Confidential Template' });

    const res = await otherOwner.api.get(T(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Template');
  });
});
