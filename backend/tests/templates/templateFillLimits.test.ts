/**
 * Bounding what filling a template pulls into the process.
 *
 * Filling is a genuine transform: docxtemplater and pdf-lib both need the whole
 * file, so the cost cannot be removed. What it can be is bounded, and bounded
 * BEFORE the read rather than after it. Checking a buffer's length is a check
 * that has already spent the memory it was meant to protect.
 *
 * The shape that actually bites is the placement images. They used to be
 * fetched in PARALLEL with no cap at all, so the peak was the number of
 * placements times whatever each image happened to be. A template with twenty
 * ten-megabyte images is 200 MB inside a 512 MiB container, and it does not
 * error: the container restarts and the request disappears.
 */
import { randomUUID } from 'crypto';
const { PDFDocument } = require('pdf-lib');

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

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

/** Object path to stored bytes. Reset per test. */
let objects: Map<string, Buffer>;
/** Every path `download()` was called for, in order. */
let downloaded: string[];
/** How many downloads were in flight at once, at their peak. */
let peakConcurrentDownloads = 0;
let inFlight = 0;
/**
 * Runs inside `download()` after the path is recorded, so a test can hold a
 * download open (or fail it) and see which fills got as far as reading.
 */
let downloadHook: ((objectPath: string) => Promise<void>) | null = null;

/**
 * Object versions, minted per write the way GCS does.
 *
 * The fill route pins the URL it hands out to the version of the render it just
 * produced, so a double that reported no generation would fail every fill here
 * for a reason that has nothing to do with the limits this file is about.
 */
let generationCounter = 1;
const generations = new Map<string, string>();

function fakeFile(objectPath: string) {
  return {
    save: async (body: Buffer | string) => {
      objects.set(objectPath, Buffer.from(body as never));
      generationCounter += 1;
      generations.set(objectPath, String(generationCounter));
    },
    getMetadata: async () => {
      const stored = objects.get(objectPath);
      if (!stored) throw Object.assign(new Error('No such object'), { code: 404 });
      return [{ size: String(stored.length), generation: generations.get(objectPath) ?? '1' }];
    },
    download: async () => {
      const stored = objects.get(objectPath);
      if (!stored) throw Object.assign(new Error('No such object'), { code: 404 });
      downloaded.push(objectPath);
      if (downloadHook) await downloadHook(objectPath);
      inFlight += 1;
      peakConcurrentDownloads = Math.max(peakConcurrentDownloads, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      inFlight -= 1;
      return [stored];
    },
    delete: async () => { objects.delete(objectPath); },
    getSignedUrl: async () => [`https://signed.test/${encodeURIComponent(objectPath)}`],
  };
}

let onePagePdf: Buffer;
let smallPng: Buffer;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  onePagePdf = Buffer.from(await doc.save());
  // A real 1x1 PNG, so pdf-lib can embed it rather than refusing filler.
  smallPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
});

beforeEach(async () => {
  objects = new Map();
  downloaded = [];
  peakConcurrentDownloads = 0;
  inFlight = 0;
  downloadHook = null;
  const { admin } = require('../../src/shared/database/firebase');
  jest.spyOn(admin, 'storage').mockReturnValue({ bucket: () => ({ file: fakeFile }) });

  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(() => { jest.restoreAllMocks(); });

/** An overlay template row pointing at a stored PDF, with optional images. */
async function overlayTemplate(options: {
  pdf?: Buffer;
  images?: Buffer[];
} = {}) {
  const templateId = randomUUID();
  const pdfPath = `lawfirmids/${firm.id}/templates/${templateId}/source.pdf`;
  objects.set(pdfPath, options.pdf ?? onePagePdf);

  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, overlay_pdf_object_path,
                            overlay_source_object_path)
     values ($1, $2, 'Court Form', 'overlay', $3, $3)`,
    [templateId, firm.id, pdfPath],
  );

  const imagePaths: string[] = [];
  (options.images || []).forEach((bytes, i) => {
    const imagePath = `lawfirmids/${firm.id}/templates/${templateId}/placement-images/image-${i}.png`;
    objects.set(imagePath, bytes);
    imagePaths.push(imagePath);
  });

  for (let i = 0; i < imagePaths.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- fixture setup, order is fine
    await testPool.query(
      `insert into template_field_placements
         (id, law_firm_id, template_id, field_name, field_type, page,
          x_percent, y_percent, width_percent, height_percent,
          image_object_path, image_mime_type, sort_order)
       values ($1, $2, $3, $4, 'image', 1, 10, 10, 20, 10, $5, 'image/png', $6)`,
      [randomUUID(), firm.id, templateId, `image-${i}`, imagePaths[i], i],
    );
  }

  return { templateId, pdfPath, imagePaths };
}

const fill = (templateId: string, actor: Actor = owner) => actor.api
  .post(`${T(firm.id)}/${templateId}/fill`)
  .send({ values: {}, format: 'pdf' });

describe('the template document', () => {
  it('fills a template that is within the limit', async () => {
    const { templateId } = await overlayTemplate();

    const res = await fill(templateId);

    expect(res.status).toBe(200);
  });

  it('REFUSES an oversized template without reading it', async () => {
    // The whole point. A refusal that downloads first has already paid the cost
    // it exists to avoid, and the status code looks identical either way.
    const huge = Buffer.alloc(26 * 1024 * 1024);
    onePagePdf.copy(huge);
    const { templateId, pdfPath } = await overlayTemplate({ pdf: huge });

    const res = await fill(templateId);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TEMPLATE_OBJECT_TOO_LARGE');
    expect(downloaded).not.toContain(pdfPath);
  });
});

describe('placement images', () => {
  it('fetches them ONE AT A TIME, not all at once', async () => {
    // In parallel the peak is the number of placements times the per-image cap.
    // That is the shape that turns a template with twenty images into a
    // container restart rather than an error.
    const { templateId } = await overlayTemplate({ images: [smallPng, smallPng, smallPng] });

    const res = await fill(templateId);

    expect(res.status).toBe(200);
    expect(peakConcurrentDownloads).toBe(1);
  });

  it('REFUSES one image over the per-image limit, without reading it', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    const { templateId, imagePaths } = await overlayTemplate({ images: [oversized] });

    const res = await fill(templateId);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TEMPLATE_OBJECT_TOO_LARGE');
    expect(downloaded).not.toContain(imagePaths[0]);
  });

  it('REFUSES images that are each under the limit but together over it', async () => {
    // The case a per-image cap alone misses entirely, and the one a template
    // with many placements actually hits.
    const nine = Buffer.alloc(9 * 1024 * 1024);
    const { templateId } = await overlayTemplate({ images: [nine, nine, nine] });

    const res = await fill(templateId);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TEMPLATE_IMAGES_TOO_LARGE');
    // It stopped rather than reading all three.
    expect(downloaded.length).toBeLessThan(4);
  });
});

describe('concurrent fills', () => {
  /** Poll until `condition` holds, failing loudly rather than hanging. */
  async function waitFor(condition: () => boolean, what: string) {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      // eslint-disable-next-line no-await-in-loop -- polling
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
  }

  const sourceReads = (paths: string[]) => downloaded.filter((p) => paths.includes(p));

  it('reads at most two template documents into memory at once, and the third waits its turn', async () => {
    // Every fill holds its whole document in memory. Unbounded, a burst of
    // fills is a burst of 25 MB documents inside one 512 MiB container.
    const templates = [await overlayTemplate(), await overlayTemplate(), await overlayTemplate()];
    const paths = templates.map((t) => t.pdfPath);
    const release = new Map<string, () => void>();
    downloadHook = (objectPath) => new Promise((resolve) => { release.set(objectPath, resolve); });
    // Three people: the slot bounds the instance, and one person may have only
    // two renders in flight at all (`withPersonRenderCap`), so a third from the
    // same person would be refused before it ever reached the slot.
    const people = [owner, await memberWith(firm.id, []), await memberWith(firm.id, [])];

    const responses = templates.map((t, i) => fill(t.templateId, people[i]).then((res) => res));

    await waitFor(() => sourceReads(paths).length === 2, 'two fills to start reading');
    // Long enough for an unbounded third fill to have reached its read.
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(sourceReads(paths)).toHaveLength(2);

    const [first] = sourceReads(paths);
    release.get(first)!();
    await waitFor(() => sourceReads(paths).length === 3, 'the third fill to start reading');

    for (const objectPath of sourceReads(paths)) release.get(objectPath)!();
    const done = await Promise.all(responses);
    expect(done.map((res) => res.status)).toEqual([200, 200, 200]);
  });

  it('gives the slot back when a fill fails', async () => {
    const failing = [await overlayTemplate(), await overlayTemplate()];
    const failingPaths = failing.map((t) => t.pdfPath);
    downloadHook = async (objectPath) => {
      if (failingPaths.includes(objectPath)) throw new Error('storage is unavailable');
    };

    const failed = await Promise.all(failing.map((t) => fill(t.templateId).then((res) => res)));
    expect(failed.every((res) => res.status >= 500)).toBe(true);

    // Two failures that kept their slots would leave these two queued behind nothing.
    const next = [await overlayTemplate(), await overlayTemplate()];
    const nextPaths = next.map((t) => t.pdfPath);
    const release = new Map<string, () => void>();
    downloadHook = (objectPath) => new Promise((resolve) => { release.set(objectPath, resolve); });

    const responses = next.map((t) => fill(t.templateId).then((res) => res));
    await waitFor(() => sourceReads(nextPaths).length === 2, 'both fills to start reading');

    for (const objectPath of nextPaths) release.get(objectPath)!();
    expect((await Promise.all(responses)).map((res) => res.status)).toEqual([200, 200]);
  });
});

describe('placement image paths', () => {
  it('does not read an image path outside the template\'s own upload folder', async () => {
    // A row stored before the save-time check existed, pointing at another
    // firm's object. The fill must not become a way to read it.
    const { templateId, imagePaths } = await overlayTemplate({ images: [smallPng] });
    const foreignPath = `lawfirmids/${randomUUID()}/templates/${randomUUID()}/placement-images/secret.png`;
    objects.set(foreignPath, smallPng);
    await testPool.query(
      `insert into template_field_placements
         (id, law_firm_id, template_id, field_name, field_type, page,
          x_percent, y_percent, width_percent, height_percent,
          image_object_path, image_mime_type, sort_order)
       values ($1, $2, $3, 'foreign', 'image', 1, 50, 50, 20, 10, $4, 'image/png', 9)`,
      [randomUUID(), firm.id, templateId, foreignPath],
    );

    const res = await fill(templateId);

    expect(res.status).toBe(200);
    // The template's own image was read, so the image pass ran.
    expect(downloaded).toContain(imagePaths[0]);
    expect(downloaded).not.toContain(foreignPath);
  });
});

describe('repeater rows', () => {
  /** An overlay template with one repeater column, `rowCount` rows per page. */
  async function repeaterTemplate(rowCount: number) {
    const { templateId, pdfPath } = await overlayTemplate();
    await testPool.query(
      `update templates set repeaters = $2::jsonb where id = $1`,
      [templateId, JSON.stringify([{
        name: 'exhibits', fields: ['label'], anchorPage: 1, anchorYPercent: 10, rowHeightPercent: 5, rowCount,
      }])],
    );
    await testPool.query(
      `insert into template_field_placements
         (id, law_firm_id, template_id, field_name, field_type, page,
          x_percent, y_percent, width_percent, height_percent, repeater_name, repeater_row_index, sort_order)
       values ($1, $2, $3, 'label', 'text', 1, 10, 10, 30, 4, 'exhibits', 0, 0)`,
      [randomUUID(), firm.id, templateId],
    );
    return { templateId, pdfPath };
  }

  const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ label: `Exhibit ${i + 1}` }));

  const fillWith = (templateId: string, body: Record<string, unknown>) => owner.api
    .post(`${T(firm.id)}/${templateId}/fill`)
    .send({ values: {}, format: 'pdf', ...body });

  it('tells the caller which fields had characters no font could print', async () => {
    const { templateId } = await repeaterTemplate(5);

    const res = await fillWith(templateId, { repeaterValues: { exhibits: [{ label: 'Łukasz' }, { label: '第二' }, { label: '第三' }] } });

    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toEqual(expect.any(String));
    // The Polish row falls back to a font that has it, so only the CJK rows
    // are reported, merged into one entry for the column.
    expect(res.body.incompleteFields).toEqual([{ fieldName: 'label', characters: ['第', '二', '三'] }]);
  });

  it('reports no incomplete fields for a fill every font can print', async () => {
    const { templateId } = await repeaterTemplate(5);

    const res = await fillWith(templateId, { repeaterValues: { exhibits: rows(3) } });

    expect(res.status).toBe(200);
    expect(res.body.incompleteFields).toEqual([]);
  });

  it('refuses more than five hundred rows for one repeater without reading the document', async () => {
    const { templateId, pdfPath } = await repeaterTemplate(5);

    const res = await fillWith(templateId, { repeaterValues: { exhibits: rows(501) } });

    expect(res.status).toBe(400);
    expect(downloaded).not.toContain(pdfPath);
  });

  it('refuses more than fifty repeaters without reading the document', async () => {
    const { templateId, pdfPath } = await repeaterTemplate(5);
    const repeaterValues = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`r${i}`, rows(1)]));

    const res = await fillWith(templateId, { repeaterValues });

    expect(res.status).toBe(400);
    expect(downloaded).not.toContain(pdfPath);
  });

  it('refuses more than a thousand field values without reading the document', async () => {
    const { templateId, pdfPath } = await overlayTemplate();
    const values = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}`, 'x']));

    const res = await fillWith(templateId, { values });

    expect(res.status).toBe(400);
    expect(downloaded).not.toContain(pdfPath);
  });

  it('fills five hundred rows that fit the continuation page limit', async () => {
    const { templateId } = await repeaterTemplate(5);

    const res = await fillWith(templateId, { repeaterValues: { exhibits: rows(500) } });

    expect(res.status).toBe(200);
  });

  it('refuses rows that would need more continuation pages than the limit, with a message the user can act on', async () => {
    // One row per page: 500 rows is 499 copies of the anchor page, every one
    // held in memory until the whole document is saved.
    const { templateId } = await repeaterTemplate(1);

    const res = await fillWith(templateId, { repeaterValues: { exhibits: rows(500) } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exhibits/);
    expect(res.body.error).toMatch(/pages/i);
  });
});
