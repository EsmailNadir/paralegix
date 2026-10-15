/**
 * Client portal reads and upload finalizes: how many pool connections one
 * request takes.
 *
 * Every request on an instance shares one small pool (12 connections against a
 * Supabase session pooler that allows 15). A read that issues one query per
 * document, all at once, takes as many connections as the matter has files, so
 * a single busy matter could starve every other user on the instance. These
 * pin the shape: the document listings cost the same number of checkouts
 * whatever the file count, a finalize looks its rows up in one query and
 * refuses a batch larger than init would open, and the dashboard holds at most
 * three connections at once.
 *
 * Checkouts are read from the app pool's own `acquire`/`release` events, so
 * they include the auth, permission and portal-gate middleware.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  drainEvents,
  resetCaches,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload } from '../support/inMemoryBucket';
import { PDF_HEAD } from '../support/directUpload';
import { rootOf, seedFolder, seedFile } from '../files/fileWorld';
import {
  portalPerson,
  portalPath,
  seedMatter,
  seedMatterInvoice,
  seedDocumentRequest,
  type PortalPerson,
} from './portalWorld';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

installInMemoryBucket();

/** Connections one upload finalize may hold at once, whatever its upload count. */
const MAX_FINALIZE_CONNECTIONS = 2;

let firm: Firm;
let owner: Actor;
let client: PortalPerson;
let matterId: string;
let rootId: string;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Pooled Connections LLP' });
  owner = await ownerOf(firm.id);
  client = await portalPerson(firm.id, 'Nadia Pool');
  matterId = await seedMatter(firm.id, 'Pool v. Budget', [client.clientId]);
  rootId = await rootOf(firm.id, { matterId });
});

/**
 * Checkouts and the peak held at once while `work` runs.
 *
 * Held connections are tracked by client object, not by a counter: a
 * connection checked out before the measurement (an earlier request's
 * background write) can be released during it, and a counter would go
 * negative and under-report the peak.
 */
async function measure(work: () => Promise<unknown>) {
  const held = new Set<unknown>();
  let peak = 0;
  let checkouts = 0;
  const onAcquire = (pgClient: unknown) => {
    checkouts += 1;
    held.add(pgClient);
    peak = Math.max(peak, held.size);
  };
  const onRelease = (_err: unknown, pgClient: unknown) => { held.delete(pgClient); };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result: any = await work();
    return { result, peak, checkouts };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

/**
 * The tree every listing case reads:
 *
 *   Pleadings/            shared, so everything under it is visible
 *     complaint.pdf
 *     Drafts/             not shared itself, inherits from Pleadings
 *       motion.pdf
 *   Evidence/             not shared, so not listed
 *     photo.pdf           shared directly
 *   internal.pdf          not shared, not listed
 */
async function seedTree() {
  const pleadings = await seedFolder(firm.id, { parentId: rootId, name: 'Pleadings', clientVisible: true, color: '#aa0000' });
  const drafts = await seedFolder(firm.id, { parentId: pleadings.id, name: 'Drafts', color: '#00aa00' });
  const evidence = await seedFolder(firm.id, { parentId: rootId, name: 'Evidence' });
  const complaint = await seedFile(firm.id, { parentId: pleadings.id, name: 'complaint.pdf' });
  const motion = await seedFile(firm.id, { parentId: drafts.id, name: 'motion.pdf' });
  const photo = await seedFile(firm.id, { parentId: evidence.id, name: 'photo.pdf', clientVisible: true });
  await seedFile(firm.id, { parentId: rootId, name: 'internal.pdf' });
  return { pleadings, drafts, evidence, complaint, motion, photo };
}

const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

describe('portal matter documents', () => {
  const list = () => client.api.get(portalPath(firm.id, `matters/${matterId}/documents`));

  it('states each document and folder path from the scope root', async () => {
    const t = await seedTree();

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(3);
    const docs = byId(res.body.documents);
    expect(docs[t.complaint.id]).toMatchObject({ name: 'Pleadings/complaint.pdf', fileName: 'complaint.pdf', parentId: t.pleadings.id });
    expect(docs[t.motion.id]).toMatchObject({ name: 'Pleadings/Drafts/motion.pdf', fileName: 'motion.pdf', parentId: t.drafts.id });
    expect(docs[t.photo.id]).toMatchObject({ name: 'Evidence/photo.pdf', fileName: 'photo.pdf', parentId: t.evidence.id });
    expect(res.body.folders).toEqual([
      { id: t.drafts.id, matterId, path: 'Pleadings/Drafts', color: '#00aa00' },
      { id: t.pleadings.id, matterId, path: 'Pleadings', color: '#aa0000' },
    ]);
  });

  it('costs the same number of connection checkouts for many files as for a few', async () => {
    const t = await seedTree();
    resetCaches();
    const few = await measure(list);
    expect(few.result.body.documents).toHaveLength(3);

    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sibling names are claimed one at a time
      await seedFile(firm.id, { parentId: t.drafts.id, name: `exhibit-${i}.pdf` });
    }
    resetCaches();
    const many = await measure(list);

    expect(many.result.status).toBe(200);
    expect(many.result.body.documents).toHaveLength(11);
    expect(many.checkouts).toBe(few.checkouts);
  });
});

describe('firm-side preview of what a client sees', () => {
  const preview = () => owner.api.get(`/api/lawfirms/${firm.id}/clients/${client.clientId}/portal-files`);

  it('states each path and the folder a document is shared through', async () => {
    const t = await seedTree();

    const res = await preview();

    expect(res.status).toBe(200);
    const docs = byId(res.body.documents);
    expect(Object.keys(docs)).toHaveLength(3);
    expect(docs[t.complaint.id]).toMatchObject({ name: 'Pleadings/complaint.pdf', directlyShared: false, viaFolderPath: 'Pleadings' });
    expect(docs[t.motion.id]).toMatchObject({ name: 'Pleadings/Drafts/motion.pdf', directlyShared: false, viaFolderPath: 'Pleadings' });
    expect(docs[t.photo.id]).toMatchObject({ name: 'Evidence/photo.pdf', directlyShared: true, viaFolderPath: null });
    expect(res.body.sharedFolders).toEqual([
      { id: t.pleadings.id, contextType: 'matter', entityId: matterId, matterId, relPath: 'Pleadings', name: 'Pleadings' },
    ]);
  });

  it('costs the same number of connection checkouts for many files as for a few', async () => {
    const t = await seedTree();
    resetCaches();
    const few = await measure(preview);
    expect(few.result.body.documents).toHaveLength(3);

    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sibling names are claimed one at a time
      await seedFile(firm.id, { parentId: t.drafts.id, name: `exhibit-${i}.pdf` });
    }
    resetCaches();
    const many = await measure(preview);

    expect(many.result.status).toBe(200);
    expect(many.result.body.documents).toHaveLength(11);
    expect(many.checkouts).toBe(few.checkouts);
  });
});

const declared = (name: string) => ({ fileName: name, contentType: 'application/pdf', size: 2048 });

function landAll(uploads: any[]) {
  for (const u of uploads) {
    landUpload(u.objectPath, { bytes: 2048, contentType: 'application/pdf', head: PDF_HEAD });
  }
}

/** Open `count` uploads at `base`, in batches no larger than init allows. */
async function openUploads(base: string, count: number, perBatch: number) {
  const uploads: any[] = [];
  for (let opened = 0; opened < count; opened += perBatch) {
    const n = Math.min(perBatch, count - opened);
    const files = Array.from({ length: n }, (_x, i) => declared(`doc-${opened + i}.pdf`));
    // eslint-disable-next-line no-await-in-loop -- each batch claims its own rows
    const res = await client.api.post(`${base}/upload-init`).send({ files });
    expect(res.status).toBe(200);
    uploads.push(...res.body.uploads);
  }
  landAll(uploads);
  return uploads;
}

const finalizedCount = async (ids: string[]) => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from files where id = any($1::uuid[]) and finalized_at is not null', [ids],
  );
  return rows[0].n;
};

describe('matter document finalize', () => {
  const base = () => portalPath(firm.id, `matters/${matterId}/documents`);

  it('refuses more uploads than one finalize may carry, and stamps none of them', async () => {
    // Past PORTAL_DOCUMENT_MAX_FINALIZE (50), not the per-init cap of ten: a
    // larger selection opens several inits and finalizes them together.
    const uploads = await openUploads(base(), 51, 10);

    const res = await client.api.post(`${base()}/upload-finalize`).send({ uploads });

    expect(res.status).toBe(400);
    expect(await finalizedCount(uploads.map((u) => u.fileId))).toBe(0);
  });

  it('finalizes a full batch, looking the rows up without a connection per upload', async () => {
    // Drained before each measurement: the upload notification's listeners run
    // after the response, and a connection they release mid-measurement would
    // otherwise count against the next request.
    const one = await openUploads(base(), 1, 10);
    await drainEvents();
    const single = await measure(() => client.api.post(`${base()}/upload-finalize`).send({ uploads: one }));
    expect(single.result.status).toBe(201);
    expect(single.result.body.documents).toHaveLength(1);

    const ten = await openUploads(base(), 10, 10);
    await drainEvents();
    const full = await measure(() => client.api.post(`${base()}/upload-finalize`).send({ uploads: ten }));

    expect(full.result.status).toBe(201);
    expect(full.result.body.documents).toHaveLength(10);
    expect(await finalizedCount(ten.map((u) => u.fileId))).toBe(10);
    // The same ceiling for one upload and for ten. Its request work is serial, and
    // the upload notification it emits can overlap its last query, hence two. A
    // lookup per upload run together held one connection per file.
    expect(single.peak).toBeGreaterThanOrEqual(1);
    expect(single.peak).toBeLessThanOrEqual(MAX_FINALIZE_CONNECTIONS);
    expect(full.peak).toBeLessThanOrEqual(MAX_FINALIZE_CONNECTIONS);
  });
});

describe('document request item finalize', () => {
  it('refuses more uploads than one finalize may carry', async () => {
    const request = await seedDocumentRequest(firm.id, client.clientId, matterId, {
      title: 'Bank statements', itemLabel: 'March', fileName: 'seed.pdf',
    });
    const base = portalPath(firm.id, `document-requests/${request.requestId}/items/${request.itemId}/fulfill`);
    const uploads = await openUploads(base, 51, 10);

    const res = await client.api.post(`${base}/upload-finalize`).send({ uploads });

    expect(res.status).toBe(400);
    expect(await finalizedCount(uploads.map((u) => u.fileId))).toBe(0);
  });
});

describe('message attachment finalize', () => {
  it('refuses more attachments than one init may open', async () => {
    const base = portalPath(firm.id, 'messages/attachments');
    const uploads = await openUploads(base, 6, 5);

    const res = await client.api.post(`${base}/upload-finalize`).send({ uploads });

    expect(res.status).toBe(400);
    expect(res.body.attachments).toBeUndefined();
  });
});

describe('portal dashboard', () => {
  it('holds at most three connections at once, and still loads matters and billing', async () => {
    await seedMatterInvoice(firm.id, matterId, client, { totalCents: 43_210, invoiceNumber: 'POOL-0001' });
    resetCaches();

    const { result, peak } = await measure(() => client.api.get(portalPath(firm.id, 'dashboard')));

    expect(result.status).toBe(200);
    expect(result.body.matters.map((m: any) => m.id)).toEqual([matterId]);
    expect(result.body.invoices).toHaveLength(1);
    expect(result.body.billingSummary.totalBilled).toBeGreaterThan(0);
    // Proves the listener sees the parallel reads, so the cap below is measured.
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
