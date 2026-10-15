/**
 * The JSON signing completion: what a signer may submit, how large it may be,
 * and which of the five outcomes the response reports.
 *
 * Completion used to be multipart carrying a browser-rewritten PDF. The JSON
 * variant carries consent plus the signer's own field values, and the server
 * builds the executed document. That moves three things into this route that
 * nothing previously bounded:
 *
 *   THE BODY. A signature field value is a base64 PNG inside the JSON, and
 *   `app.ts` parsed every JSON body at 50 MiB. On a 512 MiB container serving 80
 *   concurrent requests that is the whole budget several times over. The global
 *   default is now 2 MiB and this route declares 1 MiB. The refusal has to
 *   happen while the body is still being READ: a cap that parses first and then
 *   measures has already spent the memory it was meant to save. So the size
 *   cases below assert both the 413 and that the handler never ran, and they are
 *   paired with a body just UNDER the cap that reaches the handler and is
 *   refused for a different reason. Without that pair, "413" would also be
 *   produced by a parser that read all 50 MiB first.
 *
 *   THE IMAGES. Each signature/initials PNG is capped in bytes AND in declared
 *   pixels, and the sum across fields is capped too. The pixel case is a
 *   decompression bomb: seventy bytes declaring 900 million pixels. Its IHDR
 *   checksum is deliberately wrong, so if the pixel check did not run first the
 *   image would be rejected LATER, by the embed probe, with a different message.
 *   Asserting the pixel message is what proves nothing decoded it.
 *
 *   THE REVISION. A signer submits coordinates for the layout they were shown.
 *   If the sender edited the document or moved a field in between, applying
 *   those coordinates would stamp a signature onto a different page of a
 *   different document. The signer echoes the revision the view carried and a
 *   stale one is refused with nothing written.
 *
 * `consentAgreed` is asserted against `"false"`, `0` and `null` as well as
 * `false`, because the multipart schema transformed a STRING and a truthy check
 * would accept the string `"false"` as agreement to sign.
 *
 * SEEDING follows `signingRouting.test.ts`: SQL, because the harness's GCS mock
 * is inert and a fixture routed through the real upload would be testing the
 * mock. Sessions here are FIELD-DRIVEN (a `signature_fields` row per field),
 * because the JSON path has no uploaded document to fall back on: the executed
 * PDF is rebuilt from the stored original plus the submitted values.
 *
 * THE FAKE BUCKET stores real bytes for the same reason that file gives: the
 * finalize path parses what it reads. It also injects a failure into the source
 * download, which is how the recoverable and permanent outcomes are reached
 * without a stubbed route.
 */
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  seedSigningSession, storeSigningSource, makePdf, TINY_PNG,
} from '../support/signing';

const crypto = require('crypto');
const { admin } = require('../../src/shared/database/firebase');
const repo = require('../../src/modules/signatures/signatures.repository');
const { SourceRefused } = require('../../src/modules/signatures/signingSources');
const {
  SIGNING_IMAGE_MAX_BYTES,
  SIGNING_IMAGE_TOTAL_MAX_BYTES,
  SIGNING_IMAGE_MAX_PIXELS,
} = require('../../src/modules/signatures/signingFieldValues');
const {
  SIGNING_COMPLETION_BODY_LIMIT_BYTES,
} = require('../../src/modules/signatures/signing.validation');
const {
  objects: storedObjects,
  inMemoryBucket,
  fakeFile: bucketFile,
} = require('../support/inMemoryBucket');

/**
 * The shared in-memory bucket, not a local stub.
 *
 * A field-bearing completion now goes through the appending pipeline: it pins
 * generations, reads byte ranges and asks storage to JOIN objects server side.
 * A double that answered only `download()` and reported no generation would
 * fail every one of those, so the finalize half of this file would be asserting
 * against a broken stub rather than against the route.
 *
 * `storageFailure` replaces the old one-shot download fault and serves the same
 * two cases: it is what drives the recoverable and permanent outcomes below
 * without stubbing the route itself.
 */
/** When set, the next storage read throws this instead of answering. */
let storageFailure: Error | null = null;

function takeFailure(): Error | null {
  if (!storageFailure) return null;
  const err = storageFailure;
  storageFailure = null;
  return err;
}

const failingBucket = {
  ...inMemoryBucket,
  file: (objectPath: string, options?: any) => {
    const handle = bucketFile(objectPath, options) as any;
    return {
      ...handle,
      getMetadata: async () => {
        const err = takeFailure();
        if (err) throw err;
        return handle.getMetadata();
      },
      download: async (range?: any) => {
        const err = takeFailure();
        if (err) throw err;
        return handle.download(range);
      },
    };
  },
};

admin.storage = () => ({ bucket: () => failingBucket });

// ── PNG fixtures ───────────────────────────────────────────────────────────

/**
 * A PNG of a given byte size. pdf-lib ignores trailing bytes after IEND, so the
 * result still embeds: byte size is the ONLY thing wrong with it, which is what
 * the byte cap has to be measured against.
 */
function pngOfBytes(totalBytes: number): Buffer {
  return Buffer.concat([TINY_PNG, Buffer.alloc(Math.max(0, totalBytes - TINY_PNG.length))]);
}

/**
 * Seventy bytes claiming 30000x30000. The IHDR checksum is now wrong, so a
 * decoder would reject it; the point is that nothing gets far enough to try.
 */
function decompressionBombPng(): Buffer {
  const bomb = Buffer.from(TINY_PNG);
  bomb.writeUInt32BE(30000, 16);
  bomb.writeUInt32BE(30000, 20);
  return bomb;
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

// ── seeding ────────────────────────────────────────────────────────────────

let firm: Firm;
let owner: Actor;
let onePagePdf: Buffer;

type SeedField = {
  fieldType?: 'signature' | 'initials' | 'text' | 'date' | 'checkbox';
  signerIndex?: number;
  required?: boolean;
};

type SeedParticipant = {
  name: string;
  status?: 'active' | 'waiting' | 'completed';
  fields?: SeedField[];
};

async function seedSession(options: {
  routingMode?: 'sequential' | 'parallel';
  currentSignerOrder?: number | null;
  participants: SeedParticipant[];
}) {
  // The session's source has to describe the document this spec stored:
  // finalization opens the prepared object pinned to the generation the row
  // records.
  const objectPath = await storeSigningSource(firm.id, onePagePdf);
  const { sessionToken, participants } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: options.routingMode ?? 'sequential',
      object_path: objectPath,
      current_signer_order: options.currentSignerOrder === undefined ? 1 : options.currentSignerOrder,
      notify_email: 'sender@example.test',
      document_hash: 'originalhash',
    },
    participants: options.participants.map((input) => ({
      name: input.name,
      status: input.status ?? 'waiting',
      fields: (input.fields ?? []).map((field, fieldIndex) => ({
        fieldType: field.fieldType ?? 'signature',
        required: field.required ?? true,
        xPercent: 10 + fieldIndex * 5,
        yPercent: 20,
        widthPercent: 30,
        heightPercent: 10,
      })),
    })),
  });

  return { sessionToken, objectPath, participants };
}

/** One signature field owned by one active signer: the smallest usable session. */
async function seedSoloSignatureSession(fieldCount = 1) {
  const seeded = await seedSession({
    participants: [{
      name: 'Ada First',
      status: 'active',
      fields: Array.from({ length: fieldCount }, () => ({ fieldType: 'signature' as const })),
    }],
  });
  return { ...seeded, signer: seeded.participants[0] };
}

/** What the signing page reads before it renders anything. */
async function loadView(publicToken: string) {
  const res = await request().get(`/api/signing/${publicToken}`);
  expect(res.status).toBe(200);
  return res.body;
}

type CompletionBody = Record<string, unknown>;

const submitJson = (publicToken: string, body: CompletionBody) =>
  request()
    .post(`/api/signing/${publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(body as never);

/** A well-formed JSON completion for one signature field. */
async function goodBody(
  publicToken: string,
  fieldIds: string[],
  overrides: CompletionBody = {},
): Promise<CompletionBody> {
  const view = await loadView(publicToken);
  return {
    consentAgreed: true,
    consentName: 'Ada First',
    consentTimestamp: new Date().toISOString(),
    sourceRevision: view.sourceRevision,
    idempotencyKey: crypto.randomUUID(),
    fieldValues: fieldIds.map((fieldId) => ({ fieldId, value: dataUrl(TINY_PNG) })),
    ...overrides,
  };
}

// ── reading back what the route decided ────────────────────────────────────

const participantRow = async (participantId: string) => {
  const { rows } = await testPool.query(
    `select status, consent, field_values, signer_name
       from signature_participants where id = $1`,
    [participantId],
  );
  return rows[0];
};

const sessionRow = async (sessionToken: string) => {
  const { rows } = await testPool.query(
    `select status, signed_object_path, signed_document_hash
       from signature_sessions where token = $1`,
    [sessionToken],
  );
  return rows[0];
};

beforeAll(async () => {
  onePagePdf = await makePdf(1);
});

beforeEach(async () => {
  storedObjects.clear();
  storageFailure = null;
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

/**
 * The one spy this file installs, removed even when the assertion after it
 * throws. Deliberately NOT `jest.restoreAllMocks()`: the shared harness installs
 * spies of its own during setup, and restoring those leaves later cases in this
 * file running against real Firebase and a half-wired app.
 */
let sessionLookupSpy: jest.SpyInstance | null = null;

function spyOnSessionLookup() {
  sessionLookupSpy = jest.spyOn(repo, 'getSessionByParticipantToken');
  return sessionLookupSpy;
}

afterEach(() => {
  sessionLookupSpy?.mockRestore();
  sessionLookupSpy = null;
});

describe('the signer view carries the revision it was rendered from', () => {
  it('returns a source revision to the active signer', async () => {
    const { signer } = await seedSoloSignatureSession();

    const view = await loadView(signer.publicToken);

    // Without this the client has nothing to echo back and the staleness check
    // below could never fire for a real signer.
    expect(typeof view.sourceRevision).toBe('string');
    expect(view.sourceRevision.length).toBeGreaterThan(0);
  });

  it('changes the revision when the sender moves a field', async () => {
    const { signer } = await seedSoloSignatureSession();
    const before = (await loadView(signer.publicToken)).sourceRevision;

    await testPool.query(
      'update signature_fields set y_percent = 80 where id = $1', [signer.fieldIds[0]],
    );

    expect((await loadView(signer.publicToken)).sourceRevision).not.toBe(before);
  });

  it('changes the revision when the sender replaces the document', async () => {
    const { sessionToken, signer } = await seedSoloSignatureSession();
    const before = (await loadView(signer.publicToken)).sourceRevision;

    await testPool.query(
      `update signature_sessions set object_path = 'signing-uploads/replaced.pdf'
        where token = $1`,
      [sessionToken],
    );

    expect((await loadView(signer.publicToken)).sourceRevision).not.toBe(before);
  });
});

describe('a stale revision is refused rather than applied', () => {
  it('refuses a completion submitted against a moved field, leaving the signer uncommitted', async () => {
    const { sessionToken, signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);

    // The sender edits the layout while the signer has the page open.
    await testPool.query(
      'update signature_fields set y_percent = 80 where id = $1', [signer.fieldIds[0]],
    );

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOURCE_REVISION_STALE');
    // The whole point of the refusal: the signer's consent and coordinates must
    // not be attached to the document the sender now has.
    const row = await participantRow(signer.participantId);
    expect(row.status).toBe('active');
    expect(row.consent).toBeNull();
    expect(row.field_values).toBeNull();
    expect((await sessionRow(sessionToken)).status).toBe('pending');
  });

  it('accepts the same completion when the layout has not moved', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);

    const res = await submitJson(signer.publicToken, body);

    // The control for the case above: the refusal is about the edit, not about
    // the revision check rejecting every submission. It is also the JSON path
    // succeeding with no uploaded document, which is what restoring a mandatory
    // `req.file` would break, and the boolean `true` the consent cases below
    // refuse every look-alike of.
    expect(res.status).toBe(200);
    expect((await participantRow(signer.participantId)).status).toBe('completed');
  });
});

describe('consentAgreed must be an actual boolean true', () => {
  const refusedValues: Array<[string, unknown]> = [
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['the number 0', 0],
    ['null', null],
    ['boolean false', false],
  ];

  it.each(refusedValues)('refuses %s', async (_label, value) => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds, { consentAgreed: value });

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(400);
    // A truthy check would have accepted the string "false" and signed the
    // document for someone who declined.
    expect((await participantRow(signer.participantId)).status).toBe('active');
  });
});

describe('the signer name is bounded', () => {
  it('refuses a name past the limit', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds, {
      consentName: 'A'.repeat(201),
    });

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(400);
    expect((await participantRow(signer.participantId)).status).toBe('active');
  });

  it('records the name it accepted', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds, { consentName: 'Ada Lovelace' });

    await submitJson(signer.publicToken, body);

    expect((await participantRow(signer.participantId)).signer_name).toBe('Ada Lovelace');
  });
});

describe('a signer may only submit values for their own fields', () => {
  it('refuses a value aimed at another signer field', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active', fields: [{ fieldType: 'signature' }] },
        { name: 'Bo Second', status: 'waiting', fields: [{ fieldType: 'signature' }] },
      ],
    });
    const [ada, bo] = participants;
    const body = await goodBody(ada.publicToken, [...ada.fieldIds, ...bo.fieldIds]);

    const res = await submitJson(ada.publicToken, body);

    expect(res.status).toBe(400);
    expect((await participantRow(bo.participantId)).field_values).toBeNull();
  });
});

describe('signature images are bounded in bytes, in pixels and in total', () => {
  it('refuses one image past the per-image byte cap', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds, {
      fieldValues: [{ fieldId: signer.fieldIds[0], value: dataUrl(pngOfBytes(SIGNING_IMAGE_MAX_BYTES + 1024)) }],
    });

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SIGNATURE_IMAGE_TOO_LARGE');
    expect((await participantRow(signer.participantId)).status).toBe('active');
  });

  it('accepts an image just under the per-image byte cap', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds, {
      fieldValues: [{ fieldId: signer.fieldIds[0], value: dataUrl(pngOfBytes(SIGNING_IMAGE_MAX_BYTES - 1024)) }],
    });

    // The boundary, not just "big is refused": one KiB the other side of the
    // same cap has to go through.
    expect((await submitJson(signer.publicToken, body)).status).toBe(200);
  });

  it('refuses a decompression bomb on its declared pixels, not its size', async () => {
    const { signer } = await seedSoloSignatureSession();
    const bomb = decompressionBombPng();
    expect(bomb.length).toBeLessThan(SIGNING_IMAGE_MAX_BYTES);

    const res = await submitJson(signer.publicToken, await goodBody(
      signer.publicToken, signer.fieldIds,
      { fieldValues: [{ fieldId: signer.fieldIds[0], value: dataUrl(bomb) }] },
    ));

    expect(res.status).toBe(400);
    // Its IHDR checksum is broken, so an implementation that decoded first would
    // reject it as corrupt instead. This code says the dimensions were read and
    // refused before anything allocated 900 million pixels.
    expect(res.body.code).toBe('SIGNATURE_IMAGE_TOO_MANY_PIXELS');
  });

  it('states the pixel ceiling it enforced', async () => {
    // Pinned so the cap cannot be quietly raised to whatever a bomb declares.
    expect(SIGNING_IMAGE_MAX_PIXELS).toBe(4_000_000);
  });

  it('refuses a total past the cap when every image is individually under it', async () => {
    const perImage = Math.floor(SIGNING_IMAGE_MAX_BYTES * 0.6);
    const count = Math.ceil(SIGNING_IMAGE_TOTAL_MAX_BYTES / perImage) + 1;
    const { signer } = await seedSoloSignatureSession(count);
    const image = dataUrl(pngOfBytes(perImage));

    const res = await submitJson(signer.publicToken, await goodBody(
      signer.publicToken, signer.fieldIds,
      { fieldValues: signer.fieldIds.map((fieldId) => ({ fieldId, value: image })) },
    ));

    expect(perImage).toBeLessThan(SIGNING_IMAGE_MAX_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SIGNATURE_IMAGES_TOO_LARGE');
    expect((await participantRow(signer.participantId)).status).toBe('active');
  });

  it('accepts the same number of images under the total cap', async () => {
    const perImage = Math.floor(SIGNING_IMAGE_MAX_BYTES * 0.6);
    const count = Math.ceil(SIGNING_IMAGE_TOTAL_MAX_BYTES / perImage) + 1;
    const { signer } = await seedSoloSignatureSession(count);
    const image = dataUrl(pngOfBytes(Math.floor(SIGNING_IMAGE_TOTAL_MAX_BYTES / count) - 512));

    const res = await submitJson(signer.publicToken, await goodBody(
      signer.publicToken, signer.fieldIds,
      { fieldValues: signer.fieldIds.map((fieldId) => ({ fieldId, value: image })) },
    ));

    // The control: the total cap is about the sum, not about the field count.
    expect(res.status).toBe(200);
  });
});

describe('an oversized body is refused before it is parsed', () => {
  /**
   * A completion body whose JSON serialization is exactly `targetBytes` long,
   * padded inside the signature value so nothing else about it is malformed.
   */
  async function bodyOfBytes(
    publicToken: string, fieldIds: string[], targetBytes: number,
  ): Promise<CompletionBody> {
    // Padded as real PNG bytes rather than as characters appended to the base64:
    // a base64 decoder stops at the `=` padding, so trailing characters would
    // enlarge the body without enlarging anything the image caps can see, and
    // the "just under" case would then sail through to a completed signature.
    //
    // The padding is also spread across the fields rather than heaped onto one,
    // so no single value trips the schema's per-value character cap. That cap
    // sits BEFORE the session lookup, and a body stopped there would look
    // exactly like a body the parser refused.
    const withImages = (sizes: number[]) => ({
      fieldValues: fieldIds.map((fieldId, index) => ({
        fieldId, value: dataUrl(pngOfBytes(sizes[index])),
      })),
    });
    const startSize = 1024;
    const base = await goodBody(publicToken, fieldIds, withImages(fieldIds.map(() => startSize)));
    const deficit = targetBytes - JSON.stringify(base).length;
    expect(deficit).toBeGreaterThan(0);
    // Base64 grows by exactly four characters per three bytes, so the padding is
    // added as whole three-byte groups and lands within a handful of bytes of
    // the target, which is far finer than the kilobyte margins used below.
    const groups = Math.floor(deficit / 4 / fieldIds.length);
    return { ...base, ...withImages(fieldIds.map(() => startSize + groups * 3)) };
  }

  /** Four fields, so a megabyte of padding splits into four legal-length values. */
  const seedPaddableSession = () => seedSoloSignatureSession(4);

  it('answers 413 for a body one kilobyte over the route cap, before the handler runs', async () => {
    const { signer } = await seedPaddableSession();
    const body = await bodyOfBytes(
      signer.publicToken, signer.fieldIds, SIGNING_COMPLETION_BODY_LIMIT_BYTES + 1024,
    );
    // The route's first act is to resolve the session from the token. If this
    // runs, the body was read and parsed before anything measured it, which is
    // the defect the cap exists to prevent - and a status-only assertion would
    // pass anyway.
    const resolveSpy = spyOnSessionLookup();

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(resolveSpy).not.toHaveBeenCalled();
    expect((await participantRow(signer.participantId)).status).toBe('active');
  });

  it('does reach the handler for a body just under the cap', async () => {
    const { signer } = await seedPaddableSession();
    const body = await bodyOfBytes(
      signer.publicToken, signer.fieldIds, SIGNING_COMPLETION_BODY_LIMIT_BYTES - 2048,
    );
    const resolveSpy = spyOnSessionLookup();

    const res = await submitJson(signer.publicToken, body);

    // Two kilobytes the other side of the same cap. The handler runs, and the
    // padded image is refused by the per-image byte cap instead. Without this
    // pair, the 413 above would also be produced by a parser that read the whole
    // body first and measured afterwards.
    expect(resolveSpy).toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SIGNATURE_IMAGE_TOO_LARGE');
  });

  it('caps the route below the global default', async () => {
    // The route cap is only meaningful as an OVERRIDE. If it drifted up to the
    // global value there would be nothing route-specific left.
    const { JSON_BODY_LIMIT_BYTES } = require('../../src/app');
    expect(SIGNING_COMPLETION_BODY_LIMIT_BYTES).toBeLessThan(JSON_BODY_LIMIT_BYTES);
    expect(JSON_BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('the five outcomes are distinguishable in the body', () => {
  it('reports accepted-but-waiting for an intermediate signer', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active', fields: [{ fieldType: 'signature' }] },
        { name: 'Bo Second', status: 'waiting', fields: [{ fieldType: 'signature' }] },
      ],
    });
    const [ada] = participants;

    const res = await submitJson(ada.publicToken, await goodBody(ada.publicToken, ada.fieldIds));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'waiting_for_others',
      consentRecorded: true,
      completed: false,
      nextSignerName: 'Bo Second',
    });
  });

  it('reports completed for the last signer', async () => {
    const { sessionToken, signer } = await seedSoloSignatureSession();

    const res = await submitJson(signer.publicToken, await goodBody(signer.publicToken, signer.fieldIds));

    expect(res.body).toMatchObject({
      state: 'completed',
      consentRecorded: true,
      completed: true,
    });
    // The state name is only true if the artifact actually landed.
    expect((await sessionRow(sessionToken)).signed_object_path).toBeTruthy();
  });

  it('reports a recoverable failure when the artifact build fails', async () => {
    const { sessionToken, signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);
    storageFailure = new Error('bucket unavailable');

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      state: 'recoverable_failure',
      consentRecorded: true,
      retryable: true,
    });
    // Consent was committed before the build ran, so the recovery pass has
    // everything it needs to finish the document without the signer returning.
    expect((await participantRow(signer.participantId)).status).toBe('completed');
    expect((await sessionRow(sessionToken)).status).toBe('in_progress');
  });

  it('reports a permanent refusal when the source itself is refused', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);
    storageFailure = new SourceRefused('PDF_ENCRYPTED');

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      state: 'permanent_refusal',
      consentRecorded: true,
      retryable: false,
      code: 'PDF_ENCRYPTED',
    });
  });

  it('reports processing while the artifacts are still being built', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);
    storageFailure = new Error('bucket unavailable');
    expect((await submitJson(signer.publicToken, body)).status).toBe(503);

    // The signer's page polls by re-submitting the same key. Every participant
    // has consented, the session has not been sealed yet, and that is neither a
    // failure nor a completion.
    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      state: 'processing',
      consentRecorded: true,
    });
  });
});

describe('the idempotency key separates a retry from a second signature', () => {
  it('returns the completed outcome again for the same key', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);
    expect((await submitJson(signer.publicToken, body)).status).toBe(200);

    const res = await submitJson(signer.publicToken, body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'completed', completed: true });
  });

  it('refuses a different key once the signer has completed', async () => {
    const { signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);
    await submitJson(signer.publicToken, body);

    // Built from the accepted submission rather than reloaded, because the view
    // no longer serves a revision once the turn is over. Only the key differs.
    const res = await submitJson(
      signer.publicToken, { ...body, idempotencyKey: crypto.randomUUID() },
    );

    // Not a retry: a second, different submission against a turn that is over.
    expect(res.status).toBe(409);
  });

  it('does not seal the document twice on a retry', async () => {
    const { sessionToken, signer } = await seedSoloSignatureSession();
    const body = await goodBody(signer.publicToken, signer.fieldIds);
    await submitJson(signer.publicToken, body);
    const first = await sessionRow(sessionToken);

    await submitJson(signer.publicToken, body);

    // A retry that re-ran the finalize would file a second executed copy and
    // charge the firm's storage twice for one document.
    expect((await sessionRow(sessionToken)).signed_object_path).toBe(first.signed_object_path);
    expect((await sessionRow(sessionToken)).signed_document_hash).toBe(first.signed_document_hash);
  });
});

describe('the multipart completion is gone', () => {
  it('refuses a multipart submission outright', async () => {
    const { sessionToken, signer } = await seedSoloSignatureSession();

    const res = await request()
      .post(`/api/signing/${signer.publicToken}/complete`)
      .field('consentAgreed', 'true')
      .field('consentName', 'Ada First')
      .field('consentTimestamp', new Date().toISOString())
      .attach('file', onePagePdf, 'agreement.pdf');

    // Multipart was the last thing that held a whole document in this process.
    // The transport is refused before the body is read, and the session is left
    // exactly as it was rather than half-executed from bytes nothing checked.
    expect(res.status).toBe(415);
    expect((await sessionRow(sessionToken)).status).toBe('pending');
    expect((await participantRow(signer.participantId)).status).toBe('active');
  });
});
