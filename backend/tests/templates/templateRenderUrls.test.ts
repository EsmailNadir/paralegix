/**
 * What `POST /:templateId/fill` and `GET /:templateId/preview` hand back.
 *
 * Both used to answer with the whole document as the response body. A filled
 * engagement letter and a previewed court form are each resident in a 512 MiB
 * container that serves eighty concurrent requests, and the body duplicates a
 * buffer the transform already produced. Both now answer with a signed URL the
 * browser fetches directly.
 *
 * A signed URL is a bearer credential, so the interesting cases are not "does a
 * URL come back". They are:
 *
 *   NOTHING IS SIGNED BEFORE THE CALLER IS AUTHORIZED. A route that minted
 *   first and checked second answers the same status codes as one that does it
 *   the right way round, so the status alone proves nothing. Every refusal case
 *   here asserts that `getSignedUrl` was never reached.
 *
 *   THE URL NAMES ONE VERSION. A render is replaced by the next render of the
 *   same template by the same person, and the overlay preview signs the firm's
 *   own stored document, which they can re-upload. Without the generation on the
 *   handle, a URL issued for one document keeps serving whatever later lands at
 *   that path.
 *
 *   THE USER SEES THE SAME FILE NAME. The name and the disposition used to come
 *   from response headers the browser no longer receives, so they have to be
 *   carried on the URL instead. A download that starts saving as a uuid is a
 *   broken feature that every status assertion passes.
 *
 * The overlay preview additionally proves a negative: it hands out a link to the
 * stored PDF, so the bytes must never enter this process at all. `bytesRead()`
 * is what makes that testable; a spec that asserted only the URL would pass just
 * as well against a route that downloaded the file and threw it away.
 */
import { randomUUID } from 'crypto';

const { PDFDocument } = require('pdf-lib');

import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  request,
  stranger,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, pathsUnder, putObject, signedUrlCalls } from '../support/inMemoryBucket';
import { installRichBucket, bytesRead, resetBytesRead } from '../files/richBucket';

installRichBucket();

let firm: Firm;
let owner: Actor;
let onePagePdf: Buffer;

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  onePagePdf = Buffer.from(await doc.save());
});

beforeEach(async () => {
  objects.clear();
  resetBytesRead();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

/** An overlay template row whose rendered PDF is actually in the bucket. */
async function overlayTemplate(lawFirmId: string, name = 'Retainer Agreement') {
  const templateId = randomUUID();
  const pdfPath = `lawfirmids/${lawFirmId}/templates/${templateId}/overlay.pdf`;
  putObject(pdfPath, { body: onePagePdf, contentType: 'application/pdf' });

  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, overlay_pdf_object_path,
                            overlay_source_object_path)
     values ($1, $2, $3, 'overlay', $4, $4)`,
    [templateId, lawFirmId, name, pdfPath],
  );

  return { templateId, pdfPath };
}

const fill = (actor: Actor, lawFirmId: string, templateId: string, body: Record<string, unknown> = {}) =>
  actor.api.post(`${T(lawFirmId)}/${templateId}/fill`).send({ values: {}, format: 'pdf', ...body });

const preview = (actor: Actor, lawFirmId: string, templateId: string) =>
  actor.api.get(`${T(lawFirmId)}/${templateId}/preview`);

/** The signed-url call a route made, with the config it was minted under. */
const lastSigned = () => signedUrlCalls[signedUrlCalls.length - 1];

/**
 * The object a url the caller received actually points at.
 *
 * `lastSigned()` is fine where the route signs once, and misleading where it
 * signs more than once: a route that minted the right url and then returned a
 * different one would satisfy an assertion about the last CALL. This reads the
 * answer the caller got.
 */
const signedPathOf = (url: string) =>
  decodeURIComponent(String(url).replace(/^https:\/\/signed\.test\//, '').split('?')[0]);

/** The config one path was signed under. */
const signedCallFor = (path: string) => {
  const call = [...signedUrlCalls].reverse().find((entry) => entry.path === path);
  if (!call) throw new Error(`Nothing signed ${path}`);
  return call;
};

describe('filling a template', () => {
  it('answers with a URL rather than the document', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await fill(owner, firm.id, templateId);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.downloadUrl).toEqual(expect.stringContaining('https://'));
    // The bytes are somewhere the browser can reach, and that somewhere is not
    // this response. Read off the url the CALLER got, so a route that wrote the
    // render and then handed out a link to something else fails here.
    expect(signedPathOf(res.body.downloadUrl))
      .toBe(`lawfirmids/${firm.id}/template-renders/${templateId}/${owner.uid}/fill.pdf`);
    expect(res.body.sizeBytes).toBeGreaterThan(0);
  });

  it('keeps the file name and the attachment disposition the header used to carry', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await fill(owner, firm.id, templateId, { fileName: 'Smith Retainer' });

    // Byte for byte what `Content-Disposition` said before the conversion:
    // `attachment; filename="Smith Retainer.pdf"`. A download that starts
    // saving as a uuid passes every status assertion in this file.
    expect(lastSigned().config.responseDisposition)
      .toBe('attachment; filename="Smith Retainer.pdf"');
    expect(res.body.fileName).toBe('Smith Retainer.pdf');
  });

  it('signs an inline link when the caller is previewing rather than downloading', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await fill(owner, firm.id, templateId, { disposition: 'inline' });

    // Preview opens a tab and points it at this link. An `attachment` link
    // would save the file there instead of showing it, leaving the tab empty.
    expect(lastSigned().config.responseDisposition)
      .toBe('inline; filename="filled-template.pdf"');
    expect(res.body.disposition).toBe('inline');
  });

  it('refuses a disposition it does not know', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await fill(owner, firm.id, templateId, { disposition: 'sideways' });

    // The value reaches a Content-Disposition the storage provider builds, so
    // it is an allow-list rather than a string that is passed along.
    expect(res.status).toBe(400);
  });

  it('sanitizes a hostile file name exactly as the header did', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    await fill(owner, firm.id, templateId, { fileName: 'a"; attachment; filename="b' });

    // The name is not in the fill schema and `validate()` keeps unknown fields,
    // so it is attacker-controlled. Unstripped it splits the disposition the
    // storage provider builds from this value, exactly as it split the header.
    expect(lastSigned().config.responseDisposition)
      .toBe('attachment; filename="a__ attachment_ filename__b.pdf"');
  });

  it('falls back to the same default name as before when none is given', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await fill(owner, firm.id, templateId);

    expect(res.body.fileName).toBe('filled-template.pdf');
  });

  it('pins the URL to the version of the render it just produced', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const first = await fill(owner, firm.id, templateId);
    const pinned = lastSigned();
    const renderPath = pinned.path;

    expect(pinned.generation).toBe(objects.get(renderPath)!.generation);
    expect(first.body.generation).toBe(pinned.generation);

    // Render again. The object at that path is a different version now, so the
    // URL handed out above can no longer serve it: that is what the pin buys.
    await fill(owner, firm.id, templateId);

    expect(objects.get(renderPath)!.generation).not.toBe(first.body.generation);
    expect(first.body.downloadUrl).toContain(`generation=${first.body.generation}`);
  });

  it('writes the render outside the firm storage quota', async () => {
    const { templateId } = await overlayTemplate(firm.id);
    const { isSystemObjectPath } = require('../../src/shared/storage/recordArchive');

    await fill(owner, firm.id, templateId);

    // The firm did not ask for this copy and has no way to delete it, so
    // charging them for it is the same mistake the archives avoid.
    expect(isSystemObjectPath(lastSigned().path)).toBe(true);
  });

  it('signs NOTHING for someone who is not in the firm', async () => {
    // `templates.view` sits in DEFAULT_PERMISSIONS, which a role cannot drop, so
    // "a member without the permission" is not a state this product can reach.
    // The refusal that IS reachable is a caller with no membership at all, and
    // it is the one that matters: it runs before the handler, so nothing may be
    // signed by the time it answers.
    const { templateId } = await overlayTemplate(firm.id);

    const res = await stranger().api.post(`${T(firm.id)}/${templateId}/fill`).send({});

    expect(res.status).toBe(403);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('signs NOTHING for an anonymous caller', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await request().post(`${T(firm.id)}/${templateId}/fill`).send({});

    expect(res.status).toBe(401);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('signs NOTHING for another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { templateId } = await overlayTemplate(firm.id);

    const res = await otherOwner.api.post(`${T(otherFirm.id)}/${templateId}/fill`).send({});

    // A URL minted before the template is resolved under the caller's firm is a
    // read credential for another firm's paperwork, and the 404 hides it.
    expect(res.status).toBe(404);
    expect(signedUrlCalls).toHaveLength(0);
  });
});

describe('previewing a template', () => {
  it('signs the stored document without reading a byte of it', async () => {
    const { templateId, pdfPath } = await overlayTemplate(firm.id);

    const res = await preview(owner, firm.id, templateId);

    expect(res.status).toBe(200);
    expect(res.body.previewUrl).toEqual(expect.stringContaining('https://'));
    // An overlay preview is not a transform: the stored PDF is what the user
    // sees. Downloading it to send it back is the whole cost being removed, and
    // no render is written either, because there is nothing to render.
    expect(bytesRead()).toBe(0);
    expect(signedPathOf(res.body.previewUrl)).toBe(pdfPath);
    expect(pathsUnder(`lawfirmids/${firm.id}/template-renders/`)).toEqual([]);
  });

  it('keeps the inline disposition and the template name', async () => {
    const { templateId } = await overlayTemplate(firm.id, 'Fee Agreement');

    const res = await preview(owner, firm.id, templateId);

    // `inline`, not `attachment`: the preview opens in the viewer. The name is
    // the template's, sanitized the same way the header sanitized it.
    expect(lastSigned().config.responseDisposition)
      .toBe('inline; filename="Fee Agreement.pdf"');
    expect(res.body.fileName).toBe('Fee Agreement.pdf');
  });

  it('pins the URL to the stored version, so a replaced document is not served', async () => {
    const { templateId, pdfPath } = await overlayTemplate(firm.id);

    const res = await preview(owner, firm.id, templateId);
    const issuedFor = res.body.generation;

    expect(lastSigned().generation).toBe(objects.get(pdfPath)!.generation);

    // The firm re-uploads the template's document. The URL above was issued for
    // a decision made about the OLD bytes and must not reach the new ones.
    putObject(pdfPath, { body: onePagePdf, contentType: 'application/pdf' });

    expect(objects.get(pdfPath)!.generation).not.toBe(issuedFor);
    expect(res.body.previewUrl).toContain(`generation=${issuedFor}`);
  });

  it('signs NOTHING for someone who is not in the firm', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await stranger().api.get(`${T(firm.id)}/${templateId}/preview`);

    expect(res.status).toBe(403);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('signs NOTHING for an anonymous caller', async () => {
    const { templateId } = await overlayTemplate(firm.id);

    const res = await request().get(`${T(firm.id)}/${templateId}/preview`);

    expect(res.status).toBe(401);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('signs NOTHING for another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const { templateId } = await overlayTemplate(firm.id);

    const res = await otherOwner.api.get(`${T(otherFirm.id)}/${templateId}/preview`);

    expect(res.status).toBe(404);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('renders a DOCX template and signs the render, not the stored DOCX', async () => {
    const templateId = randomUUID();
    const docxPath = `lawfirmids/${firm.id}/templates/${templateId}.docx`;
    putObject(docxPath, { body: Buffer.from('PK fake docx'), contentType: 'application/msword' });
    await testPool.query(
      `insert into templates (id, law_firm_id, name, type, docx_object_path)
       values ($1, $2, 'Engagement Letter', 'docx', $3)`,
      [templateId, firm.id, docxPath],
    );
    const signaturesService = require('../../src/modules/signatures/signatures.service');
    const converted = Buffer.from('%PDF-1.4 converted preview');
    const convertStub = jest.spyOn(signaturesService, 'convertDocument').mockResolvedValue(converted);

    try {
      const res = await preview(owner, firm.id, templateId);

      expect(res.status).toBe(200);
      // Unlike the overlay branch this IS a transform, so there is a produced
      // document to store. What must not happen is the produced document coming
      // back as the response body, or the link pointing at the DOCX.
      //
      // Asserted against the url the CALLER received, not against the last
      // signing call the route happened to make: a route that signed the render
      // and then handed out a link to something else passes the second and
      // fails the reader.
      const renderPath = signedPathOf(res.body.previewUrl);
      expect(renderPath).toContain('/template-renders/');
      expect(objects.get(renderPath)!.body).toEqual(converted);
      expect(signedCallFor(renderPath).config.responseDisposition)
        .toBe('inline; filename="Engagement Letter.pdf"');
    } finally {
      convertStub.mockRestore();
    }
  });

  it('signs NOTHING when the template has no document', async () => {
    const templateId = randomUUID();
    await testPool.query(
      `insert into templates (id, law_firm_id, name, type) values ($1, $2, 'Empty', 'overlay')`,
      [templateId, firm.id],
    );

    const res = await preview(owner, firm.id, templateId);

    expect(res.status).toBe(400);
    expect(signedUrlCalls).toHaveLength(0);
  });
});

describe('where a render lands', () => {
  it('gives each person their own path, and replaces only their own', async () => {
    const { templateId } = await overlayTemplate(firm.id);
    const colleague = await createFirmMember(firm.id, { isOwner: false });
    const colleagueApi: Actor = { uid: colleague.uid, api: as(tokenFor({ uid: colleague.uid })) };

    await fill(owner, firm.id, templateId, { fileName: 'Mine' });
    const minePath = lastSigned().path;
    const mineGeneration = objects.get(minePath)!.generation;

    await fill(colleagueApi, firm.id, templateId, { fileName: 'Theirs' });

    // One object per person per template, so the set is bounded rather than
    // growing by one per download. Their render must not replace mine: my link
    // is pinned to a version, so overwriting my path would revoke a download I
    // am in the middle of.
    expect(lastSigned().path).not.toBe(minePath);
    expect(objects.get(minePath)!.generation).toBe(mineGeneration);
  });
});

describe('discarding renders', () => {
  it('removes a template renders when the template is deleted', async () => {
    const { templateId } = await overlayTemplate(firm.id);
    await fill(owner, firm.id, templateId);
    const renderPath = lastSigned().path;
    expect(objects.has(renderPath)).toBe(true);

    await owner.api.delete(`${T(firm.id)}/${templateId}`);

    // A render outlives nothing. Left behind it is storage the firm keeps
    // paying for, under a template row that no longer exists to explain it.
    expect(objects.has(renderPath)).toBe(false);
  });

  it('ages out a render the sweep finds past its lifetime', async () => {
    const { templateId } = await overlayTemplate(firm.id);
    await fill(owner, firm.id, templateId);
    const renderPath = lastSigned().path;

    const templatesService = require('../../src/modules/templates/templates.service');

    // Still fresh: a sweep that took this would cut a download already in
    // flight under a URL that has not expired.
    expect(await templatesService.sweepExpiredRenders()).toBe(0);
    expect(objects.has(renderPath)).toBe(true);

    objects.get(renderPath)!.created = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    expect(await templatesService.sweepExpiredRenders()).toBe(1);
    expect(objects.has(renderPath)).toBe(false);
  });
});
